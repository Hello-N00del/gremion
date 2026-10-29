// services/kernel-api/src/bodies/errors.ts -- the domain service's refusals.
// A code is a stable API fact (the HTTP layer maps it); `constraint` names the
// database constraint that refused, when one did (the database is the guard).

export type BodiesErrorCode =
  | 'FORBIDDEN' // the WriteAuthorizer said no (default deny)
  | 'NOT_FOUND'
  | 'INVALID' // a CHECK / domain rule refused the input
  | 'CONFLICT' // unique / exclusion / foreign key / version
  | 'UNMAPPED_KIND' // Q8: a kind the customer's catalogue does not hold (or retired / wrong level)

export class BodiesError extends Error {
  override name = 'BodiesError'
  constructor(
    readonly code: BodiesErrorCode,
    message: string,
    readonly constraint?: string,
    options?: { cause?: unknown },
  ) {
    super(`${code}: ${message}`, options)
  }
}

interface PgError {
  code?: string
  constraint_name?: string
  message?: string
}

/** Maps a postgres error to a BodiesError; anything unknown is rethrown unchanged. */
export function mapPgError(err: unknown): never {
  if (err instanceof BodiesError) throw err
  const e = err as PgError
  const c = e?.constraint_name
  switch (e?.code) {
    case '23514': // check_violation (also the triggers' RAISE: acyclic, immutable kind, refuse_delete)
      throw new BodiesError('INVALID', e.message ?? 'check violation', c, { cause: err })
    case '23P01': // exclusion_violation (membership / tenure overlap)
    case '23505': // unique_violation
    case '23503': // foreign_key_violation
      throw new BodiesError('CONFLICT', e.message ?? 'conflict', c, { cause: err })
    default:
      throw err
  }
}
