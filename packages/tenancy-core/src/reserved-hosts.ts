// packages/tenancy-core/src/reserved-hosts.ts (TASK-077 G6: moved from
// gremion-ui/src/lib/server/tenant/reserved-hosts.ts, now a re-export; body unchanged)
// Spec A §C / §H.2 — the platform-reserved names under PLATFORM_DOMAIN. None
// may ever be a tenant host. This is the ONE module that owns the list: the
// normaliser lives in ./host.ts and imports nothing from here.
//
// The refusal lives on registry.addTenantDomain (spec B §T.1), BEFORE any DNS
// pre-flight: the pre-flight asks "does this name point at us?", which is
// exactly TRUE for every name below, so it can never catch them.
//
// Checked on BOTH the raw (trimmed, lowercased) candidate and on the
// normaliseHost output, returning the SAME named error either way. The raw
// check is what catches `_dmarc.<apex>`, whose underscore host.ts:43 rejects
// outright — without it that one name would be refused with a "not a valid
// host" message and never reach this list at all.
//
// The eight labels are the same list an operator sees as RESERVED_HOSTS at
// infra/host/templates/env/state.env.tmpl:69; reserved-hosts.test.ts asserts
// the two are equal.
//
// The control panel's own host (CONTROL_PANEL_HOST, which may lie OUTSIDE the platform
// domain) is reserved the same way: callers pass controlPanelHosts(env) as the third
// argument, read from the environment next to PLATFORM_DOMAIN.
//
// PURE: no I/O, no env, no DB. The apex is passed in so this stays testable and
// so B18's router emitter can call it with the same value the assembler wrote.

/** The eight reserved LABELS; the apex itself is the ninth reserved name. */
export const RESERVED_PLATFORM_LABELS: readonly string[] = Object.freeze([
  'www', 'control', 'rs1', 'mail', 'mta-sts', 'autoconfig', 'autodiscover', '_dmarc',
])

/** The environment values the control panel's host is read from, passed as data (nothing is read from process.env here). */
export interface ControlPanelEnv {
  PLATFORM_DOMAIN?: string | undefined
  /** state.env: the panel's own host; empty or absent means control.<PLATFORM_DOMAIN>, which is already a reserved label. */
  CONTROL_PANEL_HOST?: string | undefined
  /** The opt-in origin (https://<control host>), which names the same host. */
  CONTROL_PANEL_ORIGIN?: string | undefined
}

/** The spellings host.ts collapses: trimmed, lowercased, one trailing FQDN dot dropped. */
function hostSpelling(v: string | undefined): string {
  return typeof v === 'string' ? v.trim().toLowerCase().replace(/\.$/, '') : ''
}

/**
 * The names the control panel is served on beyond control.<PLATFORM_DOMAIN> (already a reserved label):
 * CONTROL_PANEL_HOST when set (the shell resolver's rule: it may lie OUTSIDE the platform domain), and the
 * host of CONTROL_PANEL_ORIGIN, which gremion-render pins to the same name. Both are read so that an
 * install whose app env carries only the origin is refused too. A customer host equal to one of them
 * would be routed to the customer instead of the panel. Empty when neither is set.
 */
export function controlPanelHosts(env: ControlPanelEnv): readonly string[] {
  const out: string[] = []
  const host = hostSpelling(env.CONTROL_PANEL_HOST)
  if (host) out.push(host)
  const origin = (env.CONTROL_PANEL_ORIGIN ?? '').trim()
  if (origin) {
    try {
      const h = hostSpelling(new URL(origin).hostname)
      if (h && !out.includes(h)) out.push(h)
    } catch {
      // not an origin: gremion-render and the panel's own config check refuse it; nothing to reserve here
    }
  }
  return out
}

/**
 * The one question every path that binds a host to a customer asks, built from the environment those
 * processes already carry next to PLATFORM_DOMAIN: is this host reserved for the platform, or is it the
 * control panel's own host? Throws when PLATFORM_DOMAIN is unset (an empty reserved set is never computed).
 */
export function reservedHostCheck(env: ControlPanelEnv): (host: string) => boolean {
  const platformDomain = env.PLATFORM_DOMAIN ?? ''
  const controlHosts = controlPanelHosts(env)
  reservedPlatformHosts(platformDomain, controlHosts) // fail closed now, not at the first call
  return (host) => isReservedPlatformHost(host, platformDomain, controlHosts)
}

/**
 * The nine reserved names for a given PLATFORM_DOMAIN, apex first, then each control panel host
 * (controlPanelHosts) that is not one of them already.
 */
export function reservedPlatformHosts(platformDomain: string, controlHosts: readonly string[] = []): readonly string[] {
  const apex = platformDomain.trim().toLowerCase().replace(/\.$/, '')
  if (!apex) {
    throw new Error(
      'reservedPlatformHosts: PLATFORM_DOMAIN is unset — refusing to compute an empty reserved set',
    )
  }
  const names = [apex, ...RESERVED_PLATFORM_LABELS.map((l) => `${l}.${apex}`)]
  for (const h of controlHosts) {
    const c = hostSpelling(h)
    if (c && !names.includes(c)) names.push(c)
  }
  return names
}

/**
 * Is `candidate` one of the nine, or a control panel host? Compared as a literal string against the set,
 * after trimming, lowercasing, stripping one trailing FQDN dot and a numeric
 * port suffix — the same spellings host.ts collapses, done here without
 * re-implementing the normaliser (there is exactly one of those).
 */
export function isReservedPlatformHost(candidate: string, platformDomain: string, controlHosts: readonly string[] = []): boolean {
  if (typeof candidate !== 'string') return false
  let c = candidate.trim().toLowerCase()
  c = c.replace(/:[0-9]{1,5}$/, '')
  c = c.replace(/\.$/, '')
  return reservedPlatformHosts(platformDomain, controlHosts).includes(c)
}
