// CD stage 1, unit U6g (enable-catchup): enabling a BLOCKED module database (a customer switching a module on
// again inside its Karenz) dumps just that one database before the first pending file is applied, applies the
// chain, unblocks, commits, and only then retires the dump. Fake deps in the style of module-upgrade.test.ts: a
// recording fake of the platform connection, the module server and the owner pool; the runner is replaced by a
// stand-in that drives the hooks the way the real one does (preApply before each file, a throw aborts the run).
// The throwaway-Postgres half, with the real runner, real roles and a real exporter, is
// test/integration/enable-catchup.test.ts.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunMigrationsHooks } from '../../src/runner.js'

const runMigrations = vi.fn()
vi.mock('../../src/runner.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/runner.js')>()), runMigrations: (o: unknown) => runMigrations(o) }))

const { enableModule } = await import('../../src/lifecycle/enable.js')
const { MigrationRunnerError } = await import('../../src/runner.js')
const { upgradeModuleDatabases } = await import('../../src/lifecycle/upgrade.js')
const { catchupDump } = await import('../../src/dump/catchup.js')
const { appendEvent, liveDumps, readEvents } = await import('../../src/dump/ledger.js')
const { tenantModuleDbName } = await import('../../src/names.js')
type LifecycleDeps = import('../../src/lifecycle/types.js').LifecycleDeps
type LifecycleModule = import('../../src/lifecycle/types.js').LifecycleModule
type DumpFs = import('../../src/dump/take.js').DumpFs
type Exporter = import('../../src/lifecycle/types.js').Exporter

const TENANT = '0192f0c1-2b3c-7d4e-8f00-112233445566'
const MODULE_ROW = '0192f0c1-2b3c-7d4e-8f00-aaaaaaaaaaaa'
const VERSION_ROW = '0192f0c1-2b3c-7d4e-8f00-bbbbbbbbbbbb'
const ISOLATION_ROW = '0192f0c1-2b3c-7d4e-8f00-cccccccccccc'
const DPIA_ROW = '0192f0c1-2b3c-7d4e-8f00-dddddddddddd'
const ACTOR = { kind: 'operator' as const, id: '0192f0c1-2b3c-7d4e-8f00-eeeeeeeeeeee' }
const RELEASE = 'dist-v9.9.9'
const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/lifecycle/lcfix/', import.meta.url))

const moduleOf = (id: string, service = `${id}-postgres`): LifecycleModule => ({
  id,
  dir: FIXTURE_DIR,
  moduleJson: {
    schemaVersion: 1,
    id,
    extractionSource: 'f276af5925abacdcfd05f6613fc11afff2d804c5',
    runtime: { version: '1.0.0', database: { postgresService: service, migrations: 'migrations' }, export: null, timedJobs: [], platformServer: null },
  } as LifecycleModule['moduleJson'],
})

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
// Under the checkout's git-excluded .scratch/, never the system temp dir (as the dump specs do).
const SCRATCH = fileURLToPath(new URL('../../../../.scratch/u6g-unit/', import.meta.url))
function freshDir(): string {
  mkdirSync(SCRATCH, { recursive: true })
  const d = mkdtempSync(join(SCRATCH, 'dump-'))
  roots.push(d)
  return d
}
/** A POSIX-looking dump dir: 0700, owned by uid 1000, plenty of space; this process is uid 1000. */
const posixFs: DumpFs = { statDir: () => ({ isDirectory: true, mode: 0o700, uid: 1000 }), freeBytes: () => 10 ** 12, uid: 1000 }

/** What the fakes record, in the order it happened. */
let events: string[]
let adminSeen: { service: string }[]

function fakeExporter(over: { failDump?: boolean } = {}): Exporter & { targets: { service: string; database: string }[] } {
  const targets: { service: string; database: string }[] = []
  return {
    targets,
    async dump(target, file) {
      events.push(`dump:${target.service}`)
      targets.push(target)
      const { writeFileSync } = await import('node:fs')
      writeFileSync(file, `PGDMP fake dump of ${target.database}`, { flag: 'wx', mode: 0o600 })
      if (over.failDump) throw new Error('pg_dump exited 1: connection refused')
    },
    async list(file) {
      const { basename } = await import('node:path')
      const db = /^(t_[0-9a-f]{32}__[a-z0-9_]+)\./.exec(basename(file))?.[1] ?? 'unknown'
      return `;\n; Archive created at 2026-11-17 03:00:00 UTC\n;     dbname: ${db}\n`
    },
  }
}

