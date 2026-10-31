// src/lib/server/tenant/provisioner/council-verify.ts - Karenz phase 1: the
// executor-side verification of a COUNCIL request (plt.provisioning_request
// origin 'council'), as its own module so it is directly testable.
//
// A council request is a council admin's switch of a feature module. Like a
// panel request it carries the person's signed loa2 token pair, but the pair
// comes from the COUNCIL's own realm and the gremion-ui client, and the actor
// is a person (their Keycloak user id in that realm), not an operator of the
// ops realm. The checks, in this order and each fail-closed:
//   1. the kind and the args (verifyRequestArgs with origin 'council': only
//      enable_module; disable_module is DISABLE_NOT_YET until phase 2; every
//      other kind is "not allowed for a council request"). No token is read
//      before this passes.
//   2. the module must be council-switchable (MODULE_NOT_SWITCHABLE).
//   3. the customer's realm and host, from the registry (null: "no such
//      customer"). The evidence is verified against THAT realm only, so a pair
//      signed by realm A can never carry a request for the customer of realm B.
//   4. the signed evidence (the SAME code path as the panel's, with the realm's
//      issuer and JWKS, client gremion-ui and the council role).
//   5. the admin, re-read in that realm NOW (exists, enabled, holds the role),
//      through the provisioner's master-realm transport.
//
// Read-only: it writes nothing; the executor marks the request verified.
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose'
import { verifyRequestArgs, type VerifiedRequestArgs } from '@gremion/provisioning'
import { HELD_BACK_CATALOGUE_IDS, SWITCHABLE_CATALOGUE_IDS } from '$lib/modules/catalogue-map'
import { realmSeg, type KcTransport } from './kc-admin-api'
import { issuerForTenant } from './realm-doc'
import { verifyRequestEvidence } from './request-verify'

/** The client a council admin signs in with (the gremion-ui OIDC client of every council realm). */
export const COUNCIL_CLIENT = 'gremion-ui'

/**
 * The realm roles that may switch a module. council-admin is the right; it-admin
 * includes it through the page-role hierarchy (auth/index.ts ROLE_HIERARCHY), and
 * Keycloak does not make it-admin a composite of council-admin, so both names are
 * accepted here exactly as gremion-ui accepts them. Vorstand is not in the list.
 */
export const COUNCIL_SWITCH_ROLES: readonly string[] = ['council-admin', 'it-admin']

/** The columns of plt.provisioning_request this branch reads. */
export interface CouncilRequestRow {
  kind: string
  customer_slug: string
  args: unknown
  /** the person's Keycloak user id in the customer's realm (actor_kind person) */
  operator_id: string
  evidence_auth_time: Date | null
  evidence_token: string | null
  evidence_verified_at: Date | null
  created_at: Date
}

/** What the request verbs context offers this branch (RequestVerbContext satisfies it). */
export interface CouncilVerifyContext {
  kcInternalBase(): string
  /** The least-privilege provisioner's master-realm transport (it reads users of tenant realms). */
  provisionerTransport(): KcTransport
  /** The customer's Keycloak realm and public host from the registry, or null when there is no such customer. */
  customerRealmForSlug(slug: string): Promise<{ realm: string; host: string } | null>
}

export interface CouncilVerifyDeps {
  /** Every module id of the catalogue (modules/<id>/module.json). */
  catalogueIds: readonly string[]
  /** modules/disabled.json ids. */
  disabledIds: readonly string[]
  /** Tests only: overrides COUNCIL_DISABLE_ALLOWED. */
  councilDisableAllowed?: boolean
  /** Tests only: the evidence function (a spy proves no token is read for a refused kind). */
  verifyEvidence?: typeof verifyRequestEvidence
  /** Tests only: the JWKS of a realm (default: the realm's certs endpoint on Keycloak's internal base). */
  jwksFor?: (certsUrl: URL) => JWTVerifyGetKey
}

export type CouncilVerdict =
  | { verdict: 'ok'; kind: string; slug: string; origin: 'council'; operatorId: string; evidence: string; args: VerifiedRequestArgs }
  | { verdict: 'refused'; reason: string }

