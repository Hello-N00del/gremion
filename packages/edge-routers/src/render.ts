// render.ts — the ONE per-tenant router emitter (pure: no fs, no env, no DB).
//
// Ported from StuRaOS gremion-ui/src/lib/server/tenant/provisioner/
// traefik-router.ts (B18) and re-cut to this kernel's edge (brief §5, spec B
// AM-B-07):
//
//   * ONE router per registered host, targeting the COLOUR-BOUND service
//     `app@file`. That service lives in active.yml and is rewritten by
//     gremion-switch; a colour switch therefore never touches a router (TRD-189).
//     The StuRa file's six routers per host (keycloak, keycloak-admin,
//     wellknown, collabora, fallback) are not ported: those are platform/state
//     routers here, not a tenant's.
//   * The chain is `<pin>@file, edge-hsts-custom@docker, edge-ratelimit-app@docker,
//     <per-ip>@file`, PIN FIRST. The pin is a headers middleware that SETS
//     X-Forwarded-Host to the router's own literal host. Traefik only sets that
//     header when it is ABSENT and only strips it from an UNTRUSTED peer, so
//     without the pin a client-supplied X-Forwarded-Host reaches the app and
//     selects whichever tenant registered THAT host. The pin is emitted from the
//     same `host` binding that builds the rule, in the same iteration, so a
//     router and its pin cannot drift apart.
//   * The only middlewares declared in the file are those pins and the tenant's
//     per-IP cap. Everything else is referenced `@docker` from the Traefik
//     container's labels. No secret, no service, no CDN credential is ever
//     written here.
//   * Every router carries `tls.certResolver`. A bare `tls: {}` allocates a
//     non-nil TLS struct, so the router does NOT inherit the entrypoint's
//     resolver and silently serves the default certificate — measured in B18 and
//     the reason gremion-verify fails any public router without a resolver.
//
// NORMALISATION AND RESERVATION ARE PARAMETERS (brief Q3): the package must
// not import gremion-ui, and a second copy of the host normaliser is exactly
// the drift D1 exists to prevent. Because the normaliser is injected, its
// output is NOT trusted: every host is re-checked here against a strict
// rule-safe LDH shape before it is spliced into a backtick-quoted rule and a
// double-quoted YAML scalar. A host that fails it is SKIPPED with the code
// `invalid-host` and reported, never emitted: gremion-ui's real normaliser
// legitimately passes shapes a router must not carry (`localhost`, a leading
// hyphen, an IPv4 literal), and one such registry row must not stop the whole
// fleet's sync (review round 1).
//
// YAML is hand-rendered (brief Q4, no third-party dependency), as the StuRa
// source does; every interpolated value is either a validated slug, a
// validated resolver name, a validated host or a numeric constant.

import { assertSlug, hostPinName, perIpName, routerName } from './names.js'
import { MW_HSTS_CUSTOM, MW_RATELIMIT_APP, PER_IP_INFLIGHT } from './platform-middlewares.js'

/** The colour-bound service every tenant router targets (classify.ts). */
export const TENANT_SERVICE = 'app@file'
/** Tenant routers sit below every platform/state router on the same host. */
export const TENANT_ROUTER_PRIORITY = 10

export interface TenantDomain {
  readonly host: string
}

export interface HostPolicy {
  /** gremion-ui's normaliseHost (or an equivalent): null means reject. */
  readonly normaliseHost: (raw: string) => string | null
  /** gremion-ui's isReservedPlatformHost bound to PLATFORM_DOMAIN. */
  readonly isReservedHost: (host: string) => boolean
}

export interface RenderTenantRouterInput extends HostPolicy {
  readonly slug: string
  readonly domains: readonly TenantDomain[]
  /** TRAEFIK_CERT_RESOLVER. Mandatory: an emitted router without one fails verify. */
  readonly certResolver: string
  /**
   * TASK-043 Q16 (G9): the customer's issuer is https://<host>/auth/realms/<realm>
   * on its OWN primary host, so that host also needs a Keycloak router — for
   * that realm's namespace and the shared static resources ONLY, never
   * /auth/admin, never another realm. Omitted: no Keycloak router (the
   * TASK-034 shape, byte for byte).
   */
  readonly keycloak?: { readonly realm: string; readonly host: string }
}