type Tag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>
const textOf = (strings: TemplateStringsArray) => strings.join('?').replace(/\s+/g, ' ').trim()

/** The platform connection: answers what enableModule of a database module asks, records the commit. */
function fakePlatform(state: 'blocked' | 'enabling', dbName: string): LifecycleDeps['platform'] {
  const answer = (text: string): unknown[] => {
    if (/current_database\(\)/.test(text)) return [{ db: 'gremion_platform' }]
    if (/FROM plt\.module m JOIN plt\.module_version v/.test(text)) return [{ module_id: MODULE_ROW, module_version_id: VERSION_ROW }]
    if (/FROM plt\.module_database WHERE customer_id = \? AND module_id = \? FOR UPDATE/.test(text)) return [{ state }]
    if (/FROM plt\.module_database/.test(text)) return [{ db_name: dbName, state, export_path: null, export_sha256: null, exported_at: null }]
    return []
  }
  const run: Tag = (strings) => {
    const text = textOf(strings)
    if (text.startsWith("UPDATE plt.module_database SET state = 'enabled'")) events.push('commit')
    return Promise.resolve(answer(text))
  }
  return Object.assign(run, { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(run) }) as unknown as LifecycleDeps['platform']
}

/** The module server: its admin answers the owner query and records every statement the lifecycle formats. */
function fakeServer(owner: string, dbName: string, existsAlready: boolean) {
  let exists = existsAlready
  const unsafe = (query: string, params: unknown[] = []): Promise<unknown[]> => {
    if (query.startsWith('SELECT pg_catalog.format')) {
      let i = 0
      const [template, ...args] = params as string[]
      return Promise.resolve([{ stmt: template!.replace(/%[IL]/g, () => String(args[i++])) }])
    }
    if (query.startsWith('CREATE DATABASE')) exists = true
    if (query.startsWith('GRANT CONNECT ON DATABASE')) events.push('unblock')
    if (query.startsWith('REVOKE CONNECT ON DATABASE')) events.push('reblock')
    return Promise.resolve([])
  }
  const admin = Object.assign(
    (strings: TemplateStringsArray) => {
      const text = textOf(strings)
      if (/FROM pg_database d JOIN pg_roles r/.test(text)) return Promise.resolve(exists ? [{ owner }] : [])
      if (/FROM pg_roles WHERE rolname/.test(text)) return Promise.resolve([{ one: 1 }])
      // the re-block's own proof: no session left, the app role cannot connect
      if (/count\(\*\)::int AS n FROM pg_stat_activity/.test(text)) return Promise.resolve([{ n: 0 }])
      if (/has_database_privilege/.test(text)) return Promise.resolve([{ can: false }])
      return Promise.resolve([])
    },
    { unsafe },
  )
  const owned = Object.assign(
    (strings: TemplateStringsArray) => {
      const text = textOf(strings)
      if (/current_database\(\) AS db, current_user AS usr/.test(text)) return Promise.resolve([{ db: dbName, usr: owner }])
      if (/FROM pg_namespace/.test(text)) return Promise.resolve([])
      if (/to_regclass/.test(text)) return Promise.resolve([{ present: false }])
      return Promise.resolve([])
    },
    { unsafe, end: async () => undefined },
  )
  return { admin, owned }
}

/**
 * The deps of one enable. `pending`: the files the stand-in runner finds pending (it calls preApply for each, the way
 * the real one does, and then "applies" it). `applyFails`: the file whose apply throws after a good dump.
 */
