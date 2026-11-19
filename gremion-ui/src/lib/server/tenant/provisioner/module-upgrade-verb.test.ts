// CD module step: the `module-upgrade` verb of the tenant-create one-shot
// (gremion-ui/scripts/tenant-provision-modules.ts). The migration work itself is proven in
// packages/tenant-store (unit and the throwaway-Postgres integration suite); this is the verb's
// contract: `--all` is required, ONE JSON line of counts on stdout and nothing else, printed on
// exits 0, 1 and 3, the exit code of each kind of failure, no name of a module, database or
// customer on stdout or stderr, a missing environment value is a named exit 2 before anything
// connects, and the unit changes no other case of tenant-provision.ts.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const override: { upgrade: null | ((deps: unknown) => Promise<unknown>) } = { upgrade: null }
vi.mock('@gremion/tenant-store/lifecycle', async (importOriginal) => {
  const real = await importOriginal<typeof import('@gremion/tenant-store/lifecycle')>()
  return { ...real, upgradeModuleDatabases: (deps: Parameters<typeof real.upgradeModuleDatabases>[0]) => (override.upgrade ? override.upgrade(deps) : real.upgradeModuleDatabases(deps)) }
})

const { MODULE_USAGE, MODULE_VERBS, moduleUpgradeExitCode, moduleUpgradeLine, moduleVerb } = await import('../../../../../scripts/tenant-provision-modules')
type ModuleVerbContext = import('../../../../../scripts/tenant-provision-modules').ModuleVerbContext
type LifecycleModule = import('@gremion/tenant-store/lifecycle').LifecycleModule

afterEach(() => {
  process.exitCode = undefined
  override.upgrade = null
  vi.restoreAllMocks()
})

const C1 = '0192f0c1-2b3c-7d4e-8f00-000000000001'
const C2 = '0192f0c1-2b3c-7d4e-8f00-000000000002'
const HOSTILE = ['zzsecretmod', 'acme-secret-slug', C1, C1.replaceAll('-', ''), C2.replaceAll('-', ''), 'secret-password-word', 'zzsecretmod-postgres']

const TENANT_STORE = join(process.cwd(), '..', 'packages', 'tenant-store')
const HOSTILE_MODULE: LifecycleModule = {
  id: 'zzsecretmod',
  dir: join(TENANT_STORE, 'test/fixtures/lifecycle/lcfix/'),
  moduleJson: {
    schemaVersion: 1,
    id: 'zzsecretmod',
    extractionSource: 'f276af5925abacdcfd05f6613fc11afff2d804c5',
    runtime: { version: '1.0.0', database: { postgresService: 'zzsecretmod-postgres', migrations: 'migrations' }, export: null, timedJobs: [], platformServer: null },
  } as LifecycleModule['moduleJson'],
}

interface Harness {
  c: ModuleVerbContext
  out: string[]
  err: string[]
  closed: { platform: number; servers: number }
  opened: { platform: number; servers: string[] }
}

const row = (customer: string, state = 'enabled') => ({
  customer_id: customer,
  module_key: 'zzsecretmod',
  db_name: `t_${customer.replaceAll('-', '')}__zzsecretmod`,
  state,
  enablement_state: 'enabled',
})

/** A platform that answers current_database and the listing, and counts its end(). */
function fakePlatform(rows: unknown[], h: Harness['closed']): never {
  const answer = (t: string): unknown[] => (/current_database\(\)/.test(t) ? [{ db: 'gremion_platform' }] : rows)
  return Object.assign((strings: TemplateStringsArray) => Promise.resolve(answer(strings.join('?'))), { end: async () => void (h.platform += 1) }) as never
}

