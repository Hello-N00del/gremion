// CD module step: upgradeModuleDatabases opens ONLY the enabled gate databases
// whose enablement is enabled, as the owner m_<id>, applies the pending files of the module's chain,
// re-grants the app role, and stops at the first database that fails. Fake deps in the style of
// board-enable-no-database.test.ts: the fake server FAILS THE TEST when it is asked for a database
// the step must not open. The runner and the re-grant are replaced by spies here; the throwaway-Postgres
// integration test (test/integration/module-upgrade.test.ts) runs the real ones.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pinnedPhaseFor } from '../../src/phase.js'
import { PINNED_BASELINE } from '../../src/phase-baseline.js'

const runMigrations = vi.fn()
const grantAppPrivileges = vi.fn()

vi.mock('../../src/runner.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/runner.js')>()), runMigrations: (o: unknown) => runMigrations(o) }))
vi.mock('../../src/lifecycle/enable.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lifecycle/enable.js')>()),
  grantAppPrivileges: (...a: unknown[]) => grantAppPrivileges(...a),
}))

const { upgradeModuleDatabases, connectionLevelCode } = await import('../../src/lifecycle/upgrade.js')
const { MigrationRunnerError } = await import('../../src/runner.js')
const { tenantModuleDbName } = await import('../../src/names.js')
type UpgradeDeps = import('../../src/lifecycle/upgrade.js').UpgradeDeps
type LifecycleModule = import('../../src/lifecycle/types.js').LifecycleModule

const C1 = '0192f0c1-2b3c-7d4e-8f00-000000000001'
const C2 = '0192f0c1-2b3c-7d4e-8f00-000000000002'
const C3 = '0192f0c1-2b3c-7d4e-8f00-000000000003'
const C4 = '0192f0c1-2b3c-7d4e-8f00-000000000004'
const C5 = '0192f0c1-2b3c-7d4e-8f00-000000000005'
const C6 = '0192f0c1-2b3c-7d4e-8f00-000000000006'
const RELEASE = 'dist-v9.9.9'

const BOARD_DIR = fileURLToPath(new URL('../../../../modules/board', import.meta.url))
function realModule(id: string): LifecycleModule {
  const dir = fileURLToPath(new URL(`../../../../modules/${id}`, import.meta.url))
  return { id, dir, moduleJson: JSON.parse(readFileSync(`${dir}/module.json`, 'utf8')) as LifecycleModule['moduleJson'] }
}
const BOARD = realModule('board')
const CALENDAR = realModule('calendar')
const FINANCE = realModule('finance')
const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/lifecycle/lcfix/', import.meta.url))
const ZZ: LifecycleModule = {
  id: 'zzhostile',
  dir: FIXTURE_DIR,
  moduleJson: {
    schemaVersion: 1,
    id: 'zzhostile',
    extractionSource: 'f276af5925abacdcfd05f6613fc11afff2d804c5',
    runtime: { version: '1.0.0', database: { postgresService: 'zzhostile-postgres', migrations: 'migrations' }, export: null, timedJobs: [], platformServer: null },
  } as LifecycleModule['moduleJson'],
}

interface Row {
  customer_id: string
  module_key: string
  db_name: string
  state: string
  enablement_state: string | null
}
const row = (customer: string, module: string, state = 'enabled', enrol: string | null = 'enabled', db?: string): Row => ({
  customer_id: customer,
  module_key: module,
  db_name: db ?? tenantModuleDbName(customer, module),
  state,
  enablement_state: enrol,
})

/** A fake Sql: a tagged template, recording every statement, answering by text. */
function fakeSql(statements: string[], answer: (text: string) => unknown[] | Error, ended?: string[], label = ''): never {
  const run = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim()
    statements.push(text)
    const a = answer(text)
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a)
  }
  return Object.assign((strings: TemplateStringsArray) => run(strings), {
    begin: () => Promise.reject(new Error('a transaction must not be opened here')),
    unsafe: () => Promise.reject(new Error('unsafe() must not be used here')),
    options: { max: 2 },
    end: async () => void ended?.push(label),
  }) as never
}

