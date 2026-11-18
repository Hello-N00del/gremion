// The create flow for a module with a database of its own, on the scratch PostgreSQL 18 (run.mjs), through
// the REAL pgModules, the REAL enableModule and the REAL gate. The module is the board's catalogue entry
// with the declaration added (a fixture: the real module.json is the declaration unit's file), so the
// migration chain that runs is the board's own.
//
//  - the server that answers nothing refuses the create BEFORE any state exists (no plt row of any kind);
//  - a server that answers the pre-check and then refuses stops the enable, and at that point there is NO
//    `enabled` enablement without a database (the database is created first, the enablement last), no
//    database and no half state beyond the visible `enabling` row; the rerun completes;
//  - a server that never answers is refused within the bound, not waited for.
import { randomBytes, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { LifecycleModule, ModuleServer } from '@gremion/tenant-store/lifecycle'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadModuleJsons, pgGate, pgModules, recordIsolationResults, type DpiaSpec } from '../../src/index.ts'
import { open, REPO, setupRoles, adminUrl, type Roles } from './scratch.ts'

const TIP = 'b'.repeat(40)
const DPIA: DpiaSpec = { requiresDpia: 'no', reasonCodes: ['no_special_category'], documentRef: 'TOM-Anhang 4.1' }
const OPERATOR = randomUUID()
const APP_PW = randomBytes(24).toString('base64url')
const SERVICE = 'board-postgres'

function evidence(modules: string[], tip = TIP) {
  return {
    produced_by: 'verify',
    tree_clean: true,
    release_tip_sha: tip,
    verify_record: { suite: 'isolation:tenant', sha: tip, startedAt: '2026-10-05T10:00:00.000Z', finishedAt: '2026-10-05T10:03:00.000Z', collected: 8, passed: 8, failed: 0 },
    results: modules.map((m) => ({ module: m, test_kind: 'cross_customer', passed: true, run_at: '2026-10-05T10:02:00.000Z', release_tip_sha: tip, evidence_ref: `sha256:${'0'.repeat(64)} isolation/${tip}.json#${m}` })),
  }
}

function uuidv7(): string {
  const b = randomBytes(16)
  const ms = BigInt(Date.now())
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn)
  b[6] = (b[6]! & 0x0f) | 0x70
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** The board's catalogue entry with the database declaration the declaration unit adds (a fixture, never the file). */
function boardWithDatabase(): LifecycleModule {
  const real = loadModuleJsons(resolve(REPO, 'modules')).find((m) => m.id === 'board')!
  return {
    ...real,
    moduleJson: {
      ...real.moduleJson,
      runtime: { ...real.moduleJson.runtime, database: { postgresService: SERVICE, migrations: 'migrations' }, export: { kind: 'pg_dump', retentionProfile: 'rp-brd-module-data' } },
    },
  }
}

type Behaviour = { answers: number } | { hang: true }

/** A module server over the real scratch server that answers a counted number of asks and then refuses (or never answers). */
function flakyServer(real: ModuleServer, behaviour: Behaviour): ModuleServer {
  const ask = (): Promise<never> | null => {
    if ('hang' in behaviour) return new Promise<never>(() => {})
    if (behaviour.answers <= 0) return Promise.reject(Object.assign(new Error('connect ECONNREFUSED 192.0.2.7:5432'), { code: 'ECONNREFUSED' }))
    behaviour.answers--
    return null
  }
  const admin = new Proxy(real.admin as unknown as (...a: unknown[]) => unknown, {
    apply(target, thisArg, args) {
      const refused = ask()
      return refused ?? Reflect.apply(target, thisArg, args)
    },
    get(target, prop) {
      const v = Reflect.get(target, prop) as unknown
      if (prop === 'unsafe' && typeof v === 'function') {
        return (...a: unknown[]) => ask() ?? (v as (...x: unknown[]) => unknown).apply(target, a)
      }
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v
    },
  }) as unknown as Sql
  return {
    admin,
    open(database, options) {
      const refused = ask()
      if (refused) return refused as never
      return real.open(database, options)
    },
  }
}

