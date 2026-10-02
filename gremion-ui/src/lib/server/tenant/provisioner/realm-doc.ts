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
//       base the CLI derives from AUTH_KEYCLOAK_INTERNAL), NOT a
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
import { normaliseHost } from '$lib/server/tenant/host'
import type { ModuleManifest } from '$lib/modules/types'
import { ADMIN_CLIENT_ID, GREMION_ADMIN_SA_REALM_ROLES } from './pipeline'

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
// placeholder a provisioned realm must replace with a generated secret: EXACTLY
// the base template's placeholders (TASK-043 Q11 shrank it from six names, four
// of which no template carried -- a secret file per phantom client). The public
// PKCE client (gremion-mobile) has no secret; gremion-admin DOES (service
// account). realm-doc.test.ts pins this list against the template.
export const PROVISIONER_SECRET_CLIENTS = ['gremion-ui', 'gremion-admin', 'synapse'] as const

/**
 * TASK-043 Q11 (RFC 8252 §7.1): the native app's private-use URI scheme is the
 * platform domain reversed, `<reversed domain>.app:/oauthredirect` -- e.g.
 * `example.council.app:/oauthredirect` for `council.example`. Set per realm here
 * (the base template carries no sentinel for it).
 */
export function mobileRedirectUri(platformDomain: string): string {
  const labels = platformDomain.toLowerCase().split('.').filter(Boolean)
  if (labels.length < 2 || !labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) {
    throw new Error(`realm-doc: platform domain ${JSON.stringify(platformDomain)} is not a DNS name`)
  }
  return `${labels.reverse().join('.')}.app:/oauthredirect`
}

export type ProvisionerSecretClient = (typeof PROVISIONER_SECRET_CLIENTS)[number]

/**
 * TASK-042 Q2 (TRD-075, spec B §T.2): a tenant's issuer is minted from the host
 * the OPERATOR supplied for it, used verbatim — never synthesised from the slug
 * and the platform apex. The host must already be the canonical lower-case
 * `tenant_domain.host` form (normaliseHost); anything else is refused, so the
 * issuer and the tenant's primary `tenant_domain` row can never disagree.
 */
/**
 * TASK-043 r4: the realm attribute `frontendUrl` -- the `/auth` base of
 * issuerForTenant(host, realm), so the issuer and every link Keycloak mails
 * name the customer's own host whatever address the admin call used.
 */
export function frontendUrlFor(host: string, realmName: string): string {
  const issuer = issuerForTenant(host, realmName)
  return issuer.slice(0, issuer.length - `/realms/${realmName}`.length)
}

export function issuerForTenant(host: string, realmName: string): string {
  const canonical = normaliseHost(host)
  if (!canonical || canonical !== host) {
    throw new Error(`tenant: host is not a valid hostname (${JSON.stringify(host)})`)
  }
  return `https://${host}/auth/realms/${realmName}`
}

/**
 * (A) #139/G-080: the in-cluster realm-scoped admin/OIDC URL for a PROVISIONED
 * tenant. The realm is stamped `sslRequired:'all'`, so its admin client MUST
 * reach KC over TLS — a plaintext `http://keycloak:8080` URL would be refused by
 * the realm and break every provisioned-tenant OIDC/admin call
 * ([[keycloak-sslrequired-all-scopes-to-plaintext-callers]]).
 *
 * `kcInternalBase` is the scheme+authority+`/auth` prefix (NO trailing
 * `/realms/...`) — derived by the CLI from `AUTH_KEYCLOAK_INTERNAL`, with a TLS
 * default matching the live internal posture (`https://keycloak:8443/auth`,
 * #139). Any realm suffix on the supplied base is stripped so a realm-scoped
 * AUTH_KEYCLOAK_INTERNAL (e.g. `.../auth/realms/<tenant-slug>`) still yields the right
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
  /** The realm's authenticating SMTP sender. `null` (TASK-043, every customer
   *  realm): the realm is created with NO sender at all -- the template's
   *  smtpServer block is removed -- and the host phase stamps the customer's
   *  OWN submission principal (gremion-vendor-mail realm-smtp --tenant) before
   *  any user exists; reconcile's smtp-server check guards it from then on. A
   *  settings object keeps the pre-TASK-043 shape (the template sentinels
   *  filled from it) for the callers that still compose a full realm. */
  smtp: RealmSmtpSettings | null
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
 *     `de.example.app:/…`) -> KEEP (no host authority to abuse).
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

