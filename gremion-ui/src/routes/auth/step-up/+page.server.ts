import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ url }) => {
  const raw = url.searchParams.get('returnTo') ?? '/'
  // Open-redirect guard: same rule as the login page's getSafeCallbackUrl().
  // Accept any same-origin absolute path; reject protocol-relative URLs like
  // //evil.com and any value that does not start with a leading slash.
  const returnTo = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/'
  return { returnTo }
}
