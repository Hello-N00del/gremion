// src/lib/server/tenant/provisioner/reconcile.ts
// P2.1c (T11) — the R5 drift guard. `reconcile [--verify-only] <slug>|--all`
// asserts (verify) and repairs (apply) the §4 realm contract on EVERY realm
// (incl. `default`/live `sturaos`), so realm-template drift gets a mechanical
// answer from day one. The same module backs S5's P2.3 acceptance and the
// #254/#240 live replay at S4.
//
// PURE over an INJECTED KcTransport (the same transport KcProvisionApi takes), so
// the whole verify+apply flow is unit-testable with a scripted fake KC. The CLI
// (scripts/tenant-provision.ts) supplies the live token-authenticated transport.
//
// Verify reads the live realm via Admin-API GETs and produces one NAMED check per
// §4 contract element (machine-readable JSON + a human table the CLI prints). It
// issues NO mutating calls. Apply replays ONLY the failed checks via the §4-2
// idempotent sequence (KcProvisionApi.configureStepupFlow — flow-exists guard,
// partial realm PUT merging attributes, ORDER: flow before browserFlow), a
// localized sslRequired partial PUT, and the idempotent gremion-admin SA
// realm-management grant (A — assignServiceAccountRealmRoles). Drifts the §4-2
// sequence cannot mechanically repair (per-tenant exact URIs, fixture users,
// fullScopeAllowed, the sub-mapper) are REPORTED but never auto-repaired — a
// re-import is the operator's answer.
import { KcProvisionApi, realmSeg, type KcTransport } from './kc-admin-api'
import { ADMIN_CLIENT_ID, GREMION_ADMIN_SA_REALM_ROLES } from './pipeline'
import type { TenantStatus } from '../registry'

/** The exact, ordered set of named checks reconcile runs (the §4 contract). */
export const RECONCILE_CHECK_NAMES = [
  'ssl-required', // §4-3  sslRequired == all (#139/G-080)
  'browser-flow', // §4-1  realm.browserFlow == browser-stepup
  'otp-policy', // §4-1  totp / HmacSHA1 / 6 digits / 30s period
  'acr-loa-map', // §4-1  realm attribute acr.loa.map == {"loa1":1,"loa2":2}
  'stepup-flow', // §4-1  browser-stepup flow + stepup-1fa/2fa subflows exist
  'stepup-loa-config', // §4-1  Condition-LoA configs (loa1/36000, loa2/300)
  'gremion-ui-client', // §4-1  the gremion-ui client exists
  'gremion-ui-acr-mapper', // §4-1  acr protocol-mapper on gremion-ui
  'gremion-ui-sub-mapper', // §4-1  uid sub protocol-mapper on gremion-ui
  'gremion-ui-redirect-uris', // §4-4  exact per-tenant redirect URIs (#240)
  'gremion-ui-web-origins', // §4-4  exact per-tenant web-origins (#240)
  'full-scope-allowed', // #254   fullScopeAllowed == false on gremion-ui
  'gremion-admin-sa-roles', // (A)   gremion-admin SA holds the realm-management role(s)
  'no-fixture-users', // #239   no non-service-account users
] as const

export type ReconcileCheckName = (typeof RECONCILE_CHECK_NAMES)[number]

/** A single named contract check result (machine-readable). */
export interface NamedCheck {
  name: ReconcileCheckName
  ok: boolean
  /** Human-readable reason on failure (empty on pass). */
  detail: string
}

export interface ReconcileReport {
  realm: string
  /** True iff EVERY check passed (verify-only exits 1 when false). */
  ok: boolean
  checks: NamedCheck[]
  /** In apply mode: the failed check names whose repair was replayed. */
  applied: ReconcileCheckName[]
}

// ── (C) reconcile --all fleet driver ────────────────────────────────────────
/** The tenant statuses that OWN a live realm reconcile can read. `active` +
 *  `suspended` carry a real KC realm (a suspended tenant's realm still exists —
 *  the suspension is a control-row status flip, not a realm delete). The other
 *  three do NOT: `provisioning` has no realm yet (the pipeline may not have
 *  reached realm-create), `deleting`/`deleted` are tombstones whose realm has
 *  been (or is being) dropped — reconcile's first `get<RealmRep>('')` would 404
 *  on them. `--all` therefore SKIPS these so one tombstone never aborts the whole
 *  fleet pass. Mirrors the realm-bearing distinction the lifecycle state machine
 *  already enforces (registry.suspendTenant/resumeTenant). */
