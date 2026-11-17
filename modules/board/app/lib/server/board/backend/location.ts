// modules/board/app/lib/server/board/backend/location.ts
// Where does THIS customer's board live? One fact, read from one row.
//
//   kernel  the board tables of the customer's own (kernel) database serve it. This is the
//           answer for every customer that was never moved, and for a customer without a row.
//   moving  a move is copying the board out right now: reads still come from the kernel tables,
//           writes are refused for the seconds the copy takes (router.ts).
//   module  the board module's own database serves it, through the board service.
//
// The row is `board_location` (migration 0066). It is the ONLY thing this file reads, so every
// running copy of the app, old colour and new colour alike, gives the same answer without being
// told by a restart or a setting. Two rules make that answer safe, and both are read by the move:
//
//   - a read is held for 5 seconds per customer, so a flip is seen within 5 seconds;
//   - a 'moving' row that has not been refreshed for more than 300 seconds is the trace of a move
//     that died, and reads as 'kernel'. The age is measured by the DATABASE (now() - changed_at),
//     the same clock the move's own checks use, never by this process.
//
// A flag that cannot be read is never guessed: it throws BoardLocationUnreadableError, which the
// routes answer with 503. Falling back to 'kernel' would write to the old copy of a board that has
// already moved, and that write would be lost.

import { getDb } from '$lib/server/db'
import { currentTenantId } from '$lib/server/tenant/context'

export type BoardLocation = 'kernel' | 'moving' | 'module'

/** How long one read of the flag is served from memory, per customer. */
export const BOARD_LOCATION_CACHE_TTL_MS = 5000
/** A 'moving' row older than this many seconds (database clock) reads as 'kernel'. */
export const BOARD_MOVE_STALE_S = 300

// ── Errors ───────────────────────────────────────────────────────────────────────────────

/** The board cannot answer right now, and the caller should try again shortly. Routes map it to a
 *  503 with a Retry-After header (resolve.ts). */
export class BoardUnavailableError extends Error {
  readonly status = 503 as const
  readonly retryAfterSeconds: number
  constructor(message: string, retryAfterSeconds: number, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'BoardUnavailableError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** A write arrived while a move is copying the board. Nothing was written. */
export class BoardMovingError extends BoardUnavailableError {
  constructor() {
    super('Das Board wird gerade verschoben.', 5)
    this.name = 'BoardMovingError'
  }
}

/** The location flag could not be read (database error, missing table, no tenant, a value that
 *  is not one of the three). */
export class BoardLocationUnreadableError extends BoardUnavailableError {
  constructor(cause?: unknown) {
    super('Das Board ist momentan nicht verfügbar.', 30, { cause })
    this.name = 'BoardLocationUnreadableError'
  }
}

// ── Reader ───────────────────────────────────────────────────────────────────────────────

interface Row {
  location: unknown
  age_s: unknown
}

interface Entry {
  readonly value: BoardLocation
  readonly at: number
}

const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<BoardLocation>>()
// Customers are few and ids are short; the bound only keeps a long-lived process from growing.
const CACHE_MAX = 512

const LOCATIONS: ReadonlySet<string> = new Set(['kernel', 'moving', 'module'])

function decide(rows: readonly Row[]): BoardLocation {
  const row = rows[0]
  if (!row) return 'kernel' // no row: never moved
  const { location, age_s } = row
  if (typeof location !== 'string' || !LOCATIONS.has(location)) {
    throw new Error('board_location holds an unknown location')
  }
  if (location !== 'moving') return location as BoardLocation
  if (typeof age_s !== 'number' || !Number.isFinite(age_s)) {
    throw new Error('board_location has no usable age')
  }
  return age_s > BOARD_MOVE_STALE_S ? 'kernel' : 'moving'
}

async function readFresh(): Promise<BoardLocation> {
  const rows = await getDb()<Row[]>`
    SELECT location, extract(epoch FROM (now() - changed_at))::float8 AS age_s
    FROM board_location
    LIMIT 1`
  return decide(rows)
}

/**
 * The location of the current customer's board. Held for BOARD_LOCATION_CACHE_TTL_MS per customer;
 * concurrent first reads share one query; a failed read is never cached.
 * Throws BoardLocationUnreadableError when the flag cannot be read.
 */
export async function getBoardLocation(): Promise<BoardLocation> {
  let tenant: string
  try {
    tenant = currentTenantId()
  } catch (err) {
    console.error('[board-location] no tenant context → unavailable')
    throw new BoardLocationUnreadableError(err)
  }

  const hit = cache.get(tenant)
  if (hit && Date.now() - hit.at < BOARD_LOCATION_CACHE_TTL_MS) return hit.value

  const pending = inflight.get(tenant)
  if (pending) return pending

  const read = (async () => {
    try {
      const value = await readFresh()
      if (cache.size >= CACHE_MAX) {
        const now = Date.now()
        for (const [k, e] of cache) if (now - e.at >= BOARD_LOCATION_CACHE_TTL_MS) cache.delete(k)
        if (cache.size >= CACHE_MAX) cache.clear()
      }
      cache.set(tenant, { value, at: Date.now() })
      return value
    } catch (err) {
      // the cause is on the error; the log line names the failure class only, never a customer
      const code = (err as { code?: unknown } | null)?.code
      console.error(`[board-location] flag unreadable → 503 (${typeof code === 'string' ? code : 'error'})`)
      throw new BoardLocationUnreadableError(err)
    } finally {
      inflight.delete(tenant)
    }
  })()
  inflight.set(tenant, read)
  return read
}

/** Test seam: forget every cached read. */
export function resetBoardLocationCacheForTests(): void {
  cache.clear()
  inflight.clear()
}