interface Fixture {
  deps: UpgradeDeps
  platformStatements: string[]
  adminStatements: string[]
  opened: { db: string; role: string | undefined }[]
  ended: string[]
  servers: string[]
}

/**
 * `owners`: what the server says owns each database (default: m_<module>). `fail`: databases the server must never be
 * asked to open. `open` overrides what a pool does when it is used.
 */
function fixture(
  rows: Row[],
  opts: {
    catalogue?: LifecycleModule[]
    owners?: Record<string, string | null>
    never?: string[]
    platformAnswer?: (text: string) => unknown[] | Error
    adminAnswer?: (text: string) => unknown[] | Error | undefined
    serverError?: Error
    /** What an opened pool says it is connected to / runs as (default: the database asked for and the role asked for). */
    who?: { db?: string; usr?: string }
  } = {},
): Fixture {
  const platformStatements: string[] = []
  const adminStatements: string[] = []
  const opened: Fixture['opened'] = []
  const ended: string[] = []
  const servers: string[] = []
  const platform = fakeSql(platformStatements, (t) => {
    if (opts.platformAnswer) return opts.platformAnswer(t)
    if (/current_database\(\)/.test(t)) return [{ db: 'gremion_platform' }]
    if (/FROM plt\.module_database/.test(t)) return rows
    return new Error(`unexpected platform statement: ${t}`)
  })
  const deps: UpgradeDeps = {
    platform,
    catalogue: opts.catalogue ?? [BOARD, CALENDAR, FINANCE, ZZ],
    releaseRef: RELEASE,
    server: (service) => {
      servers.push(service)
      if (opts.serverError) throw opts.serverError
      // the admin connection answers the owner query by the database name bound in it (a value, not text)
      const admin = ((strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join('?').replace(/\s+/g, ' ').trim()
        adminStatements.push(text)
        const custom = opts.adminAnswer?.(text)
        if (custom !== undefined) return custom instanceof Error ? Promise.reject(custom) : Promise.resolve(custom)
        if (/FROM pg_database d JOIN pg_roles r/.test(text)) {
          const db = String(values[0])
          const owner = opts.owners && db in opts.owners ? opts.owners[db] : `m_${/__(.+)$/.exec(db)?.[1] ?? 'x'}`
          return Promise.resolve(owner === null ? [] : [{ owner }])
        }
        return Promise.resolve([])
      }) as never
      return {
        admin,
        open: (db: string, o?: { role?: string }) => {
          if (opts.never?.includes(db)) throw new Error(`the step opened ${db}, which it must not`)
          opened.push({ db, role: o?.role })
          return fakeSql([], (t) => (/current_database\(\)/.test(t) ? [{ db: opts.who?.db ?? db, usr: opts.who?.usr ?? o?.role }] : new Error(`unexpected owned statement: ${t}`)), ended, db)
        },
      } as never
    },
  }
  return { deps, platformStatements, adminStatements, opened, ended, servers }
}

beforeEach(() => {
  runMigrations.mockReset()
  runMigrations.mockResolvedValue({ applied: [], alreadyApplied: 0 })
  grantAppPrivileges.mockReset()
  grantAppPrivileges.mockResolvedValue(undefined)
})