export const REALM_BEARING_STATUSES: readonly TenantStatus[] = ['active', 'suspended'] as const
export function isRealmBearing(status: TenantStatus): boolean {
  return (REALM_BEARING_STATUSES as readonly string[]).includes(status)
}

/** The minimal tenant shape `reconcileFleet` needs (a structural subset of the
 *  registry `Tenant`) — keeps the fleet driver pure and unit-testable without a
 *  control-DB row. */
export interface FleetTenant {
  slug: string
  status: TenantStatus
  realmName: string
}

/** One per-tenant outcome in a `--all` pass. `skipped` rows are non-realm-bearing
 *  tenants the pass deliberately did NOT touch (never a failure); `error` rows are
 *  genuine reconcile throws (network/Admin-API) — those make the whole pass fail. */
export interface FleetRow {
  slug: string
  realm: string
  outcome: 'reconciled' | 'skipped' | 'error'
  /** Present on outcome==='reconciled' (the §4 contract report). */
  report?: ReconcileReport
  /** Present on outcome==='skipped' (the status that excluded it). */
  skippedStatus?: TenantStatus
  /** Present on outcome==='error' (the throw message). */
  error?: string
}

export interface FleetReport {
  rows: FleetRow[]
  /** True iff ANY reconciled report failed its checks OR any tenant threw. A pass
   *  over a fleet whose only non-green row is a SKIPPED tombstone stays clean. */
  anyFailed: boolean
}

/** Drive `reconcile --all` across a fleet: SKIP every non-realm-bearing tenant
 *  (so a deleted/deleting/provisioning row never aborts the pass on the first
 *  `get<RealmRep>('')`), then run `runOne` for each realm-bearing tenant wrapped
 *  in try/catch so a single tenant's failure (failed checks OR a thrown
 *  Admin-API error) does NOT stop the fleet — it is recorded and `anyFailed` is
 *  set so the CLI still exits 1 on any genuine failure. PURE over the injected
 *  `runOne` (the CLI supplies the live token-authenticated reconcileRealm).
 *  Generic over `T extends FleetTenant` so the CLI's callback receives the FULL
 *  registry `Tenant` (with `issuer` etc.) it needs — no downcast. */