function setup(o: { module: string; state?: 'blocked' | 'enabling'; pending?: string[]; applyFails?: string; afterFirstDump?: () => void; upgradeHooks?: LifecycleDeps['upgradeHooks']; dumpRetire?: LifecycleDeps['dumpRetire'] }) {
  const m = moduleOf(o.module)
  const dbName = tenantModuleDbName(TENANT, o.module)
  const owner = `m_${o.module}`
  const ctx = { sql: ((strings: TemplateStringsArray) => Promise.resolve(/current_database/.test(textOf(strings)) ? [{ db: dbName, major: 18, bytes: '1000' }] : [])) as never }
  const srv = fakeServer(owner, dbName, (o.state ?? 'blocked') === 'blocked')
  const asked: string[] = []
  runMigrations.mockImplementation(async (opts: { hooks?: RunMigrationsHooks }) => {
    const applied: string[] = []
    for (const file of o.pending ?? []) {
      try {
        await opts.hooks?.preApply?.(file, { ...ctx, dir: '/x', applied: [], pending: o.pending ?? [] } as never)
      } catch (err) {
        // what the real runner does: the reason stays on `cause`, the message names the file only
        throw new MigrationRunnerError('PRE_APPLY_FAILED', `preApply refused ${file}; it and every later file were not applied (earlier files of this run stay applied)`, [file], { cause: err })
      }
      if (applied.length === 0) o.afterFirstDump?.()
      if (file === o.applyFails) throw new Error(`${file} failed`)
      events.push(`apply:${file}`)
      applied.push(file)
    }
    return { applied, alreadyApplied: 0 }
  })
  const deps: LifecycleDeps = {
    platform: fakePlatform(o.state ?? 'blocked', dbName),
    server: (service) => {
      asked.push(service)
      adminSeen.push({ service })
      return { admin: srv.admin as never, open: () => srv.owned as never }
    },
    enableGate: async () => ({ isolationTestResultId: ISOLATION_ROW, dpiaDecisionId: DPIA_ROW }),
    secrets: { appPassword: () => 'x'.repeat(24) },
    exporter: fakeExporter(),
    exportDir: '/unused',
    releaseRef: RELEASE,
    phaseFor: () => () => ({ phase: 'expand' as const }),
    ...(o.upgradeHooks ? { upgradeHooks: o.upgradeHooks } : {}),
    ...(o.dumpRetire ? { dumpRetire: o.dumpRetire } : {}),
  }
  return { m, deps, dbName, asked }
}

function catchup(dir: string | undefined, exporter: Exporter, over: { env?: Record<string, string> } = {}) {
  return catchupDump({
    env: { ...(dir ? { GREMION_MIGRATION_DUMP_DIR: dir } : {}), ...over.env },
    release: RELEASE,
    exporter,
    pgUserFor: (service) => service.replace(/-postgres$/, ''),
    pgDumpMajor: async () => 18,
    fs: posixFs,
    audit: () => {},
  })
}

beforeEach(() => {
  events = []
  adminSeen = []
  runMigrations.mockReset()
})

