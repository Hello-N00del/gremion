// Route-id guard for /api/governance/committees/[id]/** and /api/committees/[id]/**.
// Unit and role ids are Postgres uuid columns; an id that is not a UUID would reach
// the driver, which rejects it with SQLSTATE 22P02 and SvelteKit would answer 500.
// A malformed id names nothing, so it answers exactly like a well-formed id nobody
// owns: 404, before any query runs (and so without leaking anything about the
// store). Call it after the auth checks so an anonymous caller still gets 401/403.
import { error, json } from '@sveltejs/kit'
import { isUuid } from '../../../params/uuid'

/** For handlers that answer `{ success: false, error }`: a 404 Response when any
 *  id is not a canonical UUID, else null. */
export function malformedIdResponse(...ids: unknown[]): Response | null {
  if (ids.every(isUuid)) return null
  return json({ success: false, error: 'Not found' }, { status: 404 })
}

/** For handlers that throw SvelteKit errors: 404 unless the id is a canonical UUID. */
export function requireCommitteeId(id: unknown): void {
  if (!isUuid(id)) throw error(404, 'Gremium nicht gefunden')
}

/** For page loads and actions under a protocol URL: 404 unless the id is a canonical UUID. */
export function requireProtocolId(id: unknown): void {
  if (!isUuid(id)) throw error(404, 'Protokoll nicht gefunden')
}