/** The platform's authenticating SMTP sender (gremion#6). Derived from the host
 *  env, never configured twice: the principal is `platform@<PLATFORM_DOMAIN>`
 *  (infra/host/mail/provision-roles.sh:251,263), its app password is
 *  PLATFORM_SMTP_PASSWORD, and the submission host is mail.<PLATFORM_DOMAIN>
 *  reached on 587 by its PUBLIC name (spec A §B hairpin), so the setup wizard's
 *  RFC1918-refusing SMTP guard stays intact. */
export interface RealmSmtpSettings {
  host: string
  port: number
  from: string
  user: string
  password: string
}

export const TEMPLATE_SENTINEL_PATTERN = /__[A-Z][A-Z0-9_]*__/g

/** PURE: the caller supplies the env record (process.env in the CLI and in the
 *  B19 compose-realm route), so this module still reads no env of its own. */
export function platformSmtpFromEnv(env: Record<string, string | undefined>): RealmSmtpSettings {
  const domain = (env.PLATFORM_DOMAIN ?? '').trim()
  const password = (env.PLATFORM_SMTP_PASSWORD ?? '').trim()
  if (!domain) {
    throw new Error(
      'realm-doc: PLATFORM_DOMAIN is unset — the platform SMTP identity ' +
        '(platform@<PLATFORM_DOMAIN> on mail.<PLATFORM_DOMAIN>) cannot be derived (gremion#6).',
    )
  }
  if (!password) {
    throw new Error(
      'realm-doc: PLATFORM_SMTP_PASSWORD is unset — a realm whose reset-password path is open ' +
        'must not be provisioned without an authenticating platform sender (gremion#6).',
    )
  }
  return {
    host: `mail.${domain}`,
    port: 587,
    from: `no-reply@${domain}`,
    user: `platform@${domain}`,
    password,
  }
}

/** The Keycloak smtpServer representation (all values are strings). ONE source
 *  of truth: the template path substitutes exactly these values, and the
 *  Admin-API delta for an existing realm PUTs exactly this object.
 *  TLS: spec A §I requires TLS on every transport. RealmRepresentation carries
 *  no `requireTLS` field — `starttls` and `ssl` are the only TLS keys it has, so
 *  they are the carrier: 465 is the one implicit-TLS port, and every other port
 *  must negotiate STARTTLS.
 *  `fromDisplayName` is the literal platform identity (D-02 keeps per-vertical
 *  wording in verticals/<id>/, not in env); it becomes a B14 env key only if the
 *  operator later asks for it. */
export function smtpServerBlock(smtp: RealmSmtpSettings): Record<string, string> {
  if (!Number.isInteger(smtp.port) || smtp.port <= 0 || smtp.port > 65535) {
    throw new Error(`realm-doc: refusing a non-port SMTP port "${String(smtp.port)}" (gremion#6)`)
  }
  const implicitTls = smtp.port === 465
  return {
    host: smtp.host,
    port: String(smtp.port),
    from: smtp.from,
    fromDisplayName: 'Gremion',
    auth: 'true',
    user: smtp.user,
    password: smtp.password,
    starttls: implicitTls ? 'false' : 'true',
    ssl: implicitTls ? 'true' : 'false',
  }
}

