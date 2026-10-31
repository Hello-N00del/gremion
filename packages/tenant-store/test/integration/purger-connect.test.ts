// Kernel issue #89 on the scratch stack: create-time provisioning that a later release extends is never
// re-applied to customers created earlier. The purger's CONNECT on the customer's kernel database is
// such a grant (ensureKernelDatabase gives it at create time; the older release made the role without
// it, because the purge run did not log in as the purger then). A customer made the old way fails its
// first scheduled purge with "permission denied for database". ensureKernelPurgerConnect re-applies the
// grant idempotently and kernelPurgerConnectProblems reads it back, so `reconcile` can report and repair.
import { randomBytes } from 'node:crypto'
import type { Sql } from '@gremion/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  dropKernelDatabase,
  ensureKernelDatabase,
  ensureKernelPurgeGrants,
  ensureKernelPurgerConnect,
  kernelDbName,
  kernelPurgerConnectProblems,
  kernelRoles,
  runPurge,
} from '../../src/lifecycle/index.js'
import type { PurgeServer } from '../../src/lifecycle/index.js'
import { connect, connectAs } from '../harness/db.js'
import { platformDb, uuidv7 } from '../harness/lifecycle.js'

/** The kernel server as customer-adapters.ts kernelServer builds it. */
function kernelServer(): PurgeServer & { close(): Promise<void> } {
  const admin = connect('t020_test_admin', { max: 2 })
  const pools: Sql[] = []
  return {
    admin,
    open(database) {
      const sql = connect(database, { max: 2, connection: { search_path: 'pg_catalog' } })
      pools.push(sql)
      return sql
    },
    login(database, user, password) {
      const sql = connectAs(database, user, password, { connection: { search_path: 'pg_catalog' } })
      pools.push(sql)
      return sql
    },
    async close() {
      await Promise.all([admin, ...pools].map((s) => s.end({ timeout: 5 }).catch(() => {})))
    },
  }
}

const NOW = new Date('2026-10-27T03:00:00.000Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000)
const hex = (id: string) => id.replaceAll('-', '')

describe('purger CONNECT on the customer kernel database (kernel issue #89)', () => {
  let server: ReturnType<typeof kernelServer>
  let platform: Sql
  const T = uuidv7() // created the pre-change way: roles and purge grants, no purger CONNECT
  const W = uuidv7() // created the current way
  const pw = randomBytes(24).toString('base64url')
  const seedPools: Sql[] = []
  const db = (t: string) => {
    const sql = connect(kernelDbName(t), { max: 2 })
    seedPools.push(sql)
    return sql
  }
  const run = () => runPurge({ platform, server, now: () => NOW })
  const mine = (r: Awaited<ReturnType<typeof run>>, t: string) => r.errors.filter((e) => e.tenant === hex(t))

  async function seed(tenant: string) {
    const { owner } = kernelRoles(tenant)
    await db(tenant).begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${owner}`)
      await tx.unsafe(`
        CREATE TABLE public.event_consumption (consumer text NOT NULL, event_id uuid NOT NULL, consumed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (consumer, event_id));
        CREATE TABLE public.scheduled_notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text NOT NULL, role_assignment_id uuid NOT NULL DEFAULT gen_random_uuid(),
          recipient_keycloak_id text NOT NULL DEFAULT 'u', scheduled_for timestamptz NOT NULL, sent_at timestamptz, failed_at timestamptz, failure_reason text);`)
    })
    await ensureKernelPurgeGrants(server, tenant)
    await db(tenant)`INSERT INTO event_consumption (consumer, event_id, consumed_at) VALUES ('old', ${uuidv7()}, ${daysAgo(30)})`
  }

  beforeAll(async () => {
    server = kernelServer()
    platform = platformDb()
    for (const t of [T, W]) {
      await ensureKernelDatabase(server, t, pw)
      await seed(t)
    }
    // what the older release left: the purger role exists, CONNECT was never granted
    await server.admin.unsafe(`REVOKE CONNECT ON DATABASE ${kernelDbName(T)} FROM ${kernelRoles(T).purger}`)
  })

  afterAll(async () => {
    await platform`DELETE FROM plt.job_run WHERE scheduled_job_id IN (SELECT scheduled_job_id FROM plt.scheduled_job WHERE job_kind = 'purge_run')`
    for (const t of [T, W]) await dropKernelDatabase(server, t).catch((e: unknown) => console.error('[purger-connect] teardown', e))
    await platform.end()
    await Promise.all(seedPools.map((s) => s.end({ timeout: 5 }).catch(() => {})))
    await server.close()
  })

  it('the pre-change customer: the purge run fails with permission denied for its kernel database (the bug as observed)', async () => {
    const r = await run()
    expect(r.status).toBe('failed')
    const errs = mine(r, T)
    expect(errs).toHaveLength(1)
    expect(JSON.stringify(errs[0])).toMatch(/permission denied for database/)
    expect(mine(r, W)).toEqual([]) // the current way is green
  })

  it('kernelPurgerConnectProblems reports the missing grant for the pre-change customer, nothing for the current one', async () => {
    const problems = await kernelPurgerConnectProblems(server, T)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(kernelRoles(T).purger)
    expect(problems[0]).toContain('CONNECT')
    expect(await kernelPurgerConnectProblems(server, W)).toEqual([])
  })

  it('ensureKernelPurgerConnect repairs it, reads the post-condition back, and a second call changes nothing', async () => {
    const first = await ensureKernelPurgerConnect(server, T)
    expect(first.granted).toBe(true)
    expect(await kernelPurgerConnectProblems(server, T)).toEqual([])
    const second = await ensureKernelPurgerConnect(server, T)
    expect(second.granted).toBe(false)
    expect(await ensureKernelPurgerConnect(server, W)).toEqual({ granted: false })
  })

  it('exactly CONNECT: no TEMPORARY, no CREATE on the database for the purger, PUBLIC still without CONNECT', async () => {
    const { purger } = kernelRoles(T)
    const [q] = await server.admin<Record<string, boolean>[]>`
      SELECT has_database_privilege(${purger}, ${kernelDbName(T)}, 'CONNECT') AS c,
             has_database_privilege(${purger}, ${kernelDbName(T)}, 'TEMPORARY') AS t,
             has_database_privilege(${purger}, ${kernelDbName(T)}, 'CREATE') AS cr,
             has_database_privilege('public', ${kernelDbName(T)}, 'CONNECT') AS pc`
    expect(q).toEqual({ c: true, t: false, cr: false, pc: false })
  })

  it('after the repair the purge run is green for the repaired customer: errors 0, the aged row gone', async () => {
    const r = await run()
    expect(mine(r, T)).toEqual([])
    expect(r.status).toBe('succeeded')
    const [n] = await db(T)<{ n: number }[]>`SELECT count(*)::int AS n FROM event_consumption`
    expect(n!.n).toBe(0)
  })

  it('a customer whose purger role does not exist is a named problem and is NOT created by the repair', async () => {
    const X = uuidv7()
    const problems = await kernelPurgerConnectProblems(server, X)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/does not exist/)
    await expect(ensureKernelPurgerConnect(server, X)).rejects.toThrow(/does not exist/)
    const [r] = await server.admin<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ${kernelRoles(X).purger}`
    expect(r!.n).toBe(0)
  })
})