/** The service the apex Keycloak router uses (docker-compose.prod.yml `keycloak` router). */
export const KEYCLOAK_SERVICE = 'keycloak@docker'
/** Above the tenant app router (10) on the same host, like the apex Keycloak router. */
export const KEYCLOAK_ROUTER_PRIORITY = 100

/** `tenant-<slug>-kc`: never a `-<i>` host index, so it cannot collide with a host router. */
export function keycloakRouterName(slug: string): string {
  return `${routerName(slug, 0)}-kc`
}

/**
 * Why a host got no router. Machine-readable so a caller can tell a reserved
 * platform name (refused by policy) from a malformed row.
 */
export type RouterSkipCode = 'invalid-host' | 'reserved'

export interface RouterSkip {
  readonly host: string
  readonly code: RouterSkipCode
  readonly reason: string
}

export interface EmittedRouter {
  readonly name: string
  readonly host: string
  /** The pin's bare name (declared in this file, chained as `<pin>@file`). */
  readonly pin: string
  readonly chain: readonly string[]
}

export interface RenderTenantRouterResult {
  /** The document to write, or null when no host survived (the file is removed). */
  readonly yaml: string | null
  /** Hosts that got a router, normalised and sorted. */
  readonly hosts: readonly string[]
  readonly routers: readonly EmittedRouter[]
  /** Hosts deliberately not routed. The caller MUST surface these. */
  readonly skipped: readonly RouterSkip[]
  /** TASK-043 Q16: the realm router on the issuer host, or null when not asked for. */
  readonly keycloakRouter?: EmittedRouter | null
}

/** A Traefik resolver name: what the compose labels accept, nothing else. */
const RESOLVER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

/** A rule-safe host: LDH labels, no leading/trailing hyphen, 1-63 per label. */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * A host a tenant router may carry: two or more LDH labels, and a top-level
 * label that is not all digits — so no IPv4 literal (a tenant registering the
 * edge's own address would capture every request addressed by bare IP).
 */
export function isRuleSafeHost(host: string): boolean {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) return false
  const labels = host.split('.')
  const tld = labels[labels.length - 1] ?? ''
  return labels.length >= 2 && labels.every((l) => LABEL_RE.test(l)) && /[a-z]/.test(tld)
}

export function assertCertResolver(value: unknown): string {
  if (typeof value !== 'string' || !RESOLVER_RE.test(value)) {
    throw new Error(
      `renderTenantRouter: certResolver ${JSON.stringify(value)} is not a usable Traefik resolver name ` +
        '(letters, digits, dot, dash, underscore; non-empty). An emitted router without a resolver ' +
        'serves the default certificate and fails gremion-verify.',
    )
  }
  return value
}

/**
 * The header every emitted file carries. Generic on purpose: the committed
 * template is the render for the fixture tenant `example`, byte for byte.
 */
export const HEADER = `# tenant-<slug>.yml — GENERATED by @gremion/edge-routers (renderTenantRouter).
# Do not edit by hand: the next syncTenantRouters run overwrites it.
# infra/host/templates/edge/tenant-router.example.yml is this render for the
# fixture tenant "example", byte for byte (packages/edge-routers/test).
#
# One tenant, one file in etc/edge/ under the Gremion root, one router per host:
#
#   1. every router targets the COLOUR-BOUND service app@file, which lives in
#      active.yml and is rewritten by gremion-switch — so a colour switch never
#      rewrites a router (TRD-189);
#   2. the chain is the tenant's own host pin FIRST, then edge-hsts-custom and
#      edge-ratelimit-app (declared on the Traefik container's labels, @docker,
#      the one container that exists whenever a router does), then the tenant's
#      per-IP in-flight cap. The pin SETS X-Forwarded-Host to the router's own
#      literal host, so a client-supplied value never reaches the app;
#   3. the only middlewares declared here are that pin (edge-hostpin-<slug>,
#      then -<i> for each further host) and edge-perip-<slug>. No service, no
#      secret and no platform middleware is ever declared in this file;
#   4. every router carries a certResolver: gremion-verify fails any public
#      router without one, and a bare \`tls: {}\` silently serves the default
#      certificate.
`