/** FAIL CLOSED: the base template opens both email paths
 *  (loginWithEmailAllowed realm-export.base.json:7, resetPasswordAllowed :9). A
 *  realm stamped with those and no working sender locks every user of a fresh
 *  tenant out with no recovery path, so refuse loudly instead (gremion#6). */
export function assertSmtpConfiguredForEmailLogin(
  doc: RealmDoc,
  smtp: RealmSmtpSettings | undefined,
): void {
  if (doc.loginWithEmailAllowed !== true && doc.resetPasswordAllowed !== true) return
  const missing = (['host', 'from', 'user', 'password'] as const).filter(
    (k) => !smtp || typeof smtp[k] !== 'string' || smtp[k].trim() === '',
  )
  if (missing.length > 0) {
    throw new Error(
      `realm-doc: refusing to provision realm "${doc.realm}" — ` +
        'loginWithEmailAllowed/resetPasswordAllowed are on but the platform SMTP settings are unset ' +
        `(missing: ${missing.join(', ')}). See gremion#6.`,
    )
  }
}

/** The §T.4 / §T.5 post-condition: the provisioner is the ONLY consumer of the
 *  base template now that the Keycloak boot import and
 *  substitute-realm-secrets.sh are gone, so an unresolved sentinel would be
 *  stamped into a live realm verbatim. */
export function assertNoTemplateSentinels(doc: RealmDoc): void {
  const hits = [...new Set(JSON.stringify(doc).match(TEMPLATE_SENTINEL_PATTERN) ?? [])]
  if (hits.length > 0) {
    throw new Error(
      `realm-doc: refusing to emit realm "${doc.realm}" — ${hits.length} unresolved ` +
        `template sentinel(s) survived composition: ${hits.join(', ')}`,
    )
  }
}

/** Deep string substitution over the composed doc. Runs BEFORE the host swap so
 *  __APEX_DOMAIN__ becomes the real apex and swapHost can then rewrite it to the
 *  tenant host; idempotent for a caller that already resolved it at read time. */
function substituteSentinels(value: unknown, table: Record<string, string>): unknown {
  if (typeof value === 'string') {
    let out = value
    for (const [sentinel, replacement] of Object.entries(table)) {
      if (out.includes(sentinel)) out = out.split(sentinel).join(replacement)
    }
    return out
  }
  if (Array.isArray(value)) return value.map((v) => substituteSentinels(v, table))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteSentinels(v, table)
    }
    return out
  }
  return value
}

/**
 * TASK-043b F3: the gremion-admin service-account user of the import carries
 * GREMION_ADMIN_SA_REALM_ROLES under realm-management (merged into whatever the
 * base already lists; added when the base has no such user). Only when the doc
 * carries the gremion-admin client: a user for an absent client fails the import.
 */
function carryAdminSaRoles(doc: RealmDoc): void {
  const clients = (doc.clients ?? []) as Array<{ clientId?: string }>
  if (!clients.some((c) => c.clientId === ADMIN_CLIENT_ID)) return
  const users = (Array.isArray(doc.users) ? doc.users : []) as Array<Record<string, unknown>>
  let sa = users.find((u) => u.serviceAccountClientId === ADMIN_CLIENT_ID)
  if (!sa) {
    sa = { username: `service-account-${ADMIN_CLIENT_ID}`, enabled: true, serviceAccountClientId: ADMIN_CLIENT_ID }
    users.push(sa)
  }
  const clientRoles = { ...((sa.clientRoles && typeof sa.clientRoles === 'object' ? sa.clientRoles : {}) as Record<string, unknown>) }
  const held = Array.isArray(clientRoles['realm-management']) ? (clientRoles['realm-management'] as unknown[]).filter((r): r is string => typeof r === 'string') : []
  clientRoles['realm-management'] = [...new Set([...held, ...GREMION_ADMIN_SA_REALM_ROLES])]
  sa.clientRoles = clientRoles
  doc.users = users
}

