// Input-validation helpers for the public (anonymous, internet-facing) portal.
// #262 D5: anonymous requests previously fed unvalidated query/route params
// straight into SQL `::uuid` casts and numeric OFFSET/year params, turning
// garbage input (?seite=abc, ?ausschuss=x, /protokolle/not-a-uuid,
// ?jahr=99999999999) into unhandled Postgres 500s. These guards normalise the
// input BEFORE it reaches the DB so bad input yields a clean 400/404 (or a safe
// default) instead of a stack-trace-shaped log flood.

// Canonical RFC 4122 UUID shape (any version/variant). The portal only ever
// receives UUIDs that originate from our own DB, so a strict syntactic check is
// enough to keep non-UUID text out of a `::uuid` cast.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True iff `s` is a syntactically valid UUID string. */
export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s)
}

/**
 * Parse a 1-based page number from a raw query value, clamping to a safe
 * positive integer. A missing / non-numeric / out-of-range value falls back to
 * page 1 (never NaN, which would interpolate into `OFFSET NaN`). An optional
 * `max` upper-bounds the page so a huge `?seite=` cannot request an absurd
 * offset.
 */
export function parsePage(raw: string | null, max = 100_000): number {
  const n = parseInt(raw ?? '1', 10)
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(Math.floor(n), max)
}

/**
 * Parse a 4-digit-ish calendar year from a raw query value, clamping to a sane
 * range so `?jahr=99999999999` never produces an Invalid Date. Falls back to
 * `fallback` for a missing / non-numeric / out-of-range value.
 */
export function parseYear(raw: string | null, fallback: number): number {
  const n = parseInt(raw ?? '', 10)
  if (!Number.isFinite(n) || n < 1970 || n > 9999) return fallback
  return n
}