/** `admin`: what the server's admin connection does for the owner query (throws, or answers). */
function harness(opts: { rows?: unknown[]; admin?: () => Promise<unknown[]>; args?: string[]; releaseRef?: () => string; moduleServer?: (s: string) => never } = {}): Harness {
  const out: string[] = []
  const err: string[] = []
  const closed = { platform: 0, servers: 0 }
  const opened = { platform: 0, servers: [] as string[] }
  const c: ModuleVerbContext = {
    args: opts.args ?? ['--all'],
    catalogue: () => [HOSTILE_MODULE],
    releaseRef: opts.releaseRef ?? (() => 'dist-v9.9.9'),
    moduleServer:
      opts.moduleServer ??
      ((service) => {
        opened.servers.push(service)
        return {
          admin: ((_s: TemplateStringsArray) => (opts.admin ? opts.admin() : Promise.resolve([]))) as never,
          open: () => {
            throw new Error('the verb test never opens an owner pool')
          },
          close: async () => void (closed.servers += 1),
        } as never
      }),
    openPlatform: () => {
      opened.platform += 1
      return fakePlatform(opts.rows ?? [], closed)
    },
    stdout: (t) => out.push(t),
    usage: (m) => new Error(`USAGE ${m}`),
    log: (l) => err.push(l),
  }
  return { c, out, err, closed, opened }
}

const noNames = (h: Harness) => {
  const text = [...h.out, ...h.err].join('\n')
  for (const s of HOSTILE) expect(text).not.toContain(s)
}
const summary = (over: Record<string, unknown> = {}) => ({ total: 4, upgraded: 2, unchanged: 1, skipped: 1, failed: 0, files_applied: 3, regranted: 0, skippedByState: { blocked: 1 }, failure: null, ...over })

describe('module-upgrade usage', () => {
  it('is the one verb of the file and is in the usage text', () => {
    expect([...MODULE_VERBS]).toEqual(['module-upgrade'])
    expect(MODULE_USAGE).toContain('module-upgrade --all')
  })

  it('--all is required: a bare module-upgrade, a single-database form and an extra argument are usage errors (exit 2 through main) and nothing connects', async () => {
    for (const args of [[], ['--slug', 'x'], ['--all', 'extra'], ['all']]) {
      const h = harness({ args })
      await expect(moduleVerb('module-upgrade', h.c)).rejects.toThrow(/^USAGE module-upgrade/)
      expect(h.opened).toEqual({ platform: 0, servers: [] })
      expect(h.out).toEqual([])
    }
  })

  it('a missing environment value is a named usage error BEFORE the platform is opened or anything connects', async () => {
    const noRef = harness({ releaseRef: () => { throw new Error('USAGE required env GREMION_RELEASE_REF is not set') } })
    await expect(moduleVerb('module-upgrade', noRef.c)).rejects.toThrow(/GREMION_RELEASE_REF/)
    expect(noRef.opened.platform).toBe(0)
    const noServer = harness({ moduleServer: () => { throw new Error('USAGE required env MODULE_PG_ADMIN_ZZSECRETMOD_FILE is not set') } })
    await expect(moduleVerb('module-upgrade', noServer.c)).rejects.toThrow(/MODULE_PG_ADMIN_ZZSECRETMOD_FILE/)
    expect(noServer.opened.platform).toBe(0)
    const noPlatform = harness()
    noPlatform.c.openPlatform = () => { throw new Error('USAGE required env PLATFORM_DATABASE_URL is not set') }
    await expect(moduleVerb('module-upgrade', noPlatform.c)).rejects.toThrow(/PLATFORM_DATABASE_URL/)
    expect(noPlatform.out).toEqual([])
  })
})

