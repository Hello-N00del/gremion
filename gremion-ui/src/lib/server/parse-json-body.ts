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

/**
 * Read and JSON-parse the request body, returning `null` if the body is not
 * valid JSON (or is absent). Never throws on a parse error.
 */
export async function parseJsonBody(request: Request): Promise<unknown> {
  return request.json().catch(() => null)
}