describe('enable of a blocked database: the catch-up dump', () => {
  it('dumps that one database once, with the label of GREMION_RELEASE_REF, BEFORE the first file; applies; unblocks; commits; then retires the dump', async () => {
    const dir = freshDir()
    const exporter = fakeExporter()
    const c = catchup(dir, exporter)
    let liveDuringApply = -1
    const retire = { afterEnable: async (release: string, database: string) => (events.push('retire'), c.retire.afterEnable(release, database)), afterDrop: c.retire.afterDrop }
    const s = setup({ module: 'finance', pending: ['002_a.sql', '003_b.sql'], afterFirstDump: () => (liveDuringApply = liveDumps(readEvents(dir)).length), upgradeHooks: c.upgradeHooks, dumpRetire: retire })

    const r = await enableModule(TENANT, s.m, ACTOR, s.deps)

    expect(r).toMatchObject({ created: false, restored: false, noop: false, applied: ['002_a.sql', '003_b.sql'] })
    // the order: one dump (of finance's own server), both files, the app role regains CONNECT, the commit, then the retire
    expect(events).toEqual(['dump:finance-postgres', 'apply:002_a.sql', 'apply:003_b.sql', 'unblock', 'commit', 'retire'])
    expect(exporter.targets).toEqual([{ service: 'finance-postgres', database: s.dbName }])
    expect(liveDuringApply).toBe(1)
    // the dump is the label of the release, of that one database, with the server and role the host's restore reads
    const created = readEvents(dir).filter((e) => e.event === 'created')
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ release: RELEASE, database: s.dbName, scope: 'customer', module_id: 'finance', pg_service: 'finance-postgres', pg_user: 'finance', origin: 'enable-catchup' })
    // retired after the commit: no live line, no file, one `deleted` line naming the reason
    expect(liveDumps(readEvents(dir))).toEqual([])
    expect(readEvents(dir).filter((e) => e.event === 'deleted')).toMatchObject([{ database: s.dbName, release: RELEASE, reason: 'enable committed' }])
    expect(readdirSync(dir).filter((f) => f !== 'ledger.jsonl')).toEqual([])
  })

  it('afterEnable retires ONLY a dump this enable took: a live dump of the same release and database that another writer took is reused, never retired, and the enable says so', async () => {
    const dir = freshDir()
    const exporter = fakeExporter()
    const { takeDump } = await import('../../src/dump/take.js')
    const dbName = tenantModuleDbName(TENANT, 'finance')
    // another origin: the host's take of this release for this very database, in the same ledger, under the same label
    const other = await takeDump({
      dir,
      release: RELEASE,
      database: dbName,
      scope: 'customer',
      customerId: TENANT,
      moduleId: 'finance',
      exporter,
      probe: { serverMajor: async () => 18, pgDumpMajor: async () => 18, databaseBytes: async () => 1000 },
      fs: posixFs,
      audit: () => {},
    })
    events = [] // the other writer's dump is not part of this enable's order
    const audit: string[] = []
    const c = catchupDump({ env: { GREMION_MIGRATION_DUMP_DIR: dir }, release: RELEASE, exporter, pgUserFor: (service) => service.replace(/-postgres$/, ''), pgDumpMajor: async () => 18, fs: posixFs, audit: (l) => audit.push(l) })
    const s = setup({ module: 'finance', pending: ['002_a.sql'], upgradeHooks: c.upgradeHooks, dumpRetire: c.retire })

    await enableModule(TENANT, s.m, ACTOR, s.deps)

    // the enable reused the other writer's dump (no new dump) and left it alone: no `deleted` line, still live
    expect(events).toEqual(['apply:002_a.sql', 'unblock', 'commit'])
    expect(liveDumps(readEvents(dir)).map((e) => e.migration_dump_id)).toEqual([other.id])
    expect(readEvents(dir).filter((e) => e.event === 'deleted')).toEqual([])
    expect(existsSync(other.path)).toBe(true)
    // and it says so, with ids only, so the operator knows which dump holds the next release
    expect(audit.join('\n')).toContain(`premigration-dump left-live id=${other.id} release=${RELEASE} db=${dbName}`)
    expect(audit.join(' ')).toContain('not recorded as taken by this enable')
  })

  it('without upgradeHooks (what every caller did before U6g) the pending file is applied with NO dump', async () => {
    const s = setup({ module: 'finance', pending: ['002_a.sql'] })
    await enableModule(TENANT, s.m, ACTOR, s.deps)
    expect(events).toEqual(['apply:002_a.sql', 'unblock', 'commit'])
  })

  it('nothing pending: the hook is never called, no dump is taken, the database is unblocked', async () => {
    const dir = freshDir()
    const c = catchup(dir, fakeExporter())
    const s = setup({ module: 'finance', pending: [], upgradeHooks: c.upgradeHooks, dumpRetire: c.retire })
    const r = await enableModule(TENANT, s.m, ACTOR, s.deps)
    expect(r.applied).toEqual([])
    expect(events).toEqual(['unblock', 'commit'])
    expect(readEvents(dir)).toEqual([])
  })

  it('a database this call CREATED takes no dump (nothing to lose) and nothing is retired', async () => {
    const dir = freshDir()
    const retire = { afterEnable: vi.fn(), afterDrop: vi.fn() }
    const c = catchup(dir, fakeExporter())
    const s = setup({ module: 'finance', state: 'enabling', pending: ['001_init.sql'], upgradeHooks: c.upgradeHooks, dumpRetire: retire })
    const r = await enableModule(TENANT, s.m, ACTOR, s.deps)
    expect(r.created).toBe(true)
    expect(events).toContain('apply:001_init.sql')
    expect(events.some((e) => e.startsWith('dump:'))).toBe(false)
    expect(readEvents(dir)).toEqual([])
    expect(retire.afterEnable).not.toHaveBeenCalled()
  })

  it('a FAILING dump stops the restore: the error reaches the caller, no file is applied, the database stays blocked, no dump line', async () => {
    const dir = freshDir()
    const c = catchup(dir, fakeExporter({ failDump: true }))
    const s = setup({ module: 'finance', pending: ['002_a.sql'], upgradeHooks: c.upgradeHooks, dumpRetire: c.retire })
    await expect(enableModule(TENANT, s.m, ACTOR, s.deps)).rejects.toThrow(/PG_DUMP_FAILED|preApply refused/)
    expect(events).toEqual(['dump:finance-postgres'])
    expect(events).not.toContain('unblock')
    expect(events).not.toContain('commit')
    expect(readEvents(dir)).toEqual([])
  })

  it('a failing migration file after a GOOD dump leaves the database blocked and the dump LIVE (its restore point)', async () => {
    const dir = freshDir()
    const c = catchup(dir, fakeExporter())
    const s = setup({ module: 'finance', pending: ['002_a.sql', '003_bad.sql'], applyFails: '003_bad.sql', upgradeHooks: c.upgradeHooks, dumpRetire: c.retire })
    await expect(enableModule(TENANT, s.m, ACTOR, s.deps)).rejects.toThrow(/003_bad.sql failed/)
    expect(events).toEqual(['dump:finance-postgres', 'apply:002_a.sql'])
    expect(events).not.toContain('unblock')
    const live = liveDumps(readEvents(dir))
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ release: RELEASE, database: s.dbName })
    expect(existsSync(join(dir, live[0]!.file!))).toBe(true)
  })

  it('a retry of the same release after that failure reuses the live dump and retires it when the enable commits', async () => {
    const dir = freshDir()
    const c = catchup(dir, fakeExporter())
    const first = setup({ module: 'finance', pending: ['002_a.sql', '003_bad.sql'], applyFails: '003_bad.sql', upgradeHooks: c.upgradeHooks, dumpRetire: c.retire })
    await expect(enableModule(TENANT, first.m, ACTOR, first.deps)).rejects.toThrow(/003_bad\.sql failed/)
    const id = liveDumps(readEvents(dir))[0]!.migration_dump_id
    events = []
    // a retry is a NEW process in production: a fresh catch-up instance that remembers nothing of the first
    const later = catchup(dir, fakeExporter())
    const second = setup({ module: 'finance', pending: ['003_bad.sql'], upgradeHooks: later.upgradeHooks, dumpRetire: later.retire })
    await enableModule(TENANT, second.m, ACTOR, second.deps)
    expect(events).toEqual(['apply:003_bad.sql', 'unblock', 'commit'])
    expect(events.some((e) => e.startsWith('dump:'))).toBe(false)
    expect(readEvents(dir).filter((e) => e.event === 'created').map((e) => e.migration_dump_id)).toEqual([id])
    expect(liveDumps(readEvents(dir))).toEqual([])
  })

  it('a retry that finds NOTHING pending any more (everything was applied, the commit failed) still retires the leftover dump', async () => {
    const dir = freshDir()
    const c = catchup(dir, fakeExporter())
    const first = setup({ module: 'finance', pending: ['002_a.sql'], upgradeHooks: c.upgradeHooks, dumpRetire: c.retire })
    first.deps.hooks = {
      afterStep: (step) => {
        if (step === 'unblocked') throw new Error('crash after the unblock')
      },
    }
    await expect(enableModule(TENANT, first.m, ACTOR, first.deps)).rejects.toThrow(/crash after the unblock/)
    expect(liveDumps(readEvents(dir))).toHaveLength(1)
    expect(events).toContain('reblock')
    const later = catchup(dir, fakeExporter()) // a new process: nothing remembered from the first
    const second = setup({ module: 'finance', pending: [], upgradeHooks: later.upgradeHooks, dumpRetire: later.retire })
    await enableModule(TENANT, second.m, ACTOR, second.deps)
    expect(liveDumps(readEvents(dir))).toEqual([])
  })

  it('a retire that fails AFTER the commit does not fail or re-block the enable: it is logged with the way out, the dump stays live', async () => {
    const lines: string[] = []
    const c = catchup(freshDir(), fakeExporter())
    const s = setup({ module: 'finance', pending: ['002_a.sql'], upgradeHooks: c.upgradeHooks, dumpRetire: { afterEnable: () => Promise.reject(new Error('LEDGER_LOCKED: a stale lock')), afterDrop: () => undefined } })
    s.deps.log = (l) => lines.push(l)
    const r = await enableModule(TENANT, s.m, ACTOR, s.deps)
    expect(r.noop).toBe(false)
    expect(events).not.toContain('reblock')
    expect(lines.join('\n')).toMatch(/retiring any pre-migration dump of \S+ failed \(LEDGER_LOCKED: a stale lock\).*gremion-migration-dump discard --release dist-v9\.9\.9/)
  })

  it('an enable with NOTHING pending against an unusable directory still commits, and its log line does not claim that a dump exists', async () => {
    const lines: string[] = []
    const bad = catchupDump({ env: { GREMION_MIGRATION_DUMP_DIR: '/definitely/absent' }, release: RELEASE, exporter: fakeExporter(), pgUserFor: () => 'finance', pgDumpMajor: async () => 18, audit: () => {} })
    const s = setup({ module: 'finance', pending: [], upgradeHooks: bad.upgradeHooks, dumpRetire: bad.retire })
    s.deps.log = (l) => lines.push(l)
    const r = await enableModule(TENANT, s.m, ACTOR, s.deps)
    expect(r.noop).toBe(false)
    expect(events).toEqual(['unblock', 'commit'])
    const text = lines.join('\n')
    expect(text).toMatch(/DUMP_DIR_INVALID/)
    // no dump was taken: the text must not assert that one exists, only say what holds if there is one
    expect(text).not.toMatch(/dump of \S+ could not be retired/)
    expect(text).toMatch(/if this enable took one, it stays live/)
  })
})

