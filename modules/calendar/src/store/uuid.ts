// A malformed id names nothing. The id columns are uuid, and the driver rejects any other text
// with SQLSTATE 22P02, which the route would answer with 500. Lookups by id answer "not found"
// for a value that cannot be an id, without a query.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}
