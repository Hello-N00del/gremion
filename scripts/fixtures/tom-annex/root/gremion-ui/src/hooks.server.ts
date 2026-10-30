export const CSP_HEADER_VALUE = "frame-ancestors 'self'"
export const NON_PAGE_CSP_HEADER_VALUE = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "frame-ancestors 'self'",
].join('; ')
export const cspGuard = async () => {
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  if (html) {
    response.headers.set('Cache-Control', 'no-store')
  }
}
