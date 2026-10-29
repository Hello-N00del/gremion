// services/kernel-api/src/migrate/lock.ts -- run a step under the customer database's migration advisory lock
// (TASK-080-a round 3).
//
// The runner (@gremion/tenant-store runMigrations) holds ADVISORY_LOCKS.migration for the length of its run and
// exposes only a per-file preApply hook, no post hook. The idt hook's AFTER step (binding, customer_setting,
// vendor kinds) therefore takes the SAME lock itself, after the runner released it, so it is serialised against
// any other migrate run of the same customer. (The BEFORE step runs inside the runner's preApply, i.e. already
// under the runner's own lock; it must not be wrapped in this helper, the lock is not re-entrant across
// connections.) The lock is a session lock on a reserved connection, released in `finally`; a connection that
// could not unlock is terminated, never returned to the pool still holding it.
import type { Sql } from '@gremion/db'
import { ADVISORY_LOCKS } from '@gremion/tenant-store'

export class MigrationLockError extends Error {
  override name = 'MigrationLockError'
}

export async function withMigrationLock<T>(sql: Sql, o: { timeoutMs: number }, fn: () => Promise<T>): Promise<T> {
  if (!Number.isInteger(o.timeoutMs) || o.timeoutMs < 0) throw new RangeError('timeoutMs must be a whole number of milliseconds (0 = no limit)')
  const { classid, objid } = ADVISORY_LOCKS.migration
  const reserved = await sql.reserve()
  let pid = -1
  let held = false
  try {
    const [me] = await reserved<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
    pid = me!.pid
    // lock_timeout bounds the advisory-lock wait too (a real pg_locks waiter, observable like the runner's)
    await reserved`SELECT set_config('lock_timeout', ${String(o.timeoutMs)}, false), set_config('statement_timeout', '0', false)`
    try {
      await reserved`SELECT pg_advisory_lock(${classid}::int4, ${objid}::int4)`
      held = true
    } catch (err) {
      if ((err as { code?: string }).code === '55P03') throw new MigrationLockError(`the migration lock was not granted within ${o.timeoutMs} ms`, { cause: err })
      throw err
    }
    await reserved.unsafe('RESET lock_timeout; RESET statement_timeout')
    return await fn()
  } finally {
    let clean = !held
    if (held) {
      try {
        const [u] = await reserved<{ ok: boolean }[]>`SELECT pg_advisory_unlock(${classid}::int4, ${objid}::int4) AS ok`
        clean = u?.ok === true
      } catch {
        clean = false
      }
    }
    if (clean) reserved.release()
    else {
      // still holding the lock (or in an unknown state): end that backend over another connection
      await sql`SELECT pg_terminate_backend(${pid}::int)`.catch(() => undefined)
      reserved.release()
    }
  }
}