describe('which rows the step opens', () => {
  it('opens only an enabled database whose enablement is enabled; every other row is skipped and counted by state, and the fake server fails the test when asked for one', async () => {
    const rows = [
      row(C1, 'calendar'),
      row(C2, 'calendar', 'blocked'),
      row(C3, 'calendar', 'enabling'),
      row(C4, 'calendar', 'disabling'),
      row(C5, 'calendar', 'dropped'),
      row(C6, 'calendar', 'enabled', 'disabled'),
    ]
    const never = [C2, C3, C4, C5, C6].map((c) => tenantModuleDbName(c, 'calendar'))
    const f = fixture(rows, { never })
    const r = await upgradeModuleDatabases(f.deps)
    expect(f.opened.map((o) => o.db)).toEqual([tenantModuleDbName(C1, 'calendar')])
    expect(r).toMatchObject({ total: 6, upgraded: 0, unchanged: 1, skipped: 5, failed: 0, files_applied: 0, failure: null })
    expect(r.skippedByState).toEqual({ blocked: 1, enabling: 1, disabling: 1, dropped: 1, 'enabled-not-enrolled': 1 })
    // no admin statement named a skipped database either (the owner query is not even issued for them)
    expect(f.adminStatements.filter((s) => /pg_database/.test(s))).toHaveLength(1)
  })

  it('a module that declares no database is never opened (the real modules/board/module.json)', async () => {
    expect(BOARD.moduleJson.runtime.database).toBeNull()
    expect(BOARD.dir).toBe(BOARD_DIR)
    const f = fixture([row(C1, 'board')], { never: [tenantModuleDbName(C1, 'board')] })
    const r = await upgradeModuleDatabases(f.deps)
    expect(f.opened).toEqual([])
    expect(f.servers).toEqual([])
    expect(r).toMatchObject({ total: 1, skipped: 1, unchanged: 0, failed: 0, failure: null })
    expect(r.skippedByState).toEqual({ 'no-database': 1 })
  })

  it('a row whose module is not in the image catalogue is a failure (unknown_module) and nothing is opened', async () => {
    const f = fixture([row(C1, 'finance')], { catalogue: [CALENDAR], never: [tenantModuleDbName(C1, 'finance')] })
    const r = await upgradeModuleDatabases(f.deps)
    expect(f.opened).toEqual([])
    expect(r).toMatchObject({ total: 1, failed: 1, failure: { kind: 'commit', code: 'unknown_module', ordinal: 1 } })
  })

  it('the database must be owned by m_<id>: any other owner, or no database, is refused as ensureDatabase refuses it, and nothing is opened', async () => {
    const db = tenantModuleDbName(C1, 'calendar')
    const foreign = fixture([row(C1, 'calendar')], { owners: { [db]: 'postgres' }, never: [db] })
    expect((await upgradeModuleDatabases(foreign.deps)).failure).toMatchObject({ kind: 'commit', code: 'DATABASE_FOREIGN_OWNER' })
    const missing = fixture([row(C1, 'calendar')], { owners: { [db]: null }, never: [db] })
    expect((await upgradeModuleDatabases(missing.deps)).failure).toMatchObject({ kind: 'commit', code: 'DATABASE_MISSING' })
  })

  it('the name is recomputed from (customer, module): a row that names another database is refused before the server is asked anything', async () => {
    const f = fixture([row(C1, 'calendar', 'enabled', 'enabled', tenantModuleDbName(C2, 'calendar'))], { never: [tenantModuleDbName(C2, 'calendar'), tenantModuleDbName(C1, 'calendar')] })
    const r = await upgradeModuleDatabases(f.deps)
    expect(r.failure).toMatchObject({ kind: 'commit', code: 'TARGET_REFUSED' })
    expect(f.adminStatements).toEqual([])
    expect(f.opened).toEqual([])
  })

  it('openAsOwner proves database and user: a pool that answers another database or another user is refused (TARGET_REFUSED), the runner is never called and the pool is ended', async () => {
    const wrongDb = fixture([row(C1, 'calendar')], { who: { db: tenantModuleDbName(C2, 'calendar') } })
    expect((await upgradeModuleDatabases(wrongDb.deps)).failure).toMatchObject({ kind: 'commit', code: 'TARGET_REFUSED' })
    const wrongUser = fixture([row(C1, 'calendar')], { who: { usr: 'postgres' } })
    expect((await upgradeModuleDatabases(wrongUser.deps)).failure).toMatchObject({ kind: 'commit', code: 'TARGET_REFUSED' })
    expect(runMigrations).not.toHaveBeenCalled()
    expect(wrongDb.ended).toHaveLength(1)
    expect(wrongUser.ended).toHaveLength(1)
  })

  it('no write statement reaches the platform connection, and no transaction is opened on it', async () => {
    const f = fixture([row(C1, 'calendar'), row(C2, 'calendar', 'blocked')])
    await upgradeModuleDatabases(f.deps)
    expect(f.platformStatements.length).toBeGreaterThan(0)
    for (const s of f.platformStatements) expect(s).toMatch(/^SELECT /)
    for (const s of f.platformStatements) expect(s).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE)\b/)
  })

  it('a platform connection that is not gremion_platform is refused (nothing is opened)', async () => {
    const f = fixture([row(C1, 'calendar')], { platformAnswer: (t) => (/current_database\(\)/.test(t) ? [{ db: 'gremion' }] : []) })
    await expect(upgradeModuleDatabases(f.deps)).rejects.toMatchObject({ code: 'NOT_PLATFORM' })
    expect(f.opened).toEqual([])
  })
})

