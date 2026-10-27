export const CSP_HEADER_VALUE = [
  "default-src 'self'",
  // a comment with a "quoted" word
  "frame-ancestors 'self'",
  "object-src 'none'",
].join('; ')
export const cspGuard = async () => {
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
}
