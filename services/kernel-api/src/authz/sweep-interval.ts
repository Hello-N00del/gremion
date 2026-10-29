// services/kernel-api/src/authz/sweep-interval.ts -- AUTHZ_SWEEP_INTERVAL_MS, parsed strictly.
// Unset = 60 s; a non-negative integer = that many milliseconds, 0 = the in-process sweep is off
// (the cron verb runs it instead). Anything else refuses the boot: a typo (`60s`, `1.5`, an empty
// value) used to read as NaN / 0 and silently switched the sweep off.
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000
/** setInterval treats a delay above 2^31 - 1 as 1 ms, so a larger value is a mistake, not a long interval. */
const MAX_INTERVAL_MS = 2_147_483_647

export function parseSweepInterval(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SWEEP_INTERVAL_MS
  if (!/^\d+$/.test(raw)) throw new Error(`AUTHZ_SWEEP_INTERVAL_MS must be a non-negative integer number of milliseconds (0 = off), got ${JSON.stringify(raw)}`)
  const ms = Number(raw)
  if (!Number.isSafeInteger(ms) || ms > MAX_INTERVAL_MS) throw new Error(`AUTHZ_SWEEP_INTERVAL_MS must be at most ${MAX_INTERVAL_MS} ms, got ${JSON.stringify(raw)}`)
  return ms
}

/** The one boot log line: the sweep is off (and why), or the effective interval. */
export const describeSweepInterval = (ms: number): string => (ms === 0 ? 'authz sweep: off (AUTHZ_SWEEP_INTERVAL_MS=0)' : `authz sweep: every ${ms} ms`)
