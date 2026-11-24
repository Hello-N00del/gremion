// Route-id parsing for /api/newsletter/**. Newsletter, list and member ids are
// positive integers. `parseInt` is not a validator: it reads the leading digits of
// any string ("0abc" -> 0, "1abc" -> 1, "-3" -> -3), so a malformed id either
// named the wrong row or reached the leaf, which refuses an id <= 0 with a 400
// that surfaced as a 500. Accept only plain decimal digits that fit a safe integer.

const POSITIVE_INTEGER = /^[1-9][0-9]{0,15}$/

/** The id as a number, or null when the route segment is not a positive integer. */
export function parseRouteId(raw: unknown): number | null {
  if (typeof raw !== 'string' || !POSITIVE_INTEGER.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : null
}
