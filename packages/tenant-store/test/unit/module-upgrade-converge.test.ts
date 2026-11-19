// CD module step: two behaviours that keep a half-finished release from staying half-finished.
//  1. The re-grant converges. The runner commits each file on its own, so files can be committed
//     without the grant ever running (the grant failed, a later file failed, the one-shot was killed).
//     A later run with nothing pending must find that out by a READ-ONLY check and repair it, and
//     must still run no DDL when nothing is missing.
//  2. Lock contention with the live colour is the infrastructure's, not the commit's: the runner is
//     given bounded waits (the kernel chain's values), and a lock timeout is a connection-class
//     failure (the host retries) instead of a commit failure (the host blocks the release).
// Same fake deps as module-upgrade.test.ts; the runner and the re-grant are spies.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runMigrations = vi.fn()
const grantAppPrivileges = vi.fn()

vi.mock('../../src/runner.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/runner.js')>()), runMigrations: (o: unknown) => runMigrations(o) }))
vi.mock('../../src/lifecycle/enable.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lifecycle/enable.js')>()),
  grantAppPrivileges: (...a: unknown[]) => grantAppPrivileges(...a),
}))

const { upgradeModuleDatabases } = await import('../../src/lifecycle/upgrade.js')
const { MigrationRunnerError } = await import('../../src/runner.js')
const { tenantModuleDbName } = await import('../../src/names.js')
type UpgradeDeps = import('../../src/lifecycle/upgrade.js').UpgradeDeps
type LifecycleModule = import('../../src/lifecycle/types.js').LifecycleModule

const C1 = '0192f0c1-2b3c-7d4e-8f00-000000000001'
const CALENDAR: LifecycleModule = (() => {
  const dir = fileURLToPath(new URL('../../../../modules/calendar', import.meta.url))
  return { id: 'calendar', dir, moduleJson: JSON.parse(readFileSync(`${dir}/module.json`, 'utf8')) as LifecycleModule['moduleJson'] }
})()

const sqlErr = (code: string) => Object.assign(new Error('m'), { code })

/** One enabled calendar database; the owned pool answers the identity probe and the privilege check. */
/** `privileges`: what the read-only check answers; a list answers in turn (the last one repeats). `lockError`: raised by the wait for the re-grant lock. */
function fixture(privileges: { missing: boolean } | { missing: boolean }[] | Error = { missing: false }, lockError?: Error): { deps: UpgradeDeps; owned: string[]; ended: number[] } {
  const answers = Array.isArray(privileges) ? [...privileges] : null
  const owned: string[] = []
  const ended: number[] = []
  const db = tenantModuleDbName(C1, 'calendar')
  const tag = (answer: (t: string) => unknown[] | Error, sink: string[] | null, onEnd?: () => void) => {
    const run = (strings: TemplateStringsArray): Promise<unknown[]> => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim()
      sink?.push(text)
      const a = answer(text)
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a)
    }
    return Object.assign((s: TemplateStringsArray) => run(s), {
      begin: () => Promise.reject(new Error('no transaction')),
      unsafe: () => Promise.reject(new Error('no unsafe')),
      options: { max: 2 },
      end: async () => {
        onEnd?.()
      },
      // the re-grant's own connection (grantLocked)
      reserve: async () => Object.assign((s: TemplateStringsArray) => run(s), { release: () => {} }),
    }) as never
  }
  const platform = tag(
    (t) => (/current_database\(\)/.test(t) ? [{ db: 'gremion_platform' }] : [{ customer_id: C1, module_key: 'calendar', db_name: db, state: 'enabled', enablement_state: 'enabled' }]),
    null,
  )
  const deps: UpgradeDeps = {
    platform,
    catalogue: [CALENDAR],
    releaseRef: 'dist-v9.9.9',
    server: () =>
      ({
        admin: (() => Promise.resolve([{ owner: 'm_calendar' }])) as never,
        open: (name: string, o?: { role?: string }) =>
          tag(
            (t) => {
              if (lockError && /pg_advisory_lock/.test(t)) return lockError
              if (/pg_advisory_(un)?lock|set_config\('lock_timeout'/.test(t)) return []
              if (/current_database\(\)/.test(t)) return [{ db: name, usr: o?.role }]
              if (/has_schema_privilege/.test(t)) return privileges instanceof Error ? privileges : [answers ? (answers.length > 1 ? answers.shift()! : answers[0]!) : privileges]
              return new Error(`unexpected owned statement: ${t}`)
            },
            owned,
            () => void ended.push(1),
          ),
      }) as never,
  }
  return { deps, owned, ended }
}

beforeEach(() => {
  runMigrations.mockReset()
  runMigrations.mockResolvedValue({ applied: [], alreadyApplied: 0 })
  grantAppPrivileges.mockReset()
  grantAppPrivileges.mockResolvedValue(undefined)
})

