// src/lib/server/tenant/provisioner/realm-doc.ts
// P2.1c (T10) — PURE per-tenant realm-doc builder (no IO). Composes the §4
// realm contract for a NEW tenant from the module-neutral base template:
//   1. composeRealm injects only the ENABLED modules' realm fragments (P0.2 —
//      a finance-OFF vertical's realm carries no ref-finanzen* group/role by
//      construction);
//   2. the per-tenant realm name, sslRequired:'all' (#139) and the EXACT
//      per-host redirect URIs / web-origins / post-logout (#240 — apex host
//      swapped for the tenant subdomain host, never a path wildcard) are set;
//   3. each confidential client's `__*__` secret placeholder is replaced with a
//      caller-generated secret (the pipeline owns generation + secret-ref
//      registry write; this module only places the literal the KC import needs);
//   4. assertServiceAccountsOnly refuses any non-service-account user (#239) so
//      a dev-user can never be stamped into a fresh realm.
// The CLI/pipeline does the IO and the Admin-API apply for EXISTING realms.
//
// PROVISIONED-REALM HARDENING (FIX-REALM):
//   (A) #139/G-080 — kcInternalForTenant returns an internal-TLS URL
//       (`https://keycloak:8443/auth/realms/<realm>` by default, or the
//       env-derived AUTH_KEYCLOAK_INTERNAL base the default tenant uses), NOT a
//       plaintext `http://keycloak:8080` URL. A realm stamped `sslRequired:'all'`
//       MUST be reached by its admin client over TLS or every provisioned-tenant
//       OIDC/admin call breaks.
//   (B/C) #240 — a PROVISIONED realm carries ONLY tenant-host URIs: every
//       FOREIGN external host (e.g. the relic `https://stura.example.org`) and every
//       `localhost(:*)` dev URI is STRIPPED from every client's
//       redirectUris/webOrigins/post-logout. (The dev-composed DEFAULT realm
//       keeps localhost — those entries live in realm-export.base.json and are
//       only dropped on this provisioned path; the stura.example.org relic is removed
//       from the base entirely.)
//   (D) P2.2-auth role-vocab — a tenant whose `config.roles` override diverges
//       from the realm roles the composed doc ACTUALLY carries is REFUSED loudly
//       (assertRoleVocabularyCarried), never silently stamped with tokens
//       missing its custom roles. Full custom-vocab realm wiring is P2.3 (see the
//       deferred ledger). KNOWN GAP recorded there: composeRealm/scopeMappings do
//       not yet MINT custom realm roles for an override vocabulary, so until P2.3
//       only a vocabulary that is a SUBSET of the carried realm roles may be
//       provisioned.
import { composeRealm } from '$lib/modules/realm'
import type { ModuleManifest } from '$lib/modules/types'

type ModulesConfig = {
  modules: Record<string, boolean>
  /** P2.2-auth (D-VOCAB): optional per-tenant role-vocabulary override. Absent in
   *  every existing config (default vocabulary). When PRESENT (an override), the
   *  role-vocab guard (D) requires every entry to be carried by the composed realm. */
  roles?: readonly string[]
}
type RealmDoc = Record<string, unknown> & {
  realm: string
  sslRequired?: string
  clients?: unknown[]
  users?: unknown[]
  groups?: unknown[]
  roles?: { realm?: { name?: string }[] } & Record<string, unknown>
}

// The confidential clients in the base template whose `__*__OIDC_CLIENT_SECRET__`
// placeholder a provisioned realm must replace with a generated secret. The
// public PKCE client (gremion-mobile) has no secret; gremion-admin DOES (service
// account). Pinned against the base template's placeholders.
export const PROVISIONER_SECRET_CLIENTS = [
  'nextcloud',
  'gremion-ui',
  'gremion-admin',
  'helios',
  'helios-voter',
  'synapse',
] as const

export type ProvisionerSecretClient = (typeof PROVISIONER_SECRET_CLIENTS)[number]

/** D-ISSUER-HOST: NEW tenants get a tenant-subdomain issuer. */
export function issuerForTenant(slug: string, realmName: string, apexDomain: string): string {
  return `https://${slug}.${apexDomain}/auth/realms/${realmName}`
}

