// gremion-public/src/lib/server/portal-absent.ts
//
// An instance whose public portal is not set up has nothing to show. That is a
// clean "no portal" answer (404 with a marker header), not a failure of the
// program: a monitor that asks for the portal must be able to tell it from a
// portal that is broken (5xx).
//
// The portal reads one database, named by the host (PUBLIC_PORTAL_DB_NAME). On a
// pooled install that name is known only after the tenant exists; until the host
// names it, the portal reads the install's default database, which carries no
// portal tables. That query fails with "relation does not exist" (or "database
// does not exist"). Only that failure, only while the host did not name the
// portal database, and for a missing relation only after one more query shows that
// the database holds none of the portal tables, is taken for "no portal". Any other
// failure, one missing table beside an existing one (a migration broke the schema),
// and the same failure on a database the host DID name, stays a failure.
import { error } from '@sveltejs/kit';

/** Response header that marks the clean "no portal" answer; read by the CD probe. */
export const PORTAL_ABSENT_HEADER = 'x-gremion-portal';
export const PORTAL_ABSENT_VALUE = 'none';

/** What the 404 page says (German, like the neighbouring strings). */
export const PORTAL_ABSENT_MESSAGE = 'Für diese Instanz ist kein öffentliches Portal eingerichtet.';

/** The portal database holds no portal tables, or does not exist, and was not named. */
export class PortalAbsentError extends Error {
  constructor() {
    super('portal database absent');
    this.name = 'PortalAbsentError';
  }
}

function pgCode(err: unknown): unknown {
  if (typeof err !== 'object' || err === null) return undefined;
  return (err as { code?: unknown }).code;
}

/** Postgres 42P01 undefined_table. One query's word only: see public-db.ts for the confirmation. */
export function isMissingRelation(err: unknown): boolean {
  return pgCode(err) === '42P01';
}

/** Postgres 3D000 invalid_catalog_name: the database itself does not exist. */
export function isMissingDatabase(err: unknown): boolean {
  return pgCode(err) === '3D000';
}

/** Either failure: the portal database may be absent (a candidate, not yet a verdict). */
export function isPortalDatabaseAbsent(err: unknown): boolean {
  return isMissingRelation(err) || isMissingDatabase(err);
}

/**
 * Run a portal read; an absent portal becomes a 404 and marks the request (the
 * hook adds the header). Every other failure passes through unchanged.
 */
export async function orNoPortal<T>(locals: App.Locals, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof PortalAbsentError) {
      locals.portalAbsent = true;
      error(404, PORTAL_ABSENT_MESSAGE);
    }
    throw err;
  }
}