describe('create for a module with a database of its own (the board shape)', () => {
  let r: Roles
  let platform: Sql
  const pools: Sql[] = []
  let real: ModuleServer
  let gate: ReturnType<typeof pgGate>

  const modulesOver = (server: ModuleServer) =>
    pgModules({
      platform,
      catalogue: [boardWithDatabase()],
      lifecycle: { server: () => server, secrets: { appPassword: () => APP_PW }, exporter: { dump: async () => {}, list: async () => '' }, exportDir: resolve(REPO, '.scratch/board-create/exports'), releaseRef: 'dist-v0.0.1', log: () => {} },
    })
  const customer = () => {
    const id = uuidv7()
    return { id, slug: 'musterstadt', token: 'musterstadt', realm: 'musterstadt', host: 'rat.musterstadt.example', hex: id.replaceAll('-', '') }
  }
  const databases = async (): Promise<string[]> => (await r.admin<{ datname: string }[]>`SELECT datname FROM pg_database`).map((d) => d.datname)
  const platformRows = async (id: string) => ({
    enabled: await platform<{ state: string }[]>`SELECT e.state FROM plt.module_enablement e JOIN plt.module m USING (module_id) WHERE e.customer_id = ${id} AND m.module_key = 'board'`,
    database: await platform<{ state: string }[]>`SELECT d.state FROM plt.module_database d JOIN plt.module m USING (module_id) WHERE d.customer_id = ${id} AND m.module_key = 'board'`,
  })

  beforeAll(async () => {
    r = await setupRoles('boardcreate')
    platform = open('gremion_platform', 3, 't043_platform', r.ownerPassword)
    real = {
      admin: r.admin,
      open(database, options) {
        const sql = postgres(adminUrl(database), { max: 2, onnotice: () => {}, ...(options?.role ? { connection: { options: `-c role=${options.role}` } } : {}) })
        pools.push(sql)
        return sql
      },
    }
    await recordIsolationResults(platform, evidence(['board']))
    gate = pgGate(platform, { releaseTipSha: TIP })
  })
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end({ timeout: 5 }).catch(() => {})))
    await platform?.end({ timeout: 5 })
    await r?.close()
  })

  it('the declaration is read from the catalogue entry', () => {
    const modules = modulesOver(real)
    expect(modules.databaseService?.('board')).toBe(SERVICE)
    expect(modules.databaseService?.('nonexistent')).toBeNull()
  })

  it('a server that answers nothing refuses the pre-check, and no plt row or database exists for the customer', async () => {
    const c = customer()
    const before = await databases()
    const err = await modulesOver(flakyServer(real, { answers: 0 })).assertServerAnswers!(SERVICE).then(() => null, (e: Error & { code?: string }) => e)
    expect(err).toMatchObject({ code: 'PRECONDITION' })
    expect(err?.message).toContain(SERVICE)
    expect(err?.message).toContain('nothing was written')
    expect(err?.message).toContain('ECONNREFUSED') // the error code, not the driver's text: that carries the address
    expect(err?.message).not.toContain('192.0.2.7')
    expect(await platformRows(c.id)).toEqual({ enabled: [], database: [] })
    expect(await databases()).toEqual(before)
  })

  it('a server that never answers is refused within the bound instead of waited for', async () => {
    const t0 = Date.now()
    await expect(modulesOver(flakyServer(real, { hang: true })).assertServerAnswers!(SERVICE)).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringContaining('no answer within') })
    expect(Date.now() - t0).toBeLessThan(15_000)
  }, 30_000)

  it('the pre-check passes, the server then refuses: no enabled enablement without a database, no database, and the rerun completes', async () => {
    const c = customer()
    const db = `t_${c.hex}__board`
    expect((await gate.recordDpia(c.id, 'board', DPIA, OPERATOR)).created).toBe(true)

    const state = { answers: 1 } // the pre-check; everything the enable asks after it is refused
    const modules = modulesOver(flakyServer(real, state))
    await modules.assertServerAnswers!(SERVICE)
    await expect(modules.enable(c, 'board', gate.enableGate, OPERATOR)).rejects.toThrow(/ECONNREFUSED/)

    const mid = await platformRows(c.id)
    expect(mid.enabled).toEqual([]) // never `enabled` without the database
    expect(mid.database).toEqual([{ state: 'enabling' }]) // the visible, resumable state
    expect(await databases()).not.toContain(db)
    expect(await modules.enabled(c)).toEqual([])

    const healthy = modulesOver(real)
    expect(await healthy.enable(c, 'board', gate.enableGate, OPERATOR)).toMatchObject({ noop: false, database: db })
    expect(await databases()).toContain(db)
    expect(await platformRows(c.id)).toEqual({ enabled: [{ state: 'enabled' }], database: [{ state: 'enabled' }] })
    // the board's own chain ran: its three tables exist in the new database
    const owned = real.open(db) as Sql
    try {
      const tables = (await owned<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('board', 'stack', 'card') ORDER BY 1`).map((t) => t.tablename)
      expect(tables).toEqual(['board', 'card', 'stack'])
    } finally {
      await owned.end({ timeout: 5 })
    }
    // and a second enable is a no-op
    expect((await healthy.enable(c, 'board', gate.enableGate, OPERATOR)).noop).toBe(true)
  }, 90_000)
})
