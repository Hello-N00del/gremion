// Shared JSON body parser for mutation handlers (#262 D2).
//
// A bare `await request.json()` throws a SyntaxError on a malformed body (or a
// wrong content type), which bubbles into an unexpected 500 + ERR-id and
// pollutes the 500-class error log. This helper swallows that parse error and
// returns `null` instead, so callers can run the same `schema.safeParse(...)`
// flow and answer a clean 400 — matching the board-route pattern
// (`schema.safeParse(await request.json().catch(() => null))`).
//
// It does NOT validate the shape: pass the result to your Zod schema's
// `safeParse` (or do your own narrowing) exactly as before. The success path is
// unchanged; only the malformed-input path now yields `null` rather than throwing.
//
// CSRF defence in depth: the body must be declared `application/json` (or a
// `+json` type), else 415. A cross-site form or `text/plain` request cannot set
// that type without a CORS preflight, which the app never grants. The primary
// control is csrfOriginGuard in the hook chain.

import { error } from '@sveltejs/kit'

function isJsonContentType(value: string | null): boolean {
  if (!value) return false
  const type = value.split(';')[0].trim().toLowerCase()
  return type === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(type)
}

/**
 * Read and JSON-parse the request body, returning `null` if the body is not
 * valid JSON (or is absent). Throws a 415 if the Content-Type is not JSON.
 */
export async function parseJsonBody(request: Request): Promise<unknown> {
  if (!isJsonContentType(request.headers.get('content-type'))) {
    error(415, 'Content-Type must be application/json')
  }
  return request.json().catch(() => null)
}