describe('how a database is migrated', () => {
  it('opens a direct pool as the owner, runs the chain with the release label and the pinned phase baseline, with no dump hook, and ends the pool', async () => {
    const f = fixture([row(C1, 'calendar')])
    runMigrations.mockResolvedValueOnce({ applied: ['0009_x.sql'], alreadyApplied: 8 })
    await upgradeModuleDatabases(f.deps)
    expect(f.opened).toEqual([{ db: tenantModuleDbName(C1, 'calendar'), role: 'm_calendar' }])
    expect(runMigrations).toHaveBeenCalledTimes(1)
    const o = runMigrations.mock.calls[0]![0] as { releaseRef: string; dir: string; phaseFor: (f: string, t: string) => unknown; hooks: Record<string, unknown>; ledger?: string }
    expect(o.releaseRef).toBe(RELEASE)
    expect(o.dir).toBe(join(CALENDAR.dir, 'migrations'))
    // the observer is the only hook: nothing that could dump or refuse a file
    expect(Object.keys(o.hooks)).toEqual(['preApply'])
    expect(o.hooks.preApply).toBeInstanceOf(Function)
    // the phase seam is the pinned baseline of chain module-calendar
    const pinned = pinnedPhaseFor('module-calendar', PINNED_BASELINE)
    const [file, entry] = Object.entries(PINNED_BASELINE['module-calendar']!)[0]!
    const text = readFileSync(join(CALENDAR.dir, 'migrations', file), 'utf8')
    expect(o.phaseFor(file, text)).toEqual({ phase: entry.phase })
    expect(pinned(file, text)).toEqual({ phase: entry.phase })
    // a file that is in no baseline gets no phase from the seam (PHASE_MISSING then refuses it in the runner)
    expect(o.phaseFor('9999_new.sql', 'CREATE TABLE t();')).toBeUndefined()
    expect(f.ended).toEqual([tenantModuleDbName(C1, 'calendar')])
  })

  it('runs the re-grant AFTER the migrations, as the owner on the owner pool, only when a file was applied (nothing pending: no DDL at all)', async () => {
    const order: string[] = []
    runMigrations.mockImplementation(async () => {
      order.push('migrate')
      return { applied: order.length === 1 ? ['0009_x.sql', '0010_y.sql'] : [], alreadyApplied: 8 }
    })
    grantAppPrivileges.mockImplementation(async () => void order.push('grant'))
    const f = fixture([row(C1, 'calendar'), row(C2, 'calendar')])
    const r = await upgradeModuleDatabases(f.deps)
    expect(order).toEqual(['migrate', 'grant', 'migrate'])
    expect(grantAppPrivileges).toHaveBeenCalledTimes(1)
    expect(grantAppPrivileges.mock.calls[0]!.slice(1)).toEqual(['m_calendar', 'm_calendar_app'])
    expect(r).toMatchObject({ total: 2, upgraded: 1, unchanged: 1, skipped: 0, failed: 0, files_applied: 2, failure: null })
  })

  it('the first failure stops the loop: the databases after it are not opened and not counted, and the counts still add up', async () => {
    runMigrations.mockResolvedValueOnce({ applied: ['0009_x.sql'], alreadyApplied: 8 })
    runMigrations.mockRejectedValueOnce(new MigrationRunnerError('APPLY_FAILED', 'secret detail', ['0009_x.sql']))
    const f = fixture([row(C1, 'calendar'), row(C2, 'calendar'), row(C3, 'calendar'), row(C4, 'calendar', 'blocked')], { never: [tenantModuleDbName(C3, 'calendar')] })
    const r = await upgradeModuleDatabases(f.deps)
    expect(f.opened.map((o) => o.db)).toEqual([tenantModuleDbName(C1, 'calendar'), tenantModuleDbName(C2, 'calendar')])
    expect(r).toMatchObject({ total: 3, upgraded: 1, unchanged: 0, skipped: 1, failed: 1, files_applied: 1 })
    expect(r.upgraded + r.unchanged + r.skipped + r.failed).toBe(r.total)
    expect(r.failure).toEqual({ kind: 'commit', code: 'APPLY_FAILED', ordinal: 2, file: '0009_x.sql' })
    expect(f.ended).toHaveLength(2) // the pool of the failed database is ended too
  })

  it('files applied before a failing file are counted from the runner\'s own lines (the runner drops its list when it throws)', async () => {
    runMigrations.mockImplementationOnce(async (o: { log: (l: string) => void }) => {
      o.log('applied 0009_a.sql')
      o.log('applied 0010_b.sql')
      o.log('waiting for the migration lock (held by pid 7 \'some-app\'); giving up after 600000 ms')
      throw new MigrationRunnerError('APPLY_FAILED', '0011_c.sql failed', ['0011_c.sql'])
    })
    const lines: string[] = []
    const f = fixture([row(C1, 'calendar')])
    f.deps.log = (l) => lines.push(l)
    const r = await upgradeModuleDatabases(f.deps)
    expect(r.files_applied).toBe(2)
    expect(r.failure?.file).toBe('0011_c.sql')
    expect(lines).toEqual(['applied 0009_a.sql', 'applied 0010_b.sql'])
  })

  it('a missing environment value for a module server surfaces BEFORE any database is opened (a precondition, not a failure half way)', async () => {
    const f = fixture([row(C1, 'calendar'), row(C2, 'finance')], { serverError: new Error('required env MODULE_PG_ADMIN_FINANCE_FILE is not set') })
    await expect(upgradeModuleDatabases(f.deps)).rejects.toThrow(/MODULE_PG_ADMIN_FINANCE_FILE/)
    expect(f.opened).toEqual([])
    expect(runMigrations).not.toHaveBeenCalled()
  })

  it('the result holds counts and fixed codes only: no module key, database name or customer id, and no error message', async () => {
    runMigrations.mockRejectedValueOnce(new Error(`relation "t_secret__zzhostile" does not exist for acme-slug`))
    const f = fixture([row(C1, 'zzhostile')])
    const r = await upgradeModuleDatabases(f.deps)
    const text = JSON.stringify(r)
    for (const s of ['zzhostile', C1, C1.replaceAll('-', ''), 'acme-slug', 't_secret']) expect(text).not.toContain(s)
    expect(r.failure).toEqual({ kind: 'commit', code: 'error', ordinal: 1, file: null })
  })
})