export function renderTenantRouter(input: RenderTenantRouterInput): RenderTenantRouterResult {
  const slug = assertSlug(input.slug, 'renderTenantRouter')
  const certResolver = assertCertResolver(input.certResolver)
  if (!Array.isArray(input.domains)) throw new Error('renderTenantRouter: domains must be an array')
  const { normaliseHost, isReservedHost } = input

  const skipped: RouterSkip[] = []
  const seen = new Set<string>()
  for (const d of input.domains) {
    const raw = typeof d?.host === 'string' ? d.host : String(d?.host)
    const host = typeof d?.host === 'string' ? normaliseHost(d.host) : null
    if (!host) {
      skipped.push({ host: raw, code: 'invalid-host', reason: 'not a valid host (the normaliser rejected it)' })
      continue
    }
    if (!isRuleSafeHost(host)) {
      skipped.push({
        host,
        code: 'invalid-host',
        reason: 'not rule-safe after normalisation (two or more lowercase LDH labels, a non-numeric top label)',
      })
      continue
    }
    if (isReservedHost(host)) {
      skipped.push({ host, code: 'reserved', reason: 'a reserved platform host — never a tenant router' })
      continue
    }
    seen.add(host)
  }

  const hosts = [...seen].sort()
  if (hosts.length === 0) return { yaml: null, hosts, routers: [], skipped }

  const perIp = perIpName(slug)
  const routers: EmittedRouter[] = hosts.map((host, i) => {
    const pin = hostPinName(slug, i)
    return {
      name: routerName(slug, i),
      host,
      pin,
      chain: [`${pin}@file`, MW_HSTS_CUSTOM, MW_RATELIMIT_APP, `${perIp}@file`],
    }
  })

  let kc: EmittedRouter | null = null
  let kcRealm = ''
  if (input.keycloak !== undefined) {
    const realm = assertSlug(input.keycloak?.realm, 'renderTenantRouter keycloak.realm')
    const kcHost = typeof input.keycloak.host === 'string' ? normaliseHost(input.keycloak.host) : null
    const owner = routers.find((r) => r.host === kcHost)
    if (!owner) {
      throw new Error(`renderTenantRouter: keycloak.host ${JSON.stringify(input.keycloak.host)} is not one of this tenant's routed hosts [${hosts.join(', ')}]`)
    }
    kc = { name: keycloakRouterName(slug), host: owner.host, pin: owner.pin, chain: owner.chain }
    kcRealm = realm
  }

  const out: string[] = [HEADER.trimEnd(), 'http:', '  routers:']
  for (const r of routers) {
    out.push(
      `    ${r.name}:`,
      '      entryPoints: ["websecure"]',
      `      rule: "Host(\`${r.host}\`)"`,
      `      service: "${TENANT_SERVICE}"`,
      `      priority: ${TENANT_ROUTER_PRIORITY}`,
      '      middlewares:',
      ...r.chain.map((m) => `        - "${m}"`),
      '      tls:',
      `        certResolver: "${certResolver}"`,
    )
  }
  if (kc) {
    out.push(
      `    ${kc.name}:`,
      '      entryPoints: ["websecure"]',
      `      rule: "Host(\`${kc.host}\`) && (PathPrefix(\`/auth/realms/${kcRealm}/\`) || PathPrefix(\`/auth/resources/\`))"`,
      `      service: "${KEYCLOAK_SERVICE}"`,
      `      priority: ${KEYCLOAK_ROUTER_PRIORITY}`,
      '      middlewares:',
      ...kc.chain.map((m) => `        - "${m}"`),
      '      tls:',
      `        certResolver: "${certResolver}"`,
    )
  }
  out.push('  middlewares:')
  for (const r of routers) {
    out.push(
      `    ${r.pin}:`,
      '      headers:',
      '        customRequestHeaders:',
      `          X-Forwarded-Host: "${r.host}"`,
    )
  }
  out.push(
    `    ${perIp}:`,
    '      inFlightReq:',
    `        amount: ${PER_IP_INFLIGHT}`,
    '        sourceCriterion:',
    '          ipStrategy:',
    '            depth: 0',
    '',
  )
  return { yaml: out.join('\n'), hosts, routers, skipped, keycloakRouter: kc }
}
