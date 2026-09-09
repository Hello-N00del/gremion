// Server-generated error reference id for the 500 error page (v5 Task 4.4).
//
// Prototype ref: screens.jsx:746-790 — an unexpected (500) error surfaces a
// short "Referenz ERR-XXXXXX" the user can quote to the IT team. The id is
// generated server-side in `handleError` (hooks.server.ts) and threaded onto
// the error object so it appears both in the server log and on the rendered
// page — letting ops correlate a user-reported reference to a logged stack.
//
// Format: ERR- followed by exactly six chars from [A-Z0-9] (no lowercase, to
// stay legible when read aloud / over the phone).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

/** Matches a well-formed reference id — exported for the test + UI guards. */
export const ERR_ID_RE = /^ERR-[A-Z0-9]{6}$/

/**
 * Generate a fresh `ERR-XXXXXX` reference. Uses `crypto.getRandomValues`
 * when available (Node 19+/edge) and falls back to `Math.random` so the
 * helper never throws in a constrained runtime — uniqueness here is a
 * correlation convenience, not a security boundary.
 */
export function generateErrId(): string {
  const n = 6
  const out: string[] = []
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto
  if (cryptoObj?.getRandomValues) {
    const buf = new Uint32Array(n)
    cryptoObj.getRandomValues(buf)
    for (let i = 0; i < n; i++) out.push(ALPHABET[buf[i] % ALPHABET.length])
  } else {
    for (let i = 0; i < n; i++) out.push(ALPHABET[Math.floor(Math.random() * ALPHABET.length)])
  }
  return `ERR-${out.join('')}`
}
