// packages/provisioning/src/export-hold.ts
//
// How long the export of a switched-off module outlives day 30 of its Karenz. The day-30 job drops the
// blocked database and, without a hold, deletes the export with it (retention catalogue RC-MOD-EXPORT).
// A module that is listed here keeps its export until `final_at + <days>`, so a customer's data is not
// gone with the database; every other module keeps the present behaviour (no entry, no hold).
// The entry has an effect only for a module that declares a database and an export: board declares neither in this
// tree, so no board export exists to keep until the release that declares them (the hold is asked per export).
//
// The date is derived from the Karenz row's own final_at, never from the clock of the run, so it is the same on
// every run: the hourly job that repeats after a crash, and the pass after the date, compute the same date.
import type { ExportHoldContext } from '@gremion/tenant-store/lifecycle'

/**
 * Days the export is kept after day 30, per module key. PROVISIONAL for board: the length is the DPO's to set,
 * and the retention catalogue rows RC-MOD-EXPORT and RC-BRD say the same number (a test reads both and fails
 * when they disagree, so the two change together).
 */
export const EXPORT_KEEP_DAYS: Readonly<Record<string, number>> = Object.freeze({
  board: 365,
})

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The date until which the export of `moduleKey` is kept, or null when the module has no entry. Plain UTC
 * arithmetic on the instant: a change of the local clock (daylight saving) moves nothing. Throws when `finalAt`
 * is not a valid date: the day-30 job treats a throw as "keep the export and try again".
 */
export function exportKeptUntil(moduleKey: string, finalAt: Date): Date | null {
  if (!Object.hasOwn(EXPORT_KEEP_DAYS, moduleKey)) return null
  const days = EXPORT_KEEP_DAYS[moduleKey]
  if (typeof days !== 'number' || !Number.isInteger(days) || days <= 0) {
    throw new Error(`the export keep time of module ${moduleKey} is not a positive whole number of days`)
  }
  if (!(finalAt instanceof Date) || !Number.isFinite(finalAt.getTime())) {
    throw new Error(`the export hold of module ${moduleKey} needs the final_at of its Karenz row, which is not a valid date`)
  }
  return new Date(finalAt.getTime() + days * DAY_MS)
}

/** The `exportHold` the day-30 job (finalizeDueKarenz) is given. The row's state and database decide whether it is asked at all. */
export function exportHold(_tenantId: string, moduleKey: string, context: ExportHoldContext): Date | null {
  return exportKeptUntil(moduleKey, context.finalAt)
}
