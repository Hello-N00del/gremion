import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ url, locals }) => {
  const raw = url.searchParams.get('returnTo') ?? '/'
  // Open-redirect guard: same rule as the login page's getSafeCallbackUrl().
  // Accept any same-origin absolute path; reject protocol-relative URLs like
  // //evil.com and any value that does not start with a leading slash.
  const returnTo = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/'
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
