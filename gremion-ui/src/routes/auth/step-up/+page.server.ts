import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ url, locals }) => {
  const raw = url.searchParams.get('returnTo') ?? '/'
  // Open-redirect guard. returnTo is the notice's "Zurück" link href, so the leading-slash rule is
  // not enough: the URL parser reads `/\evil.com` (and tab variants) as //evil.com. Accept only a
  // value that resolves on this origin, and hand back its path.
  const returnTo = sameOriginPath(raw, url.origin)
  // OTP-or-deny: the realm's step-up flow refuses a user who has no second factor (it never
  // enrols one inside the step-up), and the gremion login theme's error page sends that refusal
  // here as ?error=no-second-factor. The page then shows the notice instead of bouncing into
  // Keycloak again.
  const secondFactorMissing = url.searchParams.get('error') === 'no-second-factor'
  // The Keycloak account console of the REQUEST tenant's realm (the settings page's "Konto"
  // link, same derivation); null hides the link.
  const base = (locals.tenant?.authExternalBase ?? '').replace(/\/$/, '')
  const accountUrl = base ? `${base}/account` : null
  return { returnTo, secondFactorMissing, accountUrl }
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 0x20) return true
  return false
}

function sameOriginPath(raw: string, origin: string): string {
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || hasControlChar(raw)) return '/'
  try {
    const u = new URL(raw, origin)
    const path = `${u.pathname}${u.search}${u.hash}`
    // Check what is returned, not only the input: dot-segment removal can turn a single-slash
    // input into a protocol-relative path.
    return u.origin === origin && !path.startsWith('//') ? path : '/'
  } catch {
    return '/'
  }
}
