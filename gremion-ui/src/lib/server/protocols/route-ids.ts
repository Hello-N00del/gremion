// R30-F1-PROTO-K (kernel twin of R30-F1-PROTO-S): route-id guard for
// /api/protocols/**. Protocol, resolution, action-item and challenge ids are
// Postgres uuid columns; an id that is not a UUID (the P1 e2e race requested
// /api/protocols/protokolle) reaches the driver, which rejects it with SQLSTATE
// 22P02 and SvelteKit answers 500. A malformed id is a client error: refuse it
// with 400 before any query runs. Same convention as F1-FIX-01 (isUuid from
// params/uuid, explicit check in the handler).
import { error } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'
import { isUuid } from '../../../params/uuid'

/** Throws 400 unless every named route param is a canonical UUID. Call it after
 *  the auth checks (so an anonymous caller still gets 401/403) and before the
 *  body is parsed or any database access. */
export function requireUuidParams(event: RequestEvent, ...names: string[]): void {
  const params = event.params as Record<string, string | undefined>
  for (const name of names) {
    if (!isUuid(params[name])) throw error(400, 'Ungültige Kennung')
  }
}