describe('module-upgrade stdout and exit codes', () => {
  it('exit 0: exactly ONE JSON line of counts, in the contract order, nothing else on stdout; the pools are closed', async () => {
    override.upgrade = async () => summary()
    const h = harness()
    await moduleVerb('module-upgrade', h.c)
    expect(h.out).toEqual(['{"v":1,"total":4,"upgraded":2,"unchanged":1,"skipped":1,"failed":0,"files_applied":3}\n'])
    expect(JSON.parse(h.out[0]!)).toEqual({ v: 1, total: 4, upgraded: 2, unchanged: 1, skipped: 1, failed: 0, files_applied: 3 })
    expect(process.exitCode).toBe(0)
    expect(h.closed).toEqual({ platform: 1, servers: 1 })
  })

  it('exit 1 (a file or the re-grant failed): the JSON line is printed, with failed 1; the code is the verb\'s own, set on process.exitCode', async () => {
    override.upgrade = async () => summary({ total: 3, upgraded: 1, skipped: 1, failed: 1, unchanged: 0, files_applied: 2, failure: { kind: 'commit', code: 'APPLY_FAILED', ordinal: 2, file: '0009_x.sql' } })
    const h = harness()
    await moduleVerb('module-upgrade', h.c)
    expect(h.out).toEqual(['{"v":1,"total":3,"upgraded":1,"unchanged":0,"skipped":1,"failed":1,"files_applied":2}\n'])
    expect(process.exitCode).toBe(1)
    expect(h.err.join('\n')).toContain('commit failure (APPLY_FAILED, 0009_x.sql)')
    expect(h.closed).toEqual({ platform: 1, servers: 1 })
  })

  it('exit 3 (a connection-level error before any DDL): the JSON line is printed', async () => {
    override.upgrade = async () => summary({ total: 1, upgraded: 0, unchanged: 0, skipped: 0, failed: 1, files_applied: 0, failure: { kind: 'connection', code: 'connection_ECONNREFUSED', ordinal: 1, file: null } })
    const h = harness()
    await moduleVerb('module-upgrade', h.c)
    expect(h.out).toEqual(['{"v":1,"total":1,"upgraded":0,"unchanged":0,"skipped":0,"failed":1,"files_applied":0}\n'])
    expect(process.exitCode).toBe(3)
  })

  it('exit 3 on an unreachable platform: all counts are 0 (failed 0, total 0), the line is still printed', async () => {
    override.upgrade = async () => summary({ total: 0, upgraded: 0, unchanged: 0, skipped: 0, failed: 0, files_applied: 0, skippedByState: {}, failure: { kind: 'connection', code: 'connection_ECONNREFUSED', ordinal: 0, file: null } })
    const h = harness()
    await moduleVerb('module-upgrade', h.c)
    expect(h.out).toEqual(['{"v":1,"total":0,"upgraded":0,"unchanged":0,"skipped":0,"failed":0,"files_applied":0}\n'])
    expect(process.exitCode).toBe(3)
  })

  it('a repaired grant is named on stderr as a count (no name), counted as unchanged, and does not change the JSON line', async () => {
    override.upgrade = async () => summary({ total: 1, upgraded: 0, unchanged: 1, skipped: 0, failed: 0, files_applied: 0, regranted: 1, skippedByState: {} })
    const h = harness()
    await moduleVerb('module-upgrade', h.c)
    expect(h.out).toEqual(['{"v":1,"total":1,"upgraded":0,"unchanged":1,"skipped":0,"failed":0,"files_applied":0}\n'])
    expect(h.err.join('\n')).toContain('0 file(s) applied, regranted 1')
    expect(process.exitCode).toBe(0)
    noNames(h)
  })

  it('a lock wait that gave up is exit 3 and says so (contention is not a commit failure)', async () => {
    override.upgrade = async () => summary({ total: 1, upgraded: 0, unchanged: 0, skipped: 0, failed: 1, files_applied: 0, skippedByState: {}, failure: { kind: 'connection', code: 'LOCK_TIMEOUT', ordinal: 1, file: null } })
    const h = harness()
    await moduleVerb('module-upgrade', h.c)
    expect(h.err.join('\n')).toContain('lock contention')
    expect(h.err.join('\n')).toContain('LOCK_TIMEOUT')
    expect(process.exitCode).toBe(3)
  })

  it('what the verb cannot turn into counts (an unexpected throw) is exit 1 with NO JSON line, and the message (which may name a database) is never printed', async () => {
    override.upgrade = async () => {
      throw Object.assign(new Error('relation "t_secret__zzsecretmod" of acme-secret-slug does not exist'), { code: '42P01' })
    }
    const h = harness()
    await moduleVerb('module-upgrade', h.c)
    expect(h.out).toEqual([])
    expect(process.exitCode).toBe(1)
    expect(h.err).toEqual(['module-upgrade: stopped before a result (42P01)'])
    expect(h.closed).toEqual({ platform: 1, servers: 1 })
    noNames(h)
  })

  it('moduleUpgradeLine and moduleUpgradeExitCode are the contract, field for field', () => {
    expect(moduleUpgradeLine({ total: 0, upgraded: 0, unchanged: 0, skipped: 0, failed: 0, files_applied: 0 })).toBe('{"v":1,"total":0,"upgraded":0,"unchanged":0,"skipped":0,"failed":0,"files_applied":0}')
    expect(moduleUpgradeExitCode({ failure: null })).toBe(0)
    expect(moduleUpgradeExitCode({ failure: { kind: 'commit', code: 'x', ordinal: 1, file: null } })).toBe(1)
    expect(moduleUpgradeExitCode({ failure: { kind: 'connection', code: 'x', ordinal: 1, file: null } })).toBe(3)
  })
})