/**
 * (A) #139/G-080: the in-cluster realm-scoped admin/OIDC URL for a PROVISIONED
 * tenant. The realm is stamped `sslRequired:'all'`, so its admin client MUST
 * reach KC over TLS — a plaintext `http://keycloak:8080` URL would be refused by
 * the realm and break every provisioned-tenant OIDC/admin call
 * ([[keycloak-sslrequired-all-scopes-to-plaintext-callers]]).
 *
 * `kcInternalBase` is the scheme+authority+`/auth` prefix (NO trailing
 * `/realms/...`) — derived by the CLI from `AUTH_KEYCLOAK_INTERNAL` exactly the
 * way the DEFAULT tenant does (register-default.ts), with a TLS default matching
 * the live internal posture (`docker-compose.yml` `https://keycloak:8443/auth`,
 * #139). Any realm suffix on the supplied base is stripped so a realm-scoped
 * AUTH_KEYCLOAK_INTERNAL (e.g. `.../auth/realms/sturaos`) still yields the right
 * per-tenant URL.
 */
export const DEFAULT_KC_INTERNAL_BASE = 'https://keycloak:8443/auth'

export function kcInternalForTenant(
  realmName: string,
  kcInternalBase: string = DEFAULT_KC_INTERNAL_BASE,
): string {
  const authBase = kcInternalBase
    .replace(/\/$/, '') // trailing slash
    .replace(/\/realms\/[^/]+$/, '') // a realm-scoped AUTH_KEYCLOAK_INTERNAL -> its /auth base
  return `${authBase}/realms/${realmName}`
}

/**
 * #239 — a provisioned realm must carry SERVICE ACCOUNTS ONLY (the base
 * template's only user is `service-account-gremion-admin`). A service-account
 * user is identified by a `serviceAccountClientId` field OR a
 * `service-account-` username prefix (KC's own convention). Anything else is a
 * human/dev user and is refused loudly, naming the offending username.
 */
export function assertServiceAccountsOnly(
  users:
    | ReadonlyArray<{ username?: string; serviceAccountClientId?: string; [k: string]: unknown }>
    | undefined,
): void {
  for (const u of users ?? []) {
    const isServiceAccount =
      typeof u.serviceAccountClientId === 'string' ||
      (typeof u.username === 'string' && u.username.startsWith('service-account-'))
    if (!isServiceAccount) {
      throw new Error(
        `realm-doc: refusing to provision a realm with a non-service-account user "${u.username ?? '<no username>'}" (#239 — fixture/dev users must never be stamped into a tenant realm)`,
      )
    }
  }
}

export interface BuildTenantRealmDocInput {
  /** The module-neutral base template (parsed realm-export.base.json). */
  base: RealmDoc
  manifests: ModuleManifest[]
  /** The tenant's vertical config (drives module deselection). */
  config: ModulesConfig
  slug: string
  realmName: string
  /** The tenant's external host (e.g. `t2.council.example`). */
  tenantHost: string
  /** The deployment apex domain the base template's exact URIs reference. */
  apexDomain: string
  /** Generated per-client secrets keyed by clientId (PROVISIONER_SECRET_CLIENTS). */
  clientSecrets: Record<string, string>
}

/** Recursively replace every `https://<apexDomain>` occurrence with the tenant
 *  host, in strings only. Exact-URI shapes (T8/#240) are preserved — only the
 *  host authority changes — so a wildcard is never introduced. (Foreign hosts and
 *  localhost are dropped separately by restrictClientUris below — this pass only
 *  rewrites the legitimate apex host into the tenant host.)
 *
 *  MULTI-DOMAIN PORTABILITY (CLOSED): this swap only rewrites URIs whose
 *  authority is EXACTLY `apexDomain`, so it used to work only for the one
 *  deployment whose host the base template hard-coded — any other `DOMAIN`
 *  matched nothing, and every client URI was then DROPPED by restrictClientUris
 *  as a foreign host, leaving the provisioned realm with no valid redirect URI.
 *  `docker/keycloak/realm-export.base.json` now carries the apex host as the
 *  `__APEX_DOMAIN__` sentinel instead of a literal, resolved from `DOMAIN` by
 *  both consumers before the doc gets here: docker/keycloak/substitute-realm-
 *  secrets.sh at Keycloak boot, and loadBaseRealmDoc() in
 *  gremion-ui/scripts/tenant-provision.ts on the provisioning path. So the
 *  authority the base carries is the deployment's own apex, and this swap fires
 *  for every deployment. A caller that hands us an UNRESOLVED template still
 *  fails the same way — which is why the resolution lives at the read, not here. */
