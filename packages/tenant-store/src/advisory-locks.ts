// packages/tenant-store/src/advisory-locks.ts
//
// The kernel's advisory-lock registry. Every pg_advisory_lock the kernel takes
// is keyed by the two-int4 form (classid, objid) and has ONE row here, so two
// purposes can never contend for the same key by accident. pg_locks reports
// the pair back as its classid / objid columns (objsubid = 2), which is how the
// concurrency test watches the second runner wait.
//
// Advisory locks are per database: the migration lock in t_<A>__calendar and
// the one in t_<B>__calendar are different locks although the key is the same.

/** The kernel's reserved advisory-lock class id (a signed int4). */
export const ADVISORY_LOCK_CLASS_ID = 1735029614

export interface AdvisoryLockKey {
  readonly classid: number
  readonly objid: number
  /** One purpose per row; the test asserts purposes are distinct. */
  readonly purpose: string
}

/**
 * One row per purpose. TASK-029 / TASK-075 add their rows here, never a bare
 * literal at the call site.
 */
export const ADVISORY_LOCKS = {
  migration: {
    classid: ADVISORY_LOCK_CLASS_ID,
    objid: 1,
    purpose: 'schema migration runner, one holder per (tenant, module) database',
  },
} as const satisfies Record<string, AdvisoryLockKey>

const INT4_MIN = -(2 ** 31)
const INT4_MAX = 2 ** 31 - 1

function isInt4(n: number): boolean {
  return Number.isInteger(n) && n >= INT4_MIN && n <= INT4_MAX
}

/**
 * Throws when two rows share a (classid, objid), or when a key is not a signed
 * int4 (pg_advisory_lock(int4, int4) would reject it at run time, or a float
 * would be truncated into someone else's key).
 */
export function assertDistinctLockKeys(rows: Readonly<Record<string, AdvisoryLockKey>>): void {
  const seen = new Map<string, string>()
  for (const [name, row] of Object.entries(rows)) {
    if (!isInt4(row.classid) || !isInt4(row.objid)) {
      throw new Error(`advisory lock '${name}' is not a signed int4 pair: (${row.classid}, ${row.objid})`)
    }
    const key = `${row.classid}:${row.objid}`
    const prior = seen.get(key)
    if (prior !== undefined) {
      throw new Error(`advisory locks '${prior}' and '${name}' share the key (${row.classid}, ${row.objid})`)
    }
    seen.set(key, name)
  }
}