/** The admin, re-read in the customer's realm: exists, enabled, holds a council switching role. */
export async function councilAdminStanding(kc: KcTransport, realm: string, personId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const base = `/admin/realms/${realmSeg(realm)}/users/${encodeURIComponent(personId)}`
  let user: { enabled?: boolean } | undefined
  try {
    user = (await kc('GET', base)) as { enabled?: boolean } | undefined
  } catch (err) {
    if (/\b404\b/.test(err instanceof Error ? err.message : String(err))) return { ok: false, reason: `council admin ${personId} does not exist in realm ${realm}` }
    throw err
  }
  if (user?.enabled !== true) return { ok: false, reason: `council admin ${personId} is disabled in realm ${realm}` }
  const roles = ((await kc('GET', `${base}/role-mappings/realm/composite`)) as Array<{ name?: string }> | undefined) ?? []
  if (!roles.some((r) => typeof r.name === 'string' && COUNCIL_SWITCH_ROLES.includes(r.name))) {
    return { ok: false, reason: `council admin ${personId} no longer holds council-admin in realm ${realm}` }
  }
  return { ok: true }
}

/** The verdict on one claimed council request (see the header for the order of the checks). */
export async function verifyCouncilRequest(row: CouncilRequestRow, ctx: CouncilVerifyContext, deps: CouncilVerifyDeps): Promise<CouncilVerdict> {
  // 1. the kind and its args; nothing below runs for a refused kind
  const args = verifyRequestArgs(
    { kind: row.kind, customerSlug: row.customer_slug, args: row.args, operatorId: row.operator_id, origin: 'council' },
    { catalogueIds: deps.catalogueIds, disabledIds: deps.disabledIds, ...(deps.councilDisableAllowed === undefined ? {} : { councilDisableAllowed: deps.councilDisableAllowed }) },
  )
  if (args.verdict === 'refused') return args
  // 2. only a council-switchable module
  const moduleId = 'module' in args.args ? args.args.module : undefined
  if (typeof moduleId !== 'string' || !SWITCHABLE_CATALOGUE_IDS.has(moduleId)) {
    const why = HELD_BACK_CATALOGUE_IDS[moduleId ?? ''] ?? 'it is not in the council-switchable set'
    return { verdict: 'refused', reason: `MODULE_NOT_SWITCHABLE: module ${String(moduleId)} cannot be switched by a council (${why})` }
  }
  // 3. the customer's own realm
  const customer = await ctx.customerRealmForSlug(row.customer_slug)
  if (!customer) return { verdict: 'refused', reason: `no such customer ${row.customer_slug}` }
  // 4. the evidence, against THAT realm
  let evidence: string
  if (row.evidence_verified_at !== null) {
    // a re-claimed request (executor restart): verified on its first claim, token since cleared
    evidence = `verified at ${row.evidence_verified_at.toISOString()} on an earlier claim`
  } else {
    if (!row.evidence_token || !row.evidence_auth_time) return { verdict: 'refused', reason: 'a council request without its signed evidence' }
    const certs = new URL(`${ctx.kcInternalBase()}/realms/${realmSeg(customer.realm)}/protocol/openid-connect/certs`)
    const e = await (deps.verifyEvidence ?? verifyRequestEvidence)({
      evidence: row.evidence_token,
      jwks: deps.jwksFor ? deps.jwksFor(certs) : createRemoteJWKSet(certs),
      issuer: issuerForTenant(customer.host, customer.realm),
      clientId: COUNCIL_CLIENT,
      requiredRole: COUNCIL_SWITCH_ROLES,
      operatorId: row.operator_id,
      createdAt: row.created_at,
      recordedAuthTime: row.evidence_auth_time,
    })
    if (!e.ok) return { verdict: 'refused', reason: `evidence: ${e.reason}` }
    evidence = `signed loa2 sign-in of ${e.sub} (${e.timeClaim} ${new Date(e.authTime * 1000).toISOString()})`
  }
  // 5. the admin, as the customer's realm knows them NOW (narrows a demoted or disabled admin's window)
  const standing = await councilAdminStanding(ctx.provisionerTransport(), customer.realm, row.operator_id)
  if (!standing.ok) return { verdict: 'refused', reason: standing.reason }
  return { verdict: 'ok', kind: row.kind, slug: row.customer_slug, origin: 'council', operatorId: row.operator_id, evidence, args: args.args }
}