function swapHost(value: unknown, apexDomain: string, tenantHost: string): unknown {
  if (typeof value === 'string') {
    // Replace the apex authority wherever it appears (URIs and the `##`-joined
    // post-logout attribute), not just at string start.
    return value.split(`https://${apexDomain}`).join(`https://${tenantHost}`)
  }
  if (Array.isArray(value)) return value.map((v) => swapHost(v, apexDomain, tenantHost))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = swapHost(v, apexDomain, tenantHost)
    }
    return out
  }
  return value
}

/**
 * (B/C) #240: a single redirect/web-origin/post-logout entry is ALLOWED on a
 * provisioned realm iff it is NOT an http(s) URL pointing at any host other than
 * the tenant host. Concretely:
 *   - an `https://<tenantHost>...` entry  -> KEEP (the legitimate per-tenant URI);
 *   - any OTHER `http://` / `https://` entry (foreign host like `stura.example.org`, OR
 *     `localhost(:port)`) -> DROP (token-interception surface in an internet-
 *     facing realm);
 *   - a non-http(s) scheme (the mobile custom schemes `stura://…`,
 *     `de.sturaos.app:/…`) -> KEEP (no host authority to abuse).
 */
function uriAllowedForTenant(uri: string, tenantHost: string): boolean {
  const lower = uri.toLowerCase()
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) return true
  // Compare the host authority (everything up to the first '/' after the scheme).
  const afterScheme = uri.slice(uri.indexOf('://') + 3)
  const slash = afterScheme.indexOf('/')
  const authority = slash >= 0 ? afterScheme.slice(0, slash) : afterScheme
  return authority === tenantHost
}

/** Drop every foreign-host / localhost http(s) entry from a client's
 *  redirectUris / webOrigins / the `##`-joined post.logout attribute. Custom
 *  schemes and the tenant-host URIs survive (#240). */
function restrictClientUris(client: Record<string, unknown>, tenantHost: string): void {
  for (const key of ['redirectUris', 'webOrigins'] as const) {
    const arr = client[key]
    if (Array.isArray(arr)) {
      client[key] = arr.filter((u) => typeof u !== 'string' || uriAllowedForTenant(u, tenantHost))
    }
  }
  const attrs = client.attributes
  if (attrs && typeof attrs === 'object') {
    const a = attrs as Record<string, unknown>
    const pl = a['post.logout.redirect.uris']
    if (typeof pl === 'string') {
      a['post.logout.redirect.uris'] = pl
        .split('##')
        .filter((u) => uriAllowedForTenant(u, tenantHost))
        .join('##')
    }
  }
}

/**
 * (D) P2.2-auth role-vocab guard: if the tenant config carries an EXPLICIT
 * `config.roles` override, every entry MUST exist as a realm role the composed
 * doc actually carries — otherwise the tenant would get tokens silently missing
 * its custom roles (composeRealm/scopeMappings do NOT yet mint custom realm roles
 * for an override vocabulary; that is P2.3 / the deferred ledger). Fail LOUD,
 * naming the missing roles, rather than provision a broken realm. An ABSENT
 * override means the default vocabulary — NOT checked (byte-identical default
 * path; the default `Object.values(Role)` legitimately includes vocab-only roles
 * like `auditor` that the base realm does not carry as realm roles).
 */