describe('the re-grant converges: an interrupted grant is repaired by a later run', () => {
  it('nothing pending and the app role lacks a privilege: the re-grant runs as the owner, the database counts as unchanged, regranted is 1', async () => {
    const f = fixture({ missing: true })
    const r = await upgradeModuleDatabases(f.deps)
    expect(grantAppPrivileges).toHaveBeenCalledTimes(1)
    expect(grantAppPrivileges.mock.calls[0]!.slice(1)).toEqual(['m_calendar', 'm_calendar_app'])
    expect(f.owned.some((t) => /has_schema_privilege/.test(t))).toBe(true)
    expect(r).toMatchObject({ total: 1, upgraded: 0, unchanged: 1, regranted: 1, failed: 0, files_applied: 0, failure: null })
  })

  it('nothing pending and nothing missing: no re-grant, and no statement beyond the identity probe and the check', async () => {
    const f = fixture({ missing: false })
    const r = await upgradeModuleDatabases(f.deps)
    expect(grantAppPrivileges).not.toHaveBeenCalled()
    expect(r).toMatchObject({ unchanged: 1, regranted: 0, failure: null })
    expect(f.owned.filter((t) => !/current_database\(\)|has_schema_privilege/.test(t))).toEqual([])
  })

  it('the grant is serialised by an advisory lock of its own, and the repair checks AGAIN under it: a run that waited while another finished the grant does not grant a second time', async () => {
    // first check (unlocked): missing; second check (under the lock): the other run completed meanwhile
    const f = fixture([{ missing: true }, { missing: false }])
    const r = await upgradeModuleDatabases(f.deps)
    expect(grantAppPrivileges).not.toHaveBeenCalled()
    expect(r).toMatchObject({ unchanged: 1, regranted: 0, failure: null })
    const order = f.owned.filter((t) => /pg_advisory_lock|has_schema_privilege|pg_advisory_unlock/.test(t)).map((t) => (/pg_advisory_unlock/.test(t) ? 'unlock' : /pg_advisory_lock/.test(t) ? 'lock' : 'check'))
    expect(order).toEqual(['check', 'lock', 'check', 'unlock'])
  })

  it('a file applied: the grant runs between the lock and the unlock', async () => {
    runMigrations.mockResolvedValueOnce({ applied: ['0009_x.sql'], alreadyApplied: 1 })
    const f = fixture()
    const seen: string[] = []
    grantAppPrivileges.mockImplementation(async () => void seen.push(`grant after ${f.owned.filter((t) => /pg_advisory/.test(t)).length} lock statement(s)`))
    await upgradeModuleDatabases(f.deps)
    expect(seen).toEqual(['grant after 1 lock statement(s)'])
    expect(f.owned.filter((t) => /pg_advisory/.test(t))).toHaveLength(2)
  })

  it('a wait for the grant lock that gives up (55P03) is contention: a connection-class failure and no grant', async () => {
    const f = fixture({ missing: true }, sqlErr('55P03'))
    const r = await upgradeModuleDatabases(f.deps)
    expect(r).toMatchObject({ failed: 1, failure: { kind: 'connection', code: 'sql_55P03' } })
    expect(grantAppPrivileges).not.toHaveBeenCalled()
  })

  it('the check is read-only SQL', async () => {
    const f = fixture()
    await upgradeModuleDatabases(f.deps)
    const check = f.owned.find((t) => /has_schema_privilege/.test(t))!
    expect(check).toMatch(/^(WITH|SELECT)/)
    // privilege names inside string literals are arguments of has_*_privilege, not statements
    expect(check.replace(/'[^']*'/g, "''")).not.toMatch(/\b(GRANT|REVOKE|ALTER|CREATE|DROP|INSERT|UPDATE|DELETE|TRUNCATE)\b/)
  })

  it('a file applied: the re-grant runs and the check does not', async () => {
    runMigrations.mockResolvedValueOnce({ applied: ['0009_x.sql'], alreadyApplied: 1 })
    const f = fixture(new Error('the check must not run when a file was applied'))
    const r = await upgradeModuleDatabases(f.deps)
    expect(grantAppPrivileges).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ upgraded: 1, regranted: 0, failure: null })
  })

  it('a connection error of the check is a connection failure (no DDL began) and no grant is attempted', async () => {
    const r = await upgradeModuleDatabases(fixture(sqlErr('ECONNREFUSED')).deps)
    expect(r).toMatchObject({ failed: 1, failure: { kind: 'connection', code: 'connection_ECONNREFUSED' } })
    expect(grantAppPrivileges).not.toHaveBeenCalled()
  })

  it('a repair that fails is a commit failure; the next run tries again', async () => {
    grantAppPrivileges.mockRejectedValueOnce(sqlErr('42501'))
    const bad = await upgradeModuleDatabases(fixture({ missing: true }).deps)
    expect(bad).toMatchObject({ failed: 1, failure: { kind: 'commit', code: 'sql_42501' } })
    const again = await upgradeModuleDatabases(fixture({ missing: true }).deps)
    expect(again).toMatchObject({ failed: 0, regranted: 1, failure: null })
  })

  it('files committed and then the runner throws (a later file failed): the re-grant is attempted before the failure is reported, and the failure stays the runner\'s', async () => {
    runMigrations.mockImplementationOnce(async (o: { log: (l: string) => void }) => {
      o.log('applied 0009_a.sql')
      throw new MigrationRunnerError('APPLY_FAILED', 'secret detail', ['0010_b.sql'])
    })
    const f = fixture()
    const r = await upgradeModuleDatabases(f.deps)
    expect(grantAppPrivileges).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ failed: 1, files_applied: 1, failure: { kind: 'commit', code: 'APPLY_FAILED', file: '0010_b.sql' } })
    expect(f.ended).toHaveLength(1)
  })

  it('that best-effort re-grant never masks the runner\'s failure, even when it fails itself', async () => {
    runMigrations.mockImplementationOnce(async (o: { log: (l: string) => void }) => {
      o.log('applied 0009_a.sql')
      throw new MigrationRunnerError('UNLOCK_FAILED', 'x', [])
    })
    grantAppPrivileges.mockRejectedValueOnce(sqlErr('ECONNRESET'))
    const r = await upgradeModuleDatabases(fixture().deps)
    expect(r.failure).toMatchObject({ kind: 'commit', code: 'UNLOCK_FAILED' })
  })

  it('no file committed before the runner threw: no re-grant is attempted', async () => {
    runMigrations.mockRejectedValueOnce(new MigrationRunnerError('APPLY_FAILED', 'x', ['0009_x.sql']))
    await upgradeModuleDatabases(fixture().deps)
    expect(grantAppPrivileges).not.toHaveBeenCalled()
  })
})