describe('module-upgrade against the real step, with servers that fail in each connection-level way (the real driver errors are in packages/tenant-store test/unit/module-upgrade-driver.test.ts)', () => {
  const sqlError = (code: string) => Object.assign(new Error('server said no: t_secret__zzsecretmod of acme-secret-slug, secret-password-word'), { code })

  it.each([
    ['ECONNREFUSED (a refused connection)', () => Promise.reject(sqlError('ECONNREFUSED'))],
    ['ETIMEDOUT', () => Promise.reject(sqlError('ETIMEDOUT'))],
    ['EHOSTUNREACH', () => Promise.reject(sqlError('EHOSTUNREACH'))],
    ['57P01 (the server is shutting down)', () => Promise.reject(sqlError('57P01'))],
    ['57P03 (not yet accepting connections)', () => Promise.reject(sqlError('57P03'))],
    ['53100 (disk full)', () => Promise.reject(sqlError('53100'))],
    ['08006 (connection failure)', () => Promise.reject(sqlError('08006'))],
    ['CONNECT_TIMEOUT', () => Promise.reject(sqlError('CONNECT_TIMEOUT'))],
  ])('%s on the first query to a database is exit 3 with the JSON line, and no name reaches stdout or stderr', async (_n, admin) => {
    const h = harness({ rows: [row(C1)], admin })
    await moduleVerb('module-upgrade', h.c)
    expect(process.exitCode).toBe(3)
    expect(h.out).toEqual(['{"v":1,"total":1,"upgraded":0,"unchanged":0,"skipped":0,"failed":1,"files_applied":0}\n'])
    noNames(h)
  })

  it('a database that is not as the platform says is a commit failure (exit 1), not a connection failure', async () => {
    const h = harness({ rows: [row(C1)], admin: async () => [{ owner: 'postgres' }] })
    await moduleVerb('module-upgrade', h.c)
    expect(process.exitCode).toBe(1)
    expect(h.out).toEqual(['{"v":1,"total":1,"upgraded":0,"unchanged":0,"skipped":0,"failed":1,"files_applied":0}\n'])
    expect(h.err.join('\n')).toContain('DATABASE_FOREIGN_OWNER')
    noNames(h)
  })

  it('nothing to do (blocked rows only) is exit 0 with a JSON line that counts them as skipped', async () => {
    const h = harness({ rows: [row(C1, 'blocked'), row(C2, 'dropped')] })
    await moduleVerb('module-upgrade', h.c)
    expect(process.exitCode).toBe(0)
    expect(h.out).toEqual(['{"v":1,"total":2,"upgraded":0,"unchanged":0,"skipped":2,"failed":0,"files_applied":0}\n'])
    noNames(h)
  })
})

