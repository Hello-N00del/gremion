// TASK-080-a round 3 (MEDIUM): the idt migrate hook's two steps run UNDER the migration advisory lock.
// The before-step (CREATE SCHEMA / CREATE EXTENSION IF NOT EXISTS) used to run before runMigrations took its
// lock and the after-step after it released it, so two concurrent runs for one customer could race a catalog
// unique index. Post-conditions asserted on the database, not exit codes.
import { ADVISORY_LOCKS } from '@gremion/tenant-store'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withMigrationLock } from '../../src/migrate/lock.ts'
import { buildBodiesWorld, type BodiesWorld } from '../harness/bodies-world.ts'
import { connect, createCustomer } from '../harness/scratch.ts'
import { kernelDatabaseOf } from '../../src/tenancy/target.ts'

let w: BodiesWorld
beforeAll(async () => {
  w = await buildBodiesWorld('lock')
}, 240_000)
afterAll(async () => {
  await w?.close()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const { classid, objid } = ADVISORY_LOCKS.migration

describe('the migrate hook runs under the migration advisory lock', () => {
  it('withMigrationLock: the body waits while another session holds the lock, and runs once it is released', async () => {
    const c = await createCustomer(w.world, 'lock-helper', 'lock-helper.example.org')
    const holder = connect(kernelDatabaseOf(c.id), { max: 2 })
    const pool = connect(kernelDatabaseOf(c.id), { max: 2 })
    try {
      const conn = await holder.reserve()
      await conn`SELECT pg_advisory_lock(${classid}::int4, ${objid}::int4)`
      let ran = false
      const p = withMigrationLock(pool, { timeoutMs: 20_000 }, async () => void (ran = true))
      await sleep(1_500)
      expect(ran).toBe(false)
      await conn`SELECT pg_advisory_unlock(${classid}::int4, ${objid}::int4)`
      conn.release()
      await p
      expect(ran).toBe(true)
      // and it let go: another session can take the lock at once
      const [free] = await holder`SELECT pg_try_advisory_lock(${classid}::int4, ${objid}::int4) AS ok`
      expect(free).toEqual({ ok: true })
      await holder`SELECT pg_advisory_unlock(${classid}::int4, ${objid}::int4)`
    } finally {
      await Promise.allSettled([holder.end({ timeout: 2 }), pool.end({ timeout: 2 })])
    }
  })

  it('withMigrationLock gives up with a clear error when the lock is not granted in time, and runs nothing', async () => {
    const c = await createCustomer(w.world, 'lock-timeout', 'lock-timeout.example.org')
    const holder = connect(kernelDatabaseOf(c.id), { max: 2 })
    const pool = connect(kernelDatabaseOf(c.id), { max: 2 })
    try {
      const conn = await holder.reserve()
      await conn`SELECT pg_advisory_lock(${classid}::int4, ${objid}::int4)`
      let ran = false
      await expect(withMigrationLock(pool, { timeoutMs: 500 }, async () => void (ran = true))).rejects.toThrow(/migration lock/)
      expect(ran).toBe(false)
      await conn`SELECT pg_advisory_unlock(${classid}::int4, ${objid}::int4)`
      conn.release()
    } finally {
      await Promise.allSettled([holder.end({ timeout: 2 }), pool.end({ timeout: 2 })])
    }
  })

  it('the before-step creates nothing while another run holds the lock: schema idt appears only once the lock is granted', async () => {
    const c = await createCustomer(w.world, 'lock-before', 'lock-before.example.org')
    const admin = connect(kernelDatabaseOf(c.id), { max: 3 })
    try {
      const conn = await admin.reserve()
      await conn`SELECT pg_advisory_lock(${classid}::int4, ${objid}::int4)`
      const run = w.migrate(['--customer', c.id])
      await sleep(2_500)
      // RED before the fix: the before-step ran ahead of the lock and idt already exists
      expect(await admin`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'idt'`).toEqual([{ n: 0 }])
      await conn`SELECT pg_advisory_unlock(${classid}::int4, ${objid}::int4)`
      conn.release()
      const r = await run
      expect(r.code, r.lines.join('\n')).toBe(0)
      expect(await admin`SELECT count(*)::int AS n FROM idt.database_binding`).toEqual([{ n: 1 }])
    } finally {
      await admin.end({ timeout: 2 })
    }
  })

  it('three concurrent migrate runs for one fresh customer all succeed and leave exactly one binding, one setting, one extension', async () => {
    const c = await createCustomer(w.world, 'lock-race', 'lock-race.example.org')
    const admin = connect(kernelDatabaseOf(c.id), { max: 2 })
    try {
      const rs = await Promise.all([w.migrate(['--customer', c.id]), w.migrate(['--customer', c.id]), w.migrate(['--customer', c.id])])
      for (const r of rs) expect(r.code, r.lines.join('\n')).toBe(0)
      expect(await admin`SELECT (SELECT count(*)::int FROM idt.database_binding) AS b, (SELECT count(*)::int FROM idt.customer_setting) AS s, (SELECT count(*)::int FROM pg_extension WHERE extname = 'btree_gist') AS e`).toEqual([{ b: 1, s: 1, e: 1 }])
    } finally {
      await admin.end({ timeout: 2 })
    }
  })
})