describe('the upgradeHooks factory form', () => {
  it('is called with the module and ITS OWN server, and the exporter of the dump receives that service', async () => {
    const exporter = fakeExporter()
    const seen: [string, string][] = []
    const dir = freshDir()
    const base = catchup(dir, exporter)
    const factory = (moduleId: string, service: string) => {
      seen.push([moduleId, service])
      return base.upgradeHooks(moduleId, service)
    }
    for (const [module, service] of [['finance', 'finance-postgres'], ['board', 'board-postgres']] as const) {
      const s = setup({ module, pending: ['002_a.sql'], upgradeHooks: factory, dumpRetire: base.retire })
      await enableModule(TENANT, s.m, ACTOR, s.deps)
      expect(events.filter((e) => e.startsWith('dump:'))).toEqual([`dump:${service}`])
      events = []
    }
    expect(seen).toEqual([['finance', 'finance-postgres'], ['board', 'board-postgres']])
  })

  it('an object (what every caller passes today) keeps working', async () => {
    const preApply = vi.fn()
    const s = setup({ module: 'finance', pending: ['002_a.sql'], upgradeHooks: { preApply } })
    await enableModule(TENANT, s.m, ACTOR, s.deps)
    expect(preApply).toHaveBeenCalledTimes(1)
  })
})

