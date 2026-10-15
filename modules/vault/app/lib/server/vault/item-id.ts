import { error } from '@sveltejs/kit'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * #449: `vault_item.id` is a UUID column and the leaf interpolates the id
 * straight into `WHERE id = ${id}`, so a non-UUID path segment raised a
 * Postgres cast error there. The leaf's catch-all mapped that to 500, and the
 * kernel's client rethrows anything that is not a 404 — so `/api/vault/xyz`
 * answered `500 Internal Error` for what is plainly a malformed request.
 *
 * Validate the shape before any backend call so the caller gets a 400 and the
 * leaf is never asked to parse garbage.
 */
export function assertVaultItemId(id: string | undefined): string {
  if (!id || !UUID_RE.test(id)) throw error(400, 'Ungültige ID')
  return id
}

/** Predicate half, for tests and callers that want to branch rather than throw. */
export function isVaultItemId(id: string | undefined): boolean {
  return !!id && UUID_RE.test(id)
}