export function buildTenantRealmDoc(input: BuildTenantRealmDocInput): RealmDoc {
  const { base, manifests, config, realmName, tenantHost, apexDomain, clientSecrets, smtp } = input

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

  // (1b) gremion#6 / §T.4 — the provisioner is now the ONLY consumer of the base
  // template (the Keycloak boot import and substitute-realm-secrets.sh are gone),
  // so every __…__ sentinel is filled HERE, in the same pass that swaps the realm
  // name and the authority. __APEX_DOMAIN__ is resolved BEFORE swapHost so the
  // apex authority is real by the time the tenant-host swap runs.
  if (smtp === null) {
    // TASK-043: no sender until the host stamps the customer's own principal.
    delete (composed as Record<string, unknown>).smtpServer
  } else {
    assertSmtpConfiguredForEmailLogin(composed, smtp)
  }
  const resolved = substituteSentinels(composed, {
    __APEX_DOMAIN__: apexDomain,
    ...(smtp === null
      ? {}
      : Object.fromEntries(Object.entries(smtpServerBlock(smtp)).map(([k, v]) => [`__SMTP_${k.toUpperCase()}__`, v]))),
  }) as RealmDoc
  if (smtp !== null) resolved.smtpServer = smtpServerBlock(smtp)

  // (2) per-tenant realm identity + sslRequired:'all' literal (#139).
  resolved.realm = realmName
  resolved.sslRequired = 'all'

  // (D) role-vocab guard — refuse a divergent config.roles override BEFORE we
  // emit a realm whose tokens would silently miss the tenant's custom roles.
  assertRoleVocabularyCarried(config.roles, resolved)

  // (2b) host swap across the whole doc (redirect URIs / web-origins /
  // post-logout attributes) — exact shapes preserved, apex authority -> tenant.
  const hostSwapped = swapHost(resolved, apexDomain, tenantHost) as RealmDoc

  // (2c) #240 (B/C): a PROVISIONED realm carries ONLY tenant-host http(s) URIs —
  // drop every foreign-host (e.g. the relic stura.example.org, were it ever reintroduced)
  // and localhost dev URI from every client. Custom mobile schemes survive.
  for (const client of (hostSwapped.clients ?? []) as Array<Record<string, unknown>>) {
    restrictClientUris(client, tenantHost)
    // TASK-043 Q11: the native client's ONE redirect, the reversed platform domain.
    if (client.clientId === 'gremion-mobile') client.redirectUris = [mobileRedirectUri(apexDomain)]
  }

  // (2d) TASK-043 r4 (PRD-IDN-005, Q16): the realm's frontendUrl is the
  // customer's own host. Keycloak runs with no --hostname, so without it every
  // link it mails (the first administrators' execute-actions invitation) is
  // built from the address the ADMIN call used -- https://keycloak:8443, which
  // no administrator can open (measured on keycloak 26.6.1). Derived from the
  // issuer, so the two can never disagree.
  const attrs = (hostSwapped as Record<string, unknown>).attributes
  ;(hostSwapped as Record<string, unknown>).attributes = {
    ...(attrs && typeof attrs === 'object' ? (attrs as Record<string, unknown>) : {}),
    frontendUrl: frontendUrlFor(tenantHost, realmName),
  }

  // (2e) TASK-043b F3: the gremion-admin SA's realm-management roles ride in
  // the IMPORT. Measured on keycloak:26.6.1: the create-realm-only provisioner
  // is refused (403) mapping realm-admin over the Admin API -- Keycloak lets
  // only a master `admin` map that role -- but a realm it creates with
  // users[].clientRoles carrying realm-admin comes up with exactly that
  // mapping. So no master admin credential is needed to create a customer.
  carryAdminSaRoles(hostSwapped)

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

  // (5) §T.4/§T.5 post-condition: zero __…__ survives composition.
  assertNoTemplateSentinels(hostSwapped)
  return hostSwapped
}
