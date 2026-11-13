import type { PageServerLoad } from './$types'
import { sameOriginPath } from '$lib/safe-redirect'

export const load: PageServerLoad = async ({ url }) => {
  // Open-redirect guard. returnTo is the notice's "Zurück" link href, so the leading-slash rule is
  // not enough: the URL parser reads `/\evil.com` (and tab variants) as //evil.com. Accept only a
  // same-origin path after normalisation (shared helper), and hand back that path.
  const returnTo = sameOriginPath(url.searchParams.get('returnTo'))
  // OTP-or-deny: the realm's step-up flow refuses a user who has no second factor (it never
  // enrols one inside the step-up), and the gremion login theme's error page sends that refusal
  // here as ?error=no-second-factor. The page then shows the notice instead of bouncing into
  // Keycloak again.
  const secondFactorMissing = url.searchParams.get('error') === 'no-second-factor'
  return { returnTo, secondFactorMissing }
}
