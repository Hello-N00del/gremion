// services/content/src/link-base.ts
//
// F1-FIX-07 K5#8 / K5#33: the base every unsubscribe link is built from.
//
// The leaf used to read `PUBLIC_BASE_URL ?? 'http://localhost:3000'`, so a
// missing value mailed every subscriber a link into THEIR OWN machine and the
// recipient could not unsubscribe. The publishing leaf already refuses such a
// base (requireUsableLinkBase); leaves are separate packages, so this is the
// content leaf's own copy of the same rule:
//   - required (no default), an absolute http(s) ORIGIN (no path, query, hash);
//   - never a loopback or unspecified host, unless CONTENT_ALLOW_LOOPBACK_LINKS=1
//     (local development only).
// An unusable base fails the email publish BEFORE any recipient is claimed.
//
// Residual (named in F1-FIX-07): the base is still one deployment-global value
// for every tenant; per-tenant origins need the kernel to hand the leaf the
// tenant's public host.

export type LinkBaseFault = 'missing' | 'malformed' | 'loopback' | 'unspecified'

export type LinkBaseCheck =
  | { usable: true; base: string }
  | { usable: false; fault: LinkBaseFault; reason: string }

export interface LinkBaseOptions {
  /** Local development only: accept a loopback host. */
  allowLoopback?: boolean
}

function classifyHost(hostname: string): 'loopback' | 'unspecified' | null {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h)) return 'loopback'
  if (h === '0.0.0.0' || h === '::') return 'unspecified'
  return null
}

/** Check one raw base value. Never throws. */
export function checkLinkBase(raw: string | undefined, opts: LinkBaseOptions = {}): LinkBaseCheck {
  if (raw === undefined || raw.trim() === '') {
    return { usable: false, fault: 'missing', reason: 'PUBLIC_BASE_URL is not set' }
  }
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return { usable: false, fault: 'malformed', reason: 'PUBLIC_BASE_URL is not an absolute URL' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { usable: false, fault: 'malformed', reason: 'PUBLIC_BASE_URL must be http(s)' }
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '' || url.username !== '') {
    return { usable: false, fault: 'malformed', reason: 'PUBLIC_BASE_URL must be a bare origin (no path, query or credentials)' }
  }
  const fault = classifyHost(url.hostname)
  if (fault === 'unspecified' || (fault === 'loopback' && opts.allowLoopback !== true)) {
    return {
      usable: false,
      fault,
      reason: `PUBLIC_BASE_URL resolves to a ${fault} host — a subscriber's mail client cannot reach it`,
    }
  }
  return { usable: true, base: url.origin }
}

/** The subset of the environment the base is resolved from. */
export interface ContentLinkBaseEnv {
  readonly PUBLIC_BASE_URL?: string | undefined
  readonly CONTENT_ALLOW_LOOPBACK_LINKS?: string | undefined
}

/** Resolve the base once from the environment (boot). */
export function resolveContentLinkBase(env: ContentLinkBaseEnv): LinkBaseCheck {
  return checkLinkBase(env.PUBLIC_BASE_URL, { allowLoopback: env.CONTENT_ALLOW_LOOPBACK_LINKS === '1' })
}