describe('lock contention with the live colour is the infrastructure\'s, not the commit\'s', () => {
  it('the runner gets a bounded lock wait and a bounded DDL lock timeout (the kernel chain\'s values)', async () => {
    await upgradeModuleDatabases(fixture().deps)
    const o = runMigrations.mock.calls[0]![0] as { lockWaitTimeoutMs?: number; ddlLockTimeoutMs?: number }
    expect(o.lockWaitTimeoutMs).toBe(60_000)
    expect(o.ddlLockTimeoutMs).toBe(5_000)
  })

  it('both limits can be set by the caller', async () => {
    const f = fixture()
    await upgradeModuleDatabases({ ...f.deps, lockWaitTimeoutMs: 1_000, ddlLockTimeoutMs: 250 })
    expect(runMigrations.mock.calls[0]![0]).toMatchObject({ lockWaitTimeoutMs: 1_000, ddlLockTimeoutMs: 250 })
  })

  it('LOCK_TIMEOUT (the migration lock was not granted in time) is a connection-class failure: the host retries', async () => {
    runMigrations.mockRejectedValueOnce(new MigrationRunnerError('LOCK_TIMEOUT', 'x', [], { cause: sqlErr('55P03') }))
    const r = await upgradeModuleDatabases(fixture().deps)
    expect(r.failure).toMatchObject({ kind: 'connection', code: 'LOCK_TIMEOUT' })
    expect(grantAppPrivileges).not.toHaveBeenCalled()
  })

  it('a file rolled back because its DDL lock timed out (55P03 under APPLY_FAILED) is a connection-class failure; files committed before it are counted and re-granted', async () => {
    runMigrations.mockImplementationOnce(async (o: { log: (l: string) => void; hooks: { preApply: (f: string) => void } }) => {
      o.log('applied 0009_a.sql')
      o.hooks.preApply('0010_b.sql')
      throw new MigrationRunnerError('APPLY_FAILED', 'x', ['0010_b.sql'], { cause: sqlErr('55P03') })
    })
    const r = await upgradeModuleDatabases(fixture().deps)
    expect(r).toMatchObject({ failed: 1, files_applied: 1, failure: { kind: 'connection', code: 'APPLY_FAILED', file: '0010_b.sql' } })
    expect(grantAppPrivileges).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a deadlock', sqlErr('40P01')],
    ['an error of the file', sqlErr('42P01')],
    ['no cause', undefined],
  ])('every other APPLY_FAILED is still the commit failure (%s)', async (_n, cause) => {
    runMigrations.mockRejectedValueOnce(new MigrationRunnerError('APPLY_FAILED', 'x', ['0009_x.sql'], cause ? { cause } : undefined))
    const r = await upgradeModuleDatabases(fixture().deps)
    expect(r.failure?.kind).toBe('commit')
  })
})
