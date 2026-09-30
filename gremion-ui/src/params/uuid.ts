// F1-FIX-01 (H03): a Keycloak id is always a UUID. The same predicate serves as
// a SvelteKit param matcher (`[id=uuid]`) and as the handler-level guard for
// routes that forward `params.id` to the Keycloak admin API. SvelteKit passes
// handlers the DECODED param, so `..%2Fclients` arrives as `../clients`; a
// strict UUID match rejects it (and every other path-shaped value).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

export function match(param: string): boolean {
  return isUuid(param)
}