describe('tenant-provision.ts: the unit edits the usage text and adds one case block, nothing else', () => {
  const FILE = join(process.cwd(), 'scripts', 'tenant-provision.ts')

  /** The case groups of main()'s switch: consecutive labels with their body, comment-only lines left out. */
  function caseGroups(text: string): { labels: string[]; text: string; lines: number }[] {
    const lines = text.replace(/\r\n/g, '\n').split('\n')
    const start = lines.indexOf('  switch (verb) {')
    expect(start).toBeGreaterThan(0)
    const groups: { labels: string[]; body: string[] }[] = []
    let cur: { labels: string[]; body: string[] } | null = null
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i]!
      if (l === '  }') break
      if (/^ {4}(case .*|default):$/.test(l)) {
        if (cur && cur.body.length === 0) cur.labels.push(l.trim())
        else {
          cur = { labels: [l.trim()], body: [] }
          groups.push(cur)
        }
      } else if (cur && !l.trimStart().startsWith('//')) cur.body.push(l)
    }
    return groups.map((g) => ({ labels: g.labels, text: [...g.labels, ...g.body].join('\n'), lines: g.body.length }))
  }
  const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

  // sha256 (first 16 hex) of every case group of the base the unit started from. A later unit that adds a case
  // (the board plan's move verb) leaves these alone; one that edits an existing case updates its line, on purpose.
  const BASE: Record<string, string> = {
    "case undefined:": '1d276741b1e9ba96',
    "case 'init':": '785b045fc58a1736',
    "case 'phase-a':": '57963983b3270bc1',
    "case 'phase-b':": '7c8d396c01644c1a',
    "case 'activate':": 'f827a8bcefd0a05e',
    "case 'record-step':": '09133ab66d432af2',
    "case 'render-router':": '2165f4fd2d2a60dc',
    "case 'suspend':": '15cecd8b0f7a0c43',
    "case 'status':": 'f621dbeb05abd0ae',
    "case 'operator-add':": 'ea873490854b33df',
    "case 'reconcile':": 'a368303a9e86b9d3',
    "case 'delete':": 'c44f41babceed333',
    "case 'bootstrap-provisioner':": '07bde7d40e1fe606',
    "case 'materialize-config':": '5bb2693ecf633fe3',
    "case 'request-verify':": '5b8946d75d4b5425',
    "case 'provision':": '4924dbc4bf85f1a1',
    "case 'enable-module':": '42e325516eba24d8',
    "case 'import-validate':": 'ec8c5ffa12518397',
    "case 'purge-run':": 'd43afda29851b3df',
    "case 'karenz-run':": '0005e5840fdac805',
    "case 'export':": '6a777c5aecb144f2',
    'default:': '96ab88a3347877ee',
  }

  it('every case group of the base is byte-for-byte what it was; the new group is the only addition, about 15 lines', () => {
    const groups = caseGroups(readFileSync(FILE, 'utf8'))
    expect(groups.length).toBeGreaterThanOrEqual(Object.keys(BASE).length + 1)
    for (const [label, want] of Object.entries(BASE)) {
      const g = groups.find((x) => x.labels[0] === label)
      expect(g, label).toBeDefined()
      expect(hash(g!.text), `${label} changed`).toBe(want)
    }
    const added = groups.filter((g) => g.labels.includes("case 'module-upgrade':"))
    expect(added).toHaveLength(1)
    expect(added[0]!.lines).toBeLessThanOrEqual(20)
    // it calls the verb file and nothing private-only is imported by the verb file
    expect(added[0]!.text).toContain('moduleVerb(verb')
    expect(readFileSync(FILE, 'utf8').split("case 'module-upgrade':").length).toBe(2)
    expect(readFileSync(join(FILE, '..', 'tenant-provision-modules.ts'), 'utf8')).not.toMatch(/from '\.\/tenant-provision'/)
  })

  it('the usage text lists the verb', () => {
    const text = readFileSync(FILE, 'utf8')
    expect(text).toMatch(/\$\{MODULE_USAGE\}`/)
    expect(text).toContain("import { MODULE_USAGE, MODULE_VERBS, moduleVerb } from './tenant-provision-modules'")
  })
})

describe('guards: what the verb must never do', () => {
  const VERB_FILE = join(process.cwd(), 'scripts', 'tenant-provision-modules.ts')
  const STEP_FILE = join(TENANT_STORE, 'src/lifecycle/upgrade.ts')
  const code = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')

  it('neither the verb nor the step calls enableModule or disableModule, and neither writes a plt row', () => {
    for (const f of [VERB_FILE, STEP_FILE]) {
      const t = code(f)
      expect(t, f).not.toMatch(/\b(enableModule|disableModule|unblockModuleDatabase|blockModuleDatabase)\b/)
      expect(t, f).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+plt|DELETE\s+FROM)\b/i)
    }
  })
})