describe('fail closed: no usable dump directory', () => {
  it('refuses the enable of a blocked database that has pending files (DUMP_DIR_UNSET), applies nothing, keeps it blocked', async () => {
    const c = catchup(undefined, fakeExporter())
    const s = setup({ module: 'finance', pending: ['002_a.sql'], upgradeHooks: c.upgradeHooks, dumpRetire: c.retire })
    await expect(enableModule(TENANT, s.m, ACTOR, s.deps)).rejects.toThrow(/DUMP_DIR_UNSET/)
    expect(events).toEqual([])
  })

  it('a directory that is not a directory, or a bad owner uid, refuses the same way, named', async () => {
    const bad = catchupDump({ env: { GREMION_MIGRATION_DUMP_DIR: '/definitely/absent' }, release: RELEASE, exporter: fakeExporter(), pgUserFor: () => 'finance', pgDumpMajor: async () => 18, audit: () => {} })
    const s1 = setup({ module: 'finance', pending: ['002_a.sql'], upgradeHooks: bad.upgradeHooks })
    await expect(enableModule(TENANT, s1.m, ACTOR, s1.deps)).rejects.toThrow(/DUMP_DIR_INVALID/)
    const uid = catchup(freshDir(), fakeExporter(), { env: { GREMION_MIGRATION_DUMP_OWNER_UID: 'one thousand' } })
    const s2 = setup({ module: 'finance', pending: ['002_a.sql'], upgradeHooks: uid.upgradeHooks })
    await expect(enableModule(TENANT, s2.m, ACTOR, s2.deps)).rejects.toThrow(/DUMP_DIR_OWNER/)
    expect(events).toEqual([])
  })

  it('an enable with NOTHING pending needs no directory at all', async () => {
    const c = catchup(undefined, fakeExporter())
    const s = setup({ module: 'finance', pending: [], upgradeHooks: c.upgradeHooks, dumpRetire: c.retire })
    await enableModule(TENANT, s.m, ACTOR, s.deps)
    expect(events).toEqual(['unblock', 'commit'])
  })
})