describe('commit failure or connection failure (exit 1 or 3 of the verb)', () => {
  const sqlErr = (code: string) => Object.assign(new Error('m'), { code })
  const connectionCases: [string, Error][] = [
    ['ECONNREFUSED', sqlErr('ECONNREFUSED')],
    ['ETIMEDOUT', sqlErr('ETIMEDOUT')],
    ['EHOSTUNREACH', sqlErr('EHOSTUNREACH')],
    ['CONNECT_TIMEOUT', sqlErr('CONNECT_TIMEOUT')],
    ['57P01', sqlErr('57P01')],
    ['57P02', sqlErr('57P02')],
    ['57P03', sqlErr('57P03')],
    ['53100', sqlErr('53100')],
    ['08006', sqlErr('08006')],
    ['an AggregateError whose member is refused', Object.assign(new AggregateError([sqlErr('ECONNREFUSED')], 'all attempts failed'))],
  ]

  it.each(connectionCases)('%s before any DDL, on the first query to the database, is a connection failure', async (_n, err) => {
    const f = fixture([row(C1, 'calendar')], { adminAnswer: () => err })
    const r = await upgradeModuleDatabases(f.deps)
    expect(r).toMatchObject({ failed: 1, total: 1, failure: { kind: 'connection', ordinal: 1 } })
    expect(f.opened).toEqual([])
  })

  it.each(connectionCases)('%s raised by the runner before its first file begins is a connection failure', async (_n, err) => {
    runMigrations.mockRejectedValueOnce(err)
    const r = await upgradeModuleDatabases(fixture([row(C1, 'calendar')]).deps)
    expect(r.failure).toMatchObject({ kind: 'connection' })
  })

  it('the SAME code after the runner began a file (a connection lost in the middle of a file) is the commit failure', async () => {
    runMigrations.mockImplementationOnce(async (o: { hooks: { preApply: (f: string) => void } }) => {
      o.hooks.preApply('0009_x.sql')
      throw sqlErr('ECONNRESET')
    })
    const r = await upgradeModuleDatabases(fixture([row(C1, 'calendar')]).deps)
    expect(r.failure).toMatchObject({ kind: 'commit', code: 'connection_ECONNRESET' })
  })

  it('a rolled back file whose cause is a connection error (APPLY_FAILED) is the commit failure whatever its cause', async () => {
    runMigrations.mockRejectedValueOnce(new MigrationRunnerError('APPLY_FAILED', 'x', ['0009_x.sql'], { cause: sqlErr('57P01') }))
    const r = await upgradeModuleDatabases(fixture([row(C1, 'calendar')]).deps)
    expect(r.failure).toMatchObject({ kind: 'commit', code: 'APPLY_FAILED' })
  })

  it('a connection error during the re-grant is the commit failure (the files are committed)', async () => {
    runMigrations.mockResolvedValueOnce({ applied: ['0009_x.sql'], alreadyApplied: 1 })
    grantAppPrivileges.mockRejectedValueOnce(sqlErr('ECONNREFUSED'))
    const r = await upgradeModuleDatabases(fixture([row(C1, 'calendar')]).deps)
    expect(r).toMatchObject({ failed: 1, files_applied: 1, failure: { kind: 'commit', code: 'connection_ECONNREFUSED' } })
  })

  it.each([
    ['an SQL error of a file', new MigrationRunnerError('APPLY_FAILED', 'x', ['0009_x.sql'])],
    ['a runner refusal: unknown ledger row', new MigrationRunnerError('LEDGER_UNKNOWN_FILE', 'x', ['0004_a.sql'])],
    ['a runner refusal: hash mismatch', new MigrationRunnerError('LEDGER_HASH_MISMATCH', 'x', ['0004_a.sql'])],
    ['a runner refusal: a headerless file with no phase', new MigrationRunnerError('PHASE_MISSING', 'x', ['0009_x.sql'])],
    ['a runner refusal: the lock was not granted in time', new MigrationRunnerError('LOCK_TIMEOUT', 'x')],
    ['a plain SQL error of the re-grant', sqlErr('42501')],
  ])('%s is a commit failure, never exit 3', async (_n, err) => {
    runMigrations.mockRejectedValueOnce(err)
    const r = await upgradeModuleDatabases(fixture([row(C1, 'calendar')]).deps)
    expect(r.failure?.kind).toBe('commit')
  })

  it('a platform that cannot be reached is a connection failure with zero counts; one that cannot be read for another reason is thrown', async () => {
    const down = fixture([], { platformAnswer: () => sqlErr('ECONNREFUSED') })
    expect(await upgradeModuleDatabases(down.deps)).toMatchObject({ total: 0, failed: 0, failure: { kind: 'connection', ordinal: 0 } })
    const broken = fixture([], { platformAnswer: () => sqlErr('42P01') })
    await expect(upgradeModuleDatabases(broken.deps)).rejects.toMatchObject({ code: '42P01' })
  })

  it('connectionLevelCode reads the code, the cause chain and AggregateError members, and nothing else', () => {
    expect(connectionLevelCode(sqlErr('ECONNREFUSED'))).toBe('ECONNREFUSED')
    expect(connectionLevelCode(new Error('x', { cause: sqlErr('57P01') }))).toBe('57P01')
    expect(connectionLevelCode(sqlErr('23505'))).toBeNull()
    expect(connectionLevelCode(sqlErr('55P03'))).toBeNull()
    expect(connectionLevelCode(new Error('ECONNREFUSED in the message only'))).toBeNull()
    expect(connectionLevelCode(null)).toBeNull()
  })
})