export function assertRoleVocabularyCarried(
  configRoles: readonly string[] | undefined,
  doc: RealmDoc,
): void {
  if (!configRoles) return // absent override -> default vocabulary, not checked
  const carried = new Set((doc.roles?.realm ?? []).map((r) => r?.name).filter((n): n is string => !!n))
  const missing = configRoles.filter((r) => !carried.has(r))
  if (missing.length > 0) {
    throw new Error(
      `realm-doc: refusing to provision realm "${doc.realm}" — its config.roles override ` +
        `[${configRoles.join(', ')}] diverges from the realm roles the composed doc carries ` +
        `[${[...carried].join(', ')}]; missing: [${missing.join(', ')}]. Custom realm-role minting ` +
        'for an override vocabulary is deferred to P2.3 (see 2026-06-08-pillar2-p2.1a-DEFERRED-ITEMS.md). ' +
        'Until then, config.roles MUST be a subset of the carried realm roles.',
    )
  }
}

export function buildTenantRealmDoc(input: BuildTenantRealmDocInput): RealmDoc {
  const { base, manifests, config, realmName, tenantHost, apexDomain, clientSecrets } = input

  // #239 — refuse a base that carries any non-service-account user BEFORE we
  // compose, so a tampered template never reaches KC.
  assertServiceAccountsOnly(base.users as Array<{ username?: string; serviceAccountClientId?: string }>)

  // (1) module-driven composition (P0.2). composeRealm is pure and returns a
  // fresh object — but it shallow-spreads, so deep-clone first to guarantee we
  // never mutate the caller's base (asserted by the no-mutation test).
  const composed = composeRealm(
    JSON.parse(JSON.stringify(base)) as never,
    manifests,
    config as never,
  ) as unknown as RealmDoc

  // (2) per-tenant realm identity + sslRequired:'all' literal (#139).
  composed.realm = realmName
  composed.sslRequired = 'all'

  // (D) role-vocab guard — refuse a divergent config.roles override BEFORE we
  // emit a realm whose tokens would silently miss the tenant's custom roles.
  assertRoleVocabularyCarried(config.roles, composed)

  // (2b) host swap across the whole doc (redirect URIs / web-origins /
  // post-logout attributes) — exact shapes preserved, apex authority -> tenant.
  const hostSwapped = swapHost(composed, apexDomain, tenantHost) as RealmDoc

  // (2c) #240 (B/C): a PROVISIONED realm carries ONLY tenant-host http(s) URIs —
  // drop every foreign-host (e.g. the relic stura.example.org, were it ever reintroduced)
  // and localhost dev URI from every client. Custom mobile schemes survive.
  for (const client of (hostSwapped.clients ?? []) as Array<Record<string, unknown>>) {
    restrictClientUris(client, tenantHost)
  }

  // (3) inject the generated per-client secrets in place of the `__*__`
  // placeholders. A missing secret for a placeholder client is a programming
  // error (the pipeline must generate one for every PROVISIONER_SECRET_CLIENTS).
  for (const client of (hostSwapped.clients ?? []) as Array<{ clientId?: string; secret?: string }>) {
    if (typeof client.secret === 'string' && client.secret.startsWith('__') && client.secret.endsWith('__')) {
      const id = client.clientId ?? ''
      const generated = clientSecrets[id]
      if (!generated) {
        throw new Error(`realm-doc: no generated secret supplied for confidential client "${id}"`)
      }
      client.secret = generated
    }
  }

  // (4) Strip the base template's hardcoded `id`s from authentication flows and
  // authenticator configs so KC mints FRESH per-realm UUIDs on import. Those ids
  // are GLOBALLY unique in KC; the #164 step-up `authenticatorConfig` ids
  // (stepup-loa1/-loa2) and custom step-up flow ids are preserved verbatim on the
  // default realm's import, so the SECOND realm built from the same template
  // collides (PG unique-violation on AUTHENTICATOR_CONFIG/AUTHENTICATION_FLOW ->
  // KC ModelDuplicateException -> 409, which createRealm misreads as
  // "alreadyExisted" -> the next step then 404s "Realm not found"). Executions
  // reference configs and sub-flows by ALIAS (not id), so dropping the ids is
  // contract-safe. (Surfaced provisioning the first real second realm
  // `musterstadt`, P2.3 #202.)
  const flows = (hostSwapped.authenticationFlows as Array<Record<string, unknown>> | undefined) ?? []
  for (const flow of flows) delete flow.id
  const authConfigs = (hostSwapped.authenticatorConfig as Array<Record<string, unknown>> | undefined) ?? []
  for (const cfg of authConfigs) delete cfg.id

  return hostSwapped
}
