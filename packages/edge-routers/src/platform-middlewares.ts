// platform-middlewares.ts — the middlewares that live on the TRAEFIK
// container's own labels (`@docker`), stated once as data.
//
// Placement (spec B B-09, brief §5): every middleware a router chains is
// declared on the Traefik container, the only container guaranteed to exist
// whenever a router does, EXCEPT the per-tenant host pin and per-IP cap, which
// live in the tenant's own emitted file. An app-tier container disappears on
// every colour switch and would take any middleware declared on it along.
//
// This module does not write labels anywhere. It is the single statement of the
// values so that the emitter's chain, the edge-proto fixture labels and the
// production compose labels can all be asserted against one source. TASK-043c
// landed the HOST-INDEPENDENT half (both HSTS middlewares and the three
// rate-limit tiers) on the traefik service in docker-compose.prod.yml; the
// platform host pins (edge-hostpin-*), the static app/portal routers and the
// retirement of the interim names stay TASK-034's 34b.

/** The HSTS max-age both platform HSTS middlewares send (one year). */
export const HSTS_MAX_AGE_SECONDS = 31536000

/** Rate-limit tiers (spec B §3): average per period, burst, period. */
export const RATE_LIMIT_TIERS = Object.freeze({
  app: Object.freeze({ average: 300, burst: 100, period: '1m' }),
  portal: Object.freeze({ average: 100, burst: 50, period: '1m' }),
  auth: Object.freeze({ average: 30, burst: 10, period: '1m' }),
})
export type RateLimitTier = keyof typeof RATE_LIMIT_TIERS

/** The four platform host pins and the host each one stamps. */
export const PLATFORM_PINS = Object.freeze(['apex', 'www', 'control', 'sales'] as const)
export type PlatformPin = (typeof PLATFORM_PINS)[number]

/** `<name>@docker` references the emitted chain uses. */
export const MW_HSTS_CUSTOM = 'edge-hsts-custom@docker'
export const MW_HSTS_PLATFORM = 'edge-hsts-platform@docker'
export const MW_RATELIMIT_APP = 'edge-ratelimit-app@docker'
/**
 * The edge's shared-secret x-proxy-trust stamp (docker-compose.prod.yml, the
 * interim name TASK-040 Q5; 34b renames it everywhere). gremion-ui 403s any
 * request lacking it once TENANT_PROXY_SHARED_SECRET is set, which the pooled
 * app always does (TASK-043c P1b, Qc3). Chained on the APP router only: the
 * Keycloak router must never receive the app's secret.
 */
export const MW_PROXYTRUST = 'gremion-ui-proxytrust@docker'

/**
 * The per-IP in-flight cap each tenant file declares as `edge-perip-<slug>`.
 * Keyed on the connection address (ipStrategy depth 0), the same keying the
 * rate-limit family uses, so a forged X-Forwarded-For cannot pick the bucket.
 */
export const PER_IP_INFLIGHT = 50

export interface PlatformHosts {
  /** PLATFORM_DOMAIN — the apex. */
  readonly apex: string
  /** The sales site's host. */
  readonly sales: string
}

/**
 * The Traefik-container label set for every platform middleware, as
 * `traefik.http.middlewares.*` keys. `preload` is never set (spec B §3);
 * `edge-hsts-custom` never sends includeSubDomains, because a tenant's own
 * domain is a namespace this platform does not operate. There is deliberately
 * no bare `edge-ratelimit`: every limiter names its tier.
 */
export function platformMiddlewareLabels(hosts: PlatformHosts): Record<string, string> {
  const pinHost: Record<PlatformPin, string> = {
    apex: hosts.apex,
    www: `www.${hosts.apex}`,
    control: `control.${hosts.apex}`,
    sales: hosts.sales,
  }
  const labels: Record<string, string> = {}
  const mw = 'traefik.http.middlewares'
  for (const p of PLATFORM_PINS) {
    labels[`${mw}.edge-hostpin-${p}.headers.customrequestheaders.X-Forwarded-Host`] = pinHost[p]
  }
  labels[`${mw}.edge-hsts-platform.headers.stsseconds`] = String(HSTS_MAX_AGE_SECONDS)
  labels[`${mw}.edge-hsts-platform.headers.stsincludesubdomains`] = 'true'
  labels[`${mw}.edge-hsts-platform.headers.stspreload`] = 'false'
  labels[`${mw}.edge-hsts-custom.headers.stsseconds`] = String(HSTS_MAX_AGE_SECONDS)
  labels[`${mw}.edge-hsts-custom.headers.stsincludesubdomains`] = 'false'
  labels[`${mw}.edge-hsts-custom.headers.stspreload`] = 'false'
  for (const [tier, t] of Object.entries(RATE_LIMIT_TIERS)) {
    labels[`${mw}.edge-ratelimit-${tier}.ratelimit.average`] = String(t.average)
    labels[`${mw}.edge-ratelimit-${tier}.ratelimit.burst`] = String(t.burst)
    labels[`${mw}.edge-ratelimit-${tier}.ratelimit.period`] = t.period
    labels[`${mw}.edge-ratelimit-${tier}.ratelimit.sourcecriterion.ipstrategy.depth`] = '0'
  }
  return labels
}
