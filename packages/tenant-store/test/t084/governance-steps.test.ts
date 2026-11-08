// TASK-084-a Task 5: migrate, bind and read back the governance database.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Sql } from '@gremion/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bindGovernanceDatabase,
  dropGovernanceDatabase,
  ensureGovernanceDatabase,
  governanceDbName,
  governancePostCondition,
  governanceRoles,
  migrateGovernanceDatabase,
} from '../../src/lifecycle/governance.js'
import { openAsOwner } from '../../src/lifecycle/enable.js'
import { LifecycleError } from '../../src/lifecycle/guards.js'
import type { ModuleServer } from '../../src/lifecycle/types.js'
import { admin as openAdmin, adminOn, genPassword, uuidv7 } from '../harness/t084.js'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const DIR = join(REPO, 'services', 'governance', 'migrations')
const SHA = createHash('sha256').update(readFileSync(join(DIR, '0001_gov_setup.sql'))).digest('hex')

async function failure(p: PromiseLike<unknown>): Promise<(Error & { code?: string }) | null> {
  try {
    await p
    return null
  } catch (e) {
    return e as Error & { code?: string }
  }
}

describe('migrateGovernanceDatabase / bindGovernanceDatabase / governancePostCondition', () => {
  let a: Sql
  const pools: Sql[] = []
  const created: string[] = []
  const ddl: string[] = []
  const server = (record = false): ModuleServer => ({
    admin: record
      ? (new Proxy(a, {
          get(t, p) {
            if (p === 'unsafe') return (q: string, ...rest: never[]) => (ddl.push(q), t.unsafe(q, ...rest))
            const v = Reflect.get(t, p, t)
            return typeof v === 'function' ? v.bind(t) : v
          },
          apply: (t, _this, args) => Reflect.apply(t, t, args as never),
        }) as Sql)
      : a,
    open: (d, o) => {
      const p = adminOn(d, o?.role ? { role: o.role } : {})
      pools.push(p)
      return p
    },
  })
  async function fresh(): Promise<string> {
    const id = uuidv7()
    created.push(id)
    await ensureGovernanceDatabase(server(), id, genPassword())
    return id
  }
  const opts = { dir: DIR, releaseRef: 'dist-t084', log: () => {} }

  beforeAll(() => {
    a = openAdmin(3)
  })
  afterAll(async () => {
    for (const id of created) await dropGovernanceDatabase(server(), id).catch((e) => console.error(`[t084] drop ${id}`, e))
    await Promise.all(pools.map((p) => p.end({ timeout: 5 }).catch(() => {})))
    await a?.end({ timeout: 5 }).catch(() => {})
  })

  it('migrate applies 0001 as the owner: every object is owned by g_X_owner', async () => {
    const X = await fresh()
    const r = await migrateGovernanceDatabase(server(), X, opts)
    expect(r).toEqual({ applied: ['0001_gov_setup.sql'], alreadyApplied: 0 })
    const o = adminOn(governanceDbName(X))
    pools.push(o)
    const foreign = await o`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                             JOIN pg_catalog.pg_roles r ON r.oid = c.relowner WHERE n.nspname = 'gov' AND r.rolname <> ${governanceRoles(X).owner}`
    expect(foreign).toEqual([])
    const lock = JSON.parse(readFileSync(join(REPO, 'scripts', 'migrations', 'applied.lock.json'), 'utf8')) as { chains: { governance: { files: Record<string, string> } } }
    const ledger = await o<{ filename: string; sha256: string }[]>`SELECT filename, sha256 FROM gov.schema_migration`
    expect(ledger).toEqual([{ filename: '0001_gov_setup.sql', sha256: lock.chains.governance.files['0001_gov_setup.sql'] }])
  })

  it('migrate a second time applies nothing and issues no DDL', async () => {
    const X = await fresh()
    await migrateGovernanceDatabase(server(), X, opts)
    ddl.length = 0
    const again = await migrateGovernanceDatabase(server(true), X, opts)
    expect(again).toEqual({ applied: [], alreadyApplied: 1 })
    expect(ddl.filter((q) => /^(CREATE|ALTER|DROP|GRANT|REVOKE)/i.test(q.trim()))).toEqual([])
  })

  it('a kill after migrate and before bind resumes: bind inserts once', async () => {
    const X = await fresh()
    await migrateGovernanceDatabase(server(), X, opts)
    expect(await bindGovernanceDatabase(server(), { id: X, token: 'musterstadt' })).toEqual({ inserted: true })
    expect(await bindGovernanceDatabase(server(), { id: X, token: 'musterstadt' })).toEqual({ inserted: false })
    const o = adminOn(governanceDbName(X))
    pools.push(o)
    expect((await o`SELECT 1 FROM gov.database_binding`).length).toBe(1)
  })

  it('post-condition reads the database: binding = (X, token, gov), ledger, forced RLS, CONNECT grantees', async () => {
    const X = await fresh()
    await migrateGovernanceDatabase(server(), X, opts)
    await bindGovernanceDatabase(server(), { id: X, token: 'musterstadt' })
    const r = governanceRoles(X)
    expect(await governancePostCondition(server(), X)).toEqual({
      binding: { customerId: X, tenantToken: 'musterstadt', contextCode: 'gov' },
      ledger: [{ filename: '0001_gov_setup.sql', sha256: SHA }],
      unforcedRlsTables: [],
      connectGrantees: [r.owner, r.app, r.purger].sort(),
      currentDatabase: governanceDbName(X),
    })
  })

  it('post-condition of a database that is not bound or migrated reports binding null and an empty ledger', async () => {
    const X = await fresh()
    await expect(governancePostCondition(server(), X)).resolves.toMatchObject({ binding: null, ledger: [] })
  })

  it('a binding row of ANOTHER customer is reported, not adopted', async () => {
    const X = await fresh()
    const Y = uuidv7()
    await migrateGovernanceDatabase(server(), X, opts)
    const o = await openAsOwner(server(), governanceDbName(X), governanceRoles(X).owner)
    pools.push(o)
    await o`INSERT INTO gov.database_binding (customer_id, tenant_token, context_code) VALUES (${Y}, 'other', 'gov')`
    expect(await bindGovernanceDatabase(server(), { id: X, token: 'musterstadt' })).toEqual({ inserted: false })
    const pc = await governancePostCondition(server(), X)
    expect(pc.binding?.customerId).toBe(Y)
    expect(pc.binding?.customerId).not.toBe(X)
  })

  it('post-condition detects an unforced table and a PUBLIC CONNECT', async () => {
    const X = await fresh()
    await migrateGovernanceDatabase(server(), X, opts)
    await bindGovernanceDatabase(server(), { id: X, token: 'musterstadt' })
    const o = await openAsOwner(server(), governanceDbName(X), governanceRoles(X).owner)
    pools.push(o)
    await o.unsafe('ALTER TABLE gov.meeting NO FORCE ROW LEVEL SECURITY')
    expect((await governancePostCondition(server(), X)).unforcedRlsTables).toEqual(['meeting'])
    await a.unsafe(`GRANT CONNECT ON DATABASE ${governanceDbName(X)} TO PUBLIC`)
    expect((await governancePostCondition(server(), X)).connectGrantees).toContain('PUBLIC')
  })

  it('bind refuses a token that fails the binding CHECK before any write', async () => {
    const X = await fresh()
    await migrateGovernanceDatabase(server(), X, opts)
    for (const token of ['A', 'ab', '1abc', 'Muster', 'x'.repeat(41), 'a-b']) {
      const e = await failure(bindGovernanceDatabase(server(), { id: X, token }))
      expect(e).toBeInstanceOf(LifecycleError)
      expect((e as unknown as LifecycleError).code).toBe('INVALID_INPUT')
    }
    const o = adminOn(governanceDbName(X))
    pools.push(o)
    expect((await o`SELECT 1 FROM gov.database_binding`).length).toBe(0)
  })

  it('migrate refuses a releaseRef that is empty, over 64 chars or has control characters', async () => {
    const X = await fresh()
    for (const releaseRef of ['', 'r'.repeat(65), 'dist\nref']) {
      const e = await failure(migrateGovernanceDatabase(server(), X, { ...opts, releaseRef }))
      expect(e).toBeInstanceOf(LifecycleError)
      expect((e as unknown as LifecycleError).code).toBe('INVALID_INPUT')
    }
    const o = adminOn(governanceDbName(X))
    pools.push(o)
    expect((await o`SELECT to_regclass('gov.schema_migration')::text AS t`)[0]?.t).toBeNull()
  })
})