describe('CD interplay: a failed release leaves its set live (case b)', () => {
  it('the switch-on refuses with DUMP_SERIES naming the failed release and the discard command; the database stays blocked, nothing is applied', async () => {
    const dir = freshDir()
    const dbName = tenantModuleDbName(TENANT, 'finance')
    // exactly the line of the failed release's live dump of this database
    appendEvent(dir, {
      v: 1, event: 'created', at: '2026-11-17T03:00:00.000Z', migration_dump_id: '0192f0c1-2b3c-7d4e-8f00-000000000099', release: 'dist-vFAILED', scope: 'customer',
      customer_id: TENANT, module_id: 'finance', database: dbName, by_kind: 'system', file: 'dist-vFAILED/x.dump', sha256: 'a'.repeat(64), bytes: 10, dump_taken_at: '2026-11-17T03:00:00.000Z',
    })
    const c = catchup(dir, fakeExporter())
    const s = setup({ module: 'finance', pending: ['002_a.sql'], upgradeHooks: c.upgradeHooks, dumpRetire: c.retire })
    await expect(enableModule(TENANT, s.m, ACTOR, s.deps)).rejects.toThrow(/DUMP_SERIES.*dist-vFAILED.*gremion-migration-dump discard --release dist-vFAILED/s)
    expect(events).toEqual([])
    // a retire of the live release must not have touched the failed release's dump
    expect(liveDumps(readEvents(dir))).toHaveLength(1)
  })
})

describe('the module step still skips a blocked database (U6b), asserted again with a pending file', () => {
  it('a blocked row with a pending file: the step opens nothing', async () => {
    const opened: string[] = []
    const platformRun = (strings: TemplateStringsArray): Promise<unknown[]> => {
      const text = textOf(strings)
      if (/current_database\(\)/.test(text)) return Promise.resolve([{ db: 'gremion_platform' }])
      return Promise.resolve([{ customer_id: TENANT, module_key: 'finance', db_name: tenantModuleDbName(TENANT, 'finance'), state: 'blocked', enablement_state: 'disabled' }])
    }
    runMigrations.mockImplementation(async () => ({ applied: ['002_a.sql'], alreadyApplied: 0 }))
    const summary = await upgradeModuleDatabases({
      platform: platformRun as never,
      catalogue: [moduleOf('finance')],
      releaseRef: RELEASE,
      server: () => ({
        admin: (async () => []) as never,
        open: (db: string) => {
          opened.push(db)
          throw new Error('the step must open nothing')
        },
      }),
    } as never)
    expect(opened).toEqual([])
    expect(runMigrations).not.toHaveBeenCalled()
    expect(summary).toMatchObject({ skipped: 1, upgraded: 0, files_applied: 0, skippedByState: { blocked: 1 } })
  })
})