export async function reconcileFleet<T extends FleetTenant>(
  tenants: readonly T[],
  runOne: (tenant: T) => Promise<ReconcileReport>,
): Promise<FleetReport> {
  const rows: FleetRow[] = []
  let anyFailed = false
  for (const tenant of tenants) {
    if (!isRealmBearing(tenant.status)) {
      rows.push({ slug: tenant.slug, realm: tenant.realmName, outcome: 'skipped', skippedStatus: tenant.status })
      continue
    }
    try {
      const report = await runOne(tenant)
      rows.push({ slug: tenant.slug, realm: tenant.realmName, outcome: 'reconciled', report })
      if (!report.ok) anyFailed = true
    } catch (err) {
      rows.push({
        slug: tenant.slug,
        realm: tenant.realmName,
        outcome: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
      anyFailed = true
    }
  }
  return { rows, anyFailed }
}

export interface ReconcileOptions {
  realm: string
  /** The tenant's external host (e.g. `t2.council.example`) — for the exact-URI set. */
  tenantHost: string
  /** The deployment apex domain the base template's exact URIs reference. */
  apexDomain: string
  /** The module-neutral base template (parsed realm-export.base.json) — the
   *  expected per-tenant gremion-ui URI set is derived from it by host swap. */
  base: Record<string, unknown>
  /** (B) True for the DEFAULT realm (slug `default` / realm `sturaos`). The default
   *  dev-composed realm LEGITIMATELY keeps its localhost dev URIs (realm-export.json
   *  carries them) — so the URI-set check KEEPS localhost for `default` and drops it
   *  ONLY for PROVISIONED tenants, mirroring buildTenantRealmDoc's own
   *  default-vs-provisioned distinction. Without this, reconcile against the live
   *  `sturaos` realm PERMANENTLY false-fails the URI checks (never repairable).
   *  Defaults to false (provisioned) when omitted. */
  isDefault?: boolean
  /** verify-only = no mutation; apply (false) replays the repairable failures. */
  verifyOnly: boolean
}

// ── KC Admin-API shapes (the subset reconcile reads) ──────────────────────────
interface RealmRep {
  sslRequired?: string
  browserFlow?: string
  otpPolicyType?: string
  otpPolicyAlgorithm?: string
  otpPolicyDigits?: number
  otpPolicyPeriod?: number
  attributes?: Record<string, unknown>
}
interface FlowRep {
  alias?: string
}
interface ExecRep {
  id?: string
  providerId?: string
  authenticationConfig?: string
}
interface ConfigRep {
  alias?: string
  config?: Record<string, string>
}
interface ClientRep {
  id?: string
  clientId?: string
  fullScopeAllowed?: boolean
  redirectUris?: string[]
  webOrigins?: string[]
}
interface MapperRep {
  protocolMapper?: string
  config?: Record<string, string>
}
interface UserRep {
  username?: string
  serviceAccountClientId?: string
}

/** The expected acr.loa.map literal (matches the base + the §4-2 apply). */
const ACR_LOA_MAP = '{"loa1":1,"loa2":2}'
/** The repairable check family: those the §4-2 step-up sequence covers. */
const STEPUP_REPAIRABLE: ReconcileCheckName[] = [
  'browser-flow',
  'otp-policy',
  'acr-loa-map',
  'stepup-flow',
  'stepup-loa-config',
  'gremion-ui-acr-mapper',
]

function arraysEqualAsSet(a: readonly string[] | undefined, b: readonly string[]): boolean {
  if (!a) return false
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((v, i) => v === sb[i])
}

/** Derive the EXACT expected per-tenant URI set from the base gremion-ui client by
 *  swapping the apex authority for the tenant host (shapes preserved, never a
 *  wildcard — §4-4), then DROPPING every foreign-host / localhost http(s) entry
 *  (#240 B/C) — exactly as buildTenantRealmDoc does on the provisioned path. The
 *  drift guard therefore enforces no-localhost / no-foreign-host on tenant
 *  realms; a live realm still carrying localhost/foreign URIs FAILS the check. */
function swapHost(value: string, apexDomain: string, tenantHost: string): string {
  return value.split(`https://${apexDomain}`).join(`https://${tenantHost}`)
}
/** Mirror of realm-doc.ts uriAllowedForTenant: an http(s) URI survives only if it
 *  points at the tenant host; custom (non-http) schemes always survive. */
function uriAllowedForTenant(uri: string, tenantHost: string): boolean {
  const lower = uri.toLowerCase()
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) return true
  const afterScheme = uri.slice(uri.indexOf('://') + 3)
  const slash = afterScheme.indexOf('/')
  const authority = slash >= 0 ? afterScheme.slice(0, slash) : afterScheme
  return authority === tenantHost
}
function expectedUiUris(
  base: Record<string, unknown>,
  apexDomain: string,
  tenantHost: string,
  isDefault: boolean,
): { redirectUris: string[]; webOrigins: string[] } {
  const clients = (base.clients as ClientRep[] | undefined) ?? []
  const ui = clients.find((c) => c.clientId === 'gremion-ui')
  // (B) The DEFAULT realm keeps the base URIs verbatim (localhost dev URIs + apex);
  // a PROVISIONED tenant gets the apex host swapped for its subdomain host AND every
  // localhost/foreign-host http(s) entry dropped — mirroring buildTenantRealmDoc.
  const map = (xs: string[] | undefined) =>
    isDefault
      ? [...(xs ?? [])]
      : (xs ?? [])
          .map((u) => swapHost(u, apexDomain, tenantHost))
          .filter((u) => uriAllowedForTenant(u, tenantHost))
  return { redirectUris: map(ui?.redirectUris), webOrigins: map(ui?.webOrigins) }
}

/** (D) #254: the gremion-ui realm-role scopeMappings the base template carries — the
 *  FLOOR every realm must grant (module roles like `finance` are additive and
 *  config-dependent, so the base first-party set is the always-present minimum a
 *  fullScopeAllowed:false client needs to emit realm_access.roles at all). */
function expectedUiScopeRoles(base: Record<string, unknown>): string[] {
  const scopeMappings = (base.scopeMappings as Array<{ client?: string; roles?: string[] }> | undefined) ?? []
  const ui = scopeMappings.find((sm) => sm.client === 'gremion-ui')
  return [...(ui?.roles ?? [])]
}

export async function reconcileRealm(transport: KcTransport, opts: ReconcileOptions): Promise<ReconcileReport> {
  const { realm, tenantHost, apexDomain, base, verifyOnly } = opts
  const isDefault = opts.isDefault ?? false
  // (FIX3-B) Encode the realm name as a single path segment via the SHARED
  // realmSeg helper (same encoding KcProvisionApi applies) — defence-in-depth so
  // these GET/PUT paths can never break out of their segment even though the CLI
  // already validateSlug's the realm.
  const get = <T>(path: string): Promise<T> =>
    transport('GET', `/admin/realms/${realmSeg(realm)}${path}`) as Promise<T>

  const checks: NamedCheck[] = []
  const pass = (name: ReconcileCheckName) => checks.push({ name, ok: true, detail: '' })
  const fail = (name: ReconcileCheckName, detail: string) => checks.push({ name, ok: false, detail })

  // ── realm rep: ssl / browserFlow / otpPolicy / acr.loa.map ──────────────────
  const realmRep = await get<RealmRep>('')
  realmRep.sslRequired === 'all'
    ? pass('ssl-required')
    : fail('ssl-required', `sslRequired is "${realmRep.sslRequired}" (expected "all" — #139/G-080)`)
  realmRep.browserFlow === 'browser-stepup'
    ? pass('browser-flow')
    : fail('browser-flow', `browserFlow is "${realmRep.browserFlow}" (expected "browser-stepup")`)
  const otpOk =
    realmRep.otpPolicyType === 'totp' &&
    realmRep.otpPolicyAlgorithm === 'HmacSHA1' &&
    realmRep.otpPolicyDigits === 6 &&
    realmRep.otpPolicyPeriod === 30
  otpOk
    ? pass('otp-policy')
    : fail(
        'otp-policy',
        `otpPolicy drifted (type=${realmRep.otpPolicyType} alg=${realmRep.otpPolicyAlgorithm} digits=${realmRep.otpPolicyDigits} period=${realmRep.otpPolicyPeriod}; expected totp/HmacSHA1/6/30)`,
      )
  realmRep.attributes?.['acr.loa.map'] === ACR_LOA_MAP
    ? pass('acr-loa-map')
    : fail('acr-loa-map', `acr.loa.map is ${JSON.stringify(realmRep.attributes?.['acr.loa.map'])} (expected ${ACR_LOA_MAP})`)

  // ── step-up flow existence + subflows ───────────────────────────────────────
  const flows = (await get<FlowRep[]>('/authentication/flows')) ?? []
  const stepupExists = flows.some((f) => f.alias === 'browser-stepup')
  // The two LoA subflow execution lists double as the subflow-existence probe + the
  // source for the Condition-LoA config check below.
  const e1 = stepupExists ? (await get<ExecRep[]>('/authentication/flows/stepup-1fa/executions')) ?? [] : []
  const e2 = stepupExists ? (await get<ExecRep[]>('/authentication/flows/stepup-2fa/executions')) ?? [] : []
  const sub1Ok = e1.some((e) => e.providerId === 'auth-username-password-form')
  const sub2Ok = e2.some((e) => e.providerId === 'auth-otp-form')
  stepupExists && sub1Ok && sub2Ok
    ? pass('stepup-flow')
    : fail(
        'stepup-flow',
        !stepupExists
          ? 'browser-stepup flow is absent'
          : `stepup subflows incomplete (1fa-password=${sub1Ok}, 2fa-otp=${sub2Ok})`,
      )

  // ── Condition-LoA configs (loa1 / 36000, loa2 / 300) ────────────────────────
  async function loaConfig(execs: ExecRep[]): Promise<ConfigRep | undefined> {
    const cond = execs.find((e) => e.providerId === 'conditional-level-of-authentication')
    if (!cond?.authenticationConfig) return undefined
    return get<ConfigRep>(`/authentication/config/${cond.authenticationConfig}`)
  }
  if (!stepupExists) {
    fail('stepup-loa-config', 'browser-stepup flow absent — LoA configs cannot be verified')
  } else {
    const cfg1 = await loaConfig(e1)
    const cfg2 = await loaConfig(e2)
    const c1Ok = cfg1?.config?.['loa-condition-level'] === '1' && cfg1?.config?.['loa-max-age'] === '36000'
    const c2Ok = cfg2?.config?.['loa-condition-level'] === '2' && cfg2?.config?.['loa-max-age'] === '300'
    c1Ok && c2Ok
      ? pass('stepup-loa-config')
      : fail(
          'stepup-loa-config',
          `Condition-LoA configs drifted (loa1: ${JSON.stringify(cfg1?.config)}; loa2: ${JSON.stringify(cfg2?.config)}; expected level1/36000 + level2/300)`,
        )
  }

  // ── gremion-ui client: existence, mappers, exact URIs, fullScopeAllowed ────────
  const clients = (await get<ClientRep[]>('/clients?clientId=gremion-ui')) ?? []
  const ui = clients[0]
  if (!ui?.id) {
    fail('gremion-ui-client', 'the gremion-ui client is absent from the realm')
    // Dependent checks cannot be evaluated without the client — record them failed
    // (a missing client is itself a contract violation; verify exits 1).
    fail('gremion-ui-acr-mapper', 'gremion-ui client absent — acr mapper cannot be verified')
    fail('gremion-ui-sub-mapper', 'gremion-ui client absent — sub mapper cannot be verified')
    fail('gremion-ui-redirect-uris', 'gremion-ui client absent — redirect URIs cannot be verified')
    fail('gremion-ui-web-origins', 'gremion-ui client absent — web-origins cannot be verified')
    fail('full-scope-allowed', 'gremion-ui client absent — fullScopeAllowed cannot be verified')
  } else {
    pass('gremion-ui-client')
    const mappers = (await get<MapperRep[]>(`/clients/${ui.id}/protocol-mappers/models`)) ?? []
    mappers.some((m) => m.protocolMapper === 'oidc-acr-mapper')
      ? pass('gremion-ui-acr-mapper')
      : fail('gremion-ui-acr-mapper', 'gremion-ui has no oidc-acr-mapper (#164 acr claim)')
    mappers.some(
      (m) => m.protocolMapper === 'oidc-usermodel-property-mapper' && m.config?.['claim.name'] === 'sub',
    )
      ? pass('gremion-ui-sub-mapper')
      : fail('gremion-ui-sub-mapper', 'gremion-ui has no uid sub-mapper (oidc-usermodel-property-mapper -> sub)')

    const expected = expectedUiUris(base, apexDomain, tenantHost, isDefault)
    arraysEqualAsSet(ui.redirectUris, expected.redirectUris)
      ? pass('gremion-ui-redirect-uris')
      : fail(
          'gremion-ui-redirect-uris',
          `redirect URIs not the exact per-tenant set (#240). got=${JSON.stringify(ui.redirectUris)} expected=${JSON.stringify(expected.redirectUris)}`,
        )
    arraysEqualAsSet(ui.webOrigins, expected.webOrigins)
      ? pass('gremion-ui-web-origins')
      : fail(
          'gremion-ui-web-origins',
          `web-origins not the exact per-tenant set (#240). got=${JSON.stringify(ui.webOrigins)} expected=${JSON.stringify(expected.webOrigins)}`,
        )
    // #254 — fullScopeAllowed:false alone is NOT enough: WITHOUT explicit realm-role
    // scope-mappings the gremion-ui client silently emits NO realm_access.roles, which
    // is the exact #254 silent role-filtering break. So the check ALSO asserts the
    // expected base gremion-ui realm-role scopeMappings are present on the live client
    // (module roles are additive + config-dependent, so the base set is the floor).
    if (ui.fullScopeAllowed !== false) {
      fail('full-scope-allowed', `fullScopeAllowed is ${ui.fullScopeAllowed} (expected false — #254)`)
    } else {
      const expectedRoles = expectedUiScopeRoles(base)
      const mapped = (await get<Array<{ name?: string }>>(`/clients/${ui.id}/scope-mappings/realm`)) ?? []
      const mappedNames = new Set(mapped.map((r) => r.name).filter((n): n is string => typeof n === 'string'))
      const missing = expectedRoles.filter((r) => !mappedNames.has(r))
      missing.length === 0
        ? pass('full-scope-allowed')
        : fail(
            'full-scope-allowed',
            `fullScopeAllowed is false but the expected gremion-ui realm-role scopeMappings are missing (#254 silent role-filtering break): missing=[${missing.join(', ')}] got=[${[...mappedNames].join(', ')}]`,
          )
    }
  }

  // ── #239: no fixture / dev users (service accounts only) ─────────────────────
  const users = (await get<UserRep[]>('/users?max=2000')) ?? []
  const offenders = users.filter(
    (u) =>
      typeof u.serviceAccountClientId !== 'string' &&
      !(typeof u.username === 'string' && u.username.startsWith('service-account-')),
  )
  offenders.length === 0
    ? pass('no-fixture-users')
    : fail(
        'no-fixture-users',
        `non-service-account user(s) present (#239): ${offenders.map((u) => u.username ?? '<no username>').join(', ')}`,
      )

  // ── (A) gremion-admin SA realm-management roles ───────────────────────────────
  // KC 26's import does NOT carry service-account role mappings reliably, so a
  // provisioned realm's gremion-admin SA can do client_credentials but every Admin
  // REST op 403s (governance sync, newsletter group resolution, #164 step-up
  // freshness). The provisioner grants GREMION_ADMIN_SA_REALM_ROLES post-create;
  // this check asserts they are STILL present (read via the Admin-API reader) and
  // apply re-runs the idempotent grant when they have drifted away.
  const saRoles = await new KcProvisionApi(transport).getServiceAccountRealmRoleNames(realm, ADMIN_CLIENT_ID)
  const saRoleSet = new Set(saRoles)
  const missingSaRoles = GREMION_ADMIN_SA_REALM_ROLES.filter((r) => !saRoleSet.has(r))
  missingSaRoles.length === 0
    ? pass('gremion-admin-sa-roles')
    : fail(
        'gremion-admin-sa-roles',
        `the ${ADMIN_CLIENT_ID} service account is missing realm-management role(s) (A — KC 26 import drops SA mappings -> every Admin REST op 403s): missing=[${missingSaRoles.join(', ')}] got=[${saRoles.join(', ')}]`,
      )

  // ── verdict ─────────────────────────────────────────────────────────────────
  const ok = checks.every((c) => c.ok)
  const applied: ReconcileCheckName[] = []

  if (verifyOnly || ok) {
    return { realm, ok, checks, applied }
  }

  // ── APPLY: replay ONLY the failed, mechanically-repairable checks (§4-2). ────
  const failedNames = new Set(checks.filter((c) => !c.ok).map((c) => c.name))

  // The §4-2 step-up sequence (flow-exists guard, ORDER: flow before browserFlow
  // PUT, idempotent acr-mapper) repairs the whole step-up/realm-config family in
  // one call — run it once if ANY of those checks failed.
  const stepupFailed = STEPUP_REPAIRABLE.filter((n) => failedNames.has(n))
  if (stepupFailed.length > 0) {
    await new KcProvisionApi(transport).configureStepupFlow(realm)
    applied.push(...stepupFailed)
  }

  // sslRequired is repaired by a localized partial realm PUT that MERGES the
  // existing attributes (a full round-tripped realm rep 500s on KC 26).
  if (failedNames.has('ssl-required')) {
    const fresh = await get<RealmRep>('')
    // (FIX3-B) encode the realm path segment via the shared helper (matches get()).
    await transport('PUT', `/admin/realms/${realmSeg(realm)}`, {
      realm,
      sslRequired: 'all',
      attributes: { ...(fresh.attributes ?? {}), 'acr.loa.map': ACR_LOA_MAP },
    })
    applied.push('ssl-required')
  }

  // (A) The gremion-admin SA realm-management grant is mechanically repairable: the
  // ported assign_realm_admin_to_sa is idempotent (KC no-ops duplicate mappings),
  // so apply simply re-runs it when the role mapping has drifted away.
  if (failedNames.has('gremion-admin-sa-roles')) {
    await new KcProvisionApi(transport).assignServiceAccountRealmRoles(
      realm,
      ADMIN_CLIENT_ID,
      GREMION_ADMIN_SA_REALM_ROLES,
    )
    applied.push('gremion-admin-sa-roles')
  }

  // The remaining failures (exact URIs / fixture users / fullScopeAllowed / the
  // sub-mapper) are NOT mechanically repaired by the §4-2 sequence — they stay
  // reported so the operator re-imports/re-stamps the realm. Re-verify so the
  // report reflects post-apply state.
  const after = await reconcileRealm(transport, { ...opts, verifyOnly: true })
  return { realm, ok: after.ok, checks: after.checks, applied }
}
