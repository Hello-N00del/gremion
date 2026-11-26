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
// The base of a SEND is no longer the boot-time value. It is the sending tenant's own
// host, asked of the kernel at the start of every email send (askLinkBase, below) and
// checked with the rules above, so a second customer's subscribers are linked to their
// own host. PUBLIC_BASE_URL is now only read and logged at boot (resolveContentLinkBase).

export type LinkBaseFault = 'missing' | 'malformed' | 'loopback' | 'unspecified'

export type LinkBaseCheck =
  | { usable: true; base: string }
  | { usable: false; fault: LinkBaseFault; reason: string }

export interface LinkBaseOptions {
  /** Local development only: accept a loopback host. */
  allowLoopback?: boolean
  /** What the checked value is called in a reason. Defaults to PUBLIC_BASE_URL, the boot value. */
  subject?: string
}

/** The `detail` of the failed publish result a refused link base returns; the scheduler recognises it. */
export const LINK_BASE_UNUSABLE_DETAIL = 'unusable public base URL'

function classifyHost(hostname: string): 'loopback' | 'unspecified' | null {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h.startsWith('127.')) return 'loopback'
  if (h === '0.0.0.0' || h === '::') return 'unspecified'
  return null
}

/** Check one raw base value. Never throws. */
export function checkLinkBase(raw: string | undefined, opts: LinkBaseOptions = {}): LinkBaseCheck {
  const subject = opts.subject ?? 'PUBLIC_BASE_URL'
  if (raw === undefined || raw.trim() === '') {
    return { usable: false, fault: 'missing', reason: `${subject} is not set` }
  }
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return { usable: false, fault: 'malformed', reason: `${subject} is not an absolute URL` }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { usable: false, fault: 'malformed', reason: `${subject} must be http(s)` }
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '' || url.username !== '') {
    return { usable: false, fault: 'malformed', reason: `${subject} must be a bare origin (no path, query or credentials)` }
  }
  const fault = classifyHost(url.hostname)
  if (fault === 'unspecified' || (fault === 'loopback' && opts.allowLoopback !== true)) {
    return {
      usable: false,
      fault,
      reason: `${subject} resolves to a ${fault} host — a subscriber's mail client cannot reach it`,
    }
  }
  return { usable: true, base: url.origin }
}

/** The one thing askLinkBase needs of the kernel client. */
export interface LinkBaseSource {
  linkBase(): Promise<string | null>
}

/**
 * The link base of ONE send: the sending tenant's own host, asked of the kernel NOW and checked with
 * checkLinkBase. Nothing is kept between calls, so every send is rooted at the host the kernel reports
 * for its own tenant. A tenant the kernel has no host for is `missing`; a kernel that cannot be asked
 * is NOT that, so its failure is thrown: the caller sends nothing and a later attempt asks again.
 */
export async function askLinkBase(kernel: LinkBaseSource, opts: LinkBaseOptions = {}): Promise<LinkBaseCheck> {
  const answered = await kernel.linkBase()
  if (answered === null) {
    return { usable: false, fault: 'missing', reason: 'the kernel has no public host for this tenant' }
  }
  return checkLinkBase(answered, { ...opts, subject: opts.subject ?? 'the kernel link-base answer' })
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
