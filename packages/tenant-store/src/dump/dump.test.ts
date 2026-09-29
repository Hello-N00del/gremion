// TASK-075 TDD 7 / 10 (no-database half): takeDump's checks and ledger, the
// dump hook's once-per-run, composePreApply's order, and the cli's refusals.
// The database half (a real pg_dump under the runner's lock) is
// test/integration/dump.test.ts.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Exporter } from '../lifecycle/types.js'
import { runCli, parsePgDumpMajor } from './cli.js'
import { composePreApply, dumpHook, scopeOf } from './hook.js'
import { appendEvent, DumpError, LEDGER_FILE, LEDGER_LOCK, liveDumps, readEvents, type DumpEvent } from './ledger.js'
import { checkDumpDir, takeDump, uuidv7, type DumpFs, type TakeDumpOptions } from './take.js'

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 't075-dump-'))
  roots.push(d)
  return d
}

/** A POSIX-looking dump dir: 0700, owned by uid 1000, plenty of space. */
function posixFs(over: Partial<{ mode: number; uid: number; owner: number; free: number; isDirectory: boolean }> = {}): DumpFs {
  return {
    statDir: () => ({ isDirectory: over.isDirectory ?? true, mode: over.mode ?? 0o700, uid: over.owner ?? 1000 }),
    freeBytes: () => over.free ?? 10 ** 12,
    uid: 'uid' in over ? over.uid : 1000,
  }
}

function fakeExporter(o: { fail?: boolean; dbname?: string } = {}): Exporter & { dumps: string[] } {
  const dumps: string[] = []
  return {
    dumps,
    async dump(target, file) {
      dumps.push(target.database)
      writeFileSync(file, `PGDMP fake dump of ${target.database}`, { flag: 'wx', mode: 0o600 })
      if (o.fail) throw new Error('pg_dump exited 1: connection refused')
    },
    async list() {
      return `;\n; Archive created at 2026-09-29 03:00:00 UTC\n;     dbname: ${o.dbname ?? 'gremion_platform'}\n`
    },
  }
}

const probe = (o: { server?: number; pgDump?: number; bytes?: number } = {}) => ({
  serverMajor: async () => o.server ?? 18,
  pgDumpMajor: async () => o.pgDump ?? 18,
  databaseBytes: async () => o.bytes ?? 1000,
})

function opts(dir: string, over: Partial<TakeDumpOptions> = {}): TakeDumpOptions & { lines: string[] } {
  const lines: string[] = []
  return {
    dir,
    release: 'dist-v1.2.0',
    database: 'gremion_platform',
    scope: 'platform',
    exporter: fakeExporter(),
    probe: probe(),
    fs: posixFs(),
    audit: (l) => lines.push(l),
    lines,
    ...over,
  }
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    return (e as DumpError).code ?? (e as Error).message
  }
  return 'no error'
}

describe('takeDump (TRD-206)', () => {
  it('takes one dump: <release>/<db>.<uuidv7>.dump, one fsynced `created` line with sha256 and bytes, one audit line', async () => {
    const dir = freshDir()
    const o = opts(dir)
    const d = await takeDump(o)
    expect(d.status).toBe('created')
    expect(d.path).toMatch(/dist-v1\.2\.0[\\/]gremion_platform\.[0-9a-f-]{36}\.dump$/)
    const events = readEvents(dir)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ event: 'created', release: 'dist-v1.2.0', scope: 'platform', customer_id: null, database: 'gremion_platform', sha256: d.sha256, bytes: d.bytes, by_kind: 'system' })
    expect(d.bytes).toBeGreaterThan(0)
    expect(o.lines).toEqual([expect.stringMatching(/^premigration-dump created id=\S+ release=dist-v1\.2\.0 db=gremion_platform sha256=[0-9a-f]{64} bytes=\d+$/)])
    expect(existsSync(join(dir, LEDGER_LOCK))).toBe(false)
  })

  it('the same release reuses its live dump (no second pg_dump, no second line)', async () => {
    const dir = freshDir()
    const ex = fakeExporter()
    const first = await takeDump(opts(dir, { exporter: ex }))
    const o = opts(dir, { exporter: ex })
    const again = await takeDump(o)
    expect(again).toMatchObject({ status: 'reused', id: first.id, sha256: first.sha256 })
    expect(ex.dumps).toHaveLength(1)
    expect(readEvents(dir)).toHaveLength(1)
    expect(o.lines).toEqual([expect.stringMatching(/^premigration-dump reused id=/)])
  })

  it('DUMP_SERIES: another release with a live dump of this database refuses before pg_dump; after its `deleted` line it may', async () => {
    const dir = freshDir()
    const first = await takeDump(opts(dir))
    const ex = fakeExporter()
    const o = opts(dir, { release: 'dist-v1.3.0', exporter: ex })
    const err = await takeDump(o).catch((e: DumpError) => e)
    expect((err as DumpError).code).toBe('DUMP_SERIES')
    expect((err as Error).message).toMatch(/gremion-migration-dump restore --release dist-v1\.2\.0 --db gremion_platform --accept-loss-since/)
    expect((err as Error).message).toMatch(/gremion-migration-dump discard --release dist-v1\.2\.0 --reason/)
    expect(ex.dumps).toEqual([])
    appendEvent(dir, { ...(readEvents(dir)[0] as DumpEvent), event: 'deleted', at: new Date().toISOString(), deleted_at: new Date().toISOString(), reason: 'switched', migration_dump_id: first.id })
    expect((await takeDump(opts(dir, { release: 'dist-v1.3.0' }))).status).toBe('created')
  })

  it('a live dump of ANOTHER database is no series', async () => {
    const dir = freshDir()
    await takeDump(opts(dir))
    const tenant = 't_0192f0c12b3c7d4e8f00112233445566__board'
    const d = await takeDump(opts(dir, { release: 'dist-v1.3.0', database: tenant, scope: 'customer', customerId: '0192f0c1-2b3c-7d4e-8f00-112233445566', moduleId: 'board', exporter: fakeExporter({ dbname: tenant }) }))
    expect(d.status).toBe('created')
    expect(liveDumps(readEvents(dir))).toHaveLength(2)
  })

  it('pg_dump exit 1: PG_DUMP_FAILED, the partial file removed, no ledger line', async () => {
    const dir = freshDir()
    expect(await code(takeDump(opts(dir, { exporter: fakeExporter({ fail: true }) })))).toBe('PG_DUMP_FAILED')
    expect(readEvents(dir)).toEqual([])
    expect(readdirSync(join(dir, 'dist-v1.2.0'))).toEqual([])
  })

  it('an archive whose TOC names another database is DUMP_UNVERIFIED and removed', async () => {
    const dir = freshDir()
    expect(await code(takeDump(opts(dir, { exporter: fakeExporter({ dbname: 'other' }) })))).toBe('DUMP_UNVERIFIED')
    expect(readEvents(dir)).toEqual([])
    expect(readdirSync(join(dir, 'dist-v1.2.0'))).toEqual([])
  })

  it('dir unset, not a directory, 0755, foreign owner, no uid: refused before pg_dump', async () => {
    const dir = freshDir()
    const ex = fakeExporter()
    expect(await code(takeDump(opts(dir, { dir: undefined, exporter: ex })))).toBe('DUMP_DIR_UNSET')
    expect(await code(takeDump(opts(dir, { dir: '', exporter: ex })))).toBe('DUMP_DIR_UNSET')
    expect(await code(takeDump(opts(dir, { fs: posixFs({ isDirectory: false }), exporter: ex })))).toBe('DUMP_DIR_INVALID')
    expect(await code(takeDump(opts(dir, { fs: posixFs({ mode: 0o755 }), exporter: ex })))).toBe('DUMP_DIR_MODE')
    expect(await code(takeDump(opts(dir, { fs: posixFs({ owner: 0 }), exporter: ex })))).toBe('DUMP_DIR_OWNER')
    expect(await code(takeDump(opts(dir, { fs: posixFs({ uid: undefined }), exporter: ex })))).toBe('DUMP_DIR_OWNER')
    expect(ex.dumps).toEqual([])
    expect(readEvents(dir)).toEqual([])
  })

  it('free space < 1.2 x pg_database_size: DUMP_SPACE; exactly 1.2 x passes', async () => {
    const dir = freshDir()
    expect(await code(takeDump(opts(dir, { fs: posixFs({ free: 1199 }), probe: probe({ bytes: 1000 }) })))).toBe('DUMP_SPACE')
    expect(readEvents(dir)).toEqual([])
    expect((await takeDump(opts(dir, { fs: posixFs({ free: 1200 }), probe: probe({ bytes: 1000 }) }))).status).toBe('created')
  })

  it('pg_dump 17 against server 18: PG_DUMP_VERSION; 19 against 18 passes', async () => {
    const dir = freshDir()
    const ex = fakeExporter()
    expect(await code(takeDump(opts(dir, { probe: probe({ pgDump: 17, server: 18 }), exporter: ex })))).toBe('PG_DUMP_VERSION')
    expect(ex.dumps).toEqual([])
    expect((await takeDump(opts(dir, { probe: probe({ pgDump: 19, server: 18 }) }))).status).toBe('created')
  })

  it('a stale ledger.lock refuses (never auto-broken); a corrupt ledger line refuses', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, LEDGER_LOCK), '4242 2026-09-29T00:00:00Z\n')
    expect(await code(takeDump(opts(dir)))).toBe('LEDGER_LOCKED')
    expect(existsSync(join(dir, LEDGER_LOCK))).toBe(true)
    rmSync(join(dir, LEDGER_LOCK))
    writeFileSync(join(dir, LEDGER_FILE), '{"not":"an event"}\n')
    expect(await code(takeDump(opts(dir)))).toBe('LEDGER_CORRUPT')
  })

  it('a release ref that is not a safe directory name is refused', async () => {
    const dir = freshDir()
    for (const release of ['', '../x', 'a/b', 'x'.repeat(65)]) expect(await code(takeDump(opts(dir, { release })))).toBe('RELEASE_INVALID')
  })

  it('checkDumpDir on the real filesystem refuses a missing directory', () => {
    expect(() => checkDumpDir(join(freshDir(), 'absent'), posixFs())).not.toThrow() // injected stat says it exists
    expect(() => checkDumpDir(join(freshDir(), 'absent'))).toThrow(DumpError)
  })
})

describe('the dump hook and composePreApply', () => {
  const fakeCtx = (db: string) => {
    const queries: string[] = []
    const sql = ((strings: TemplateStringsArray) => {
      queries.push(strings.join('?'))
      return Promise.resolve([{ db, major: 18, bytes: '1000' }])
    }) as never
    return { ctx: { sql, dir: '/x', applied: [], pending: ['0004_a.sql', '0005_b.sql'] }, queries }
  }

  it('dumps once per run (the first pending file), never again for the same ctx', async () => {
    const dir = freshDir()
    const ex = fakeExporter()
    const hook = dumpHook({ dir, release: 'dist-v1.2.0', exporter: ex, pgDumpMajor: async () => 18, fs: posixFs(), audit: () => {} })
    const { ctx } = fakeCtx('gremion_platform')
    await hook('0004_a.sql', ctx)
    await hook('0005_b.sql', ctx)
    expect(ex.dumps).toEqual(['gremion_platform'])
    expect(readEvents(dir).map((e) => e.event)).toEqual(['created'])
  })

  it('composePreApply runs hooks in order; a refusing first hook (the chain check) means no dump and no `created` line', async () => {
    const dir = freshDir()
    const ex = fakeExporter()
    const order: string[] = []
    const refuse = () => {
      order.push('chain')
      throw Object.assign(new Error('LEDGER_NAME_NOT_IN_CHAIN: x'), { code: 'LEDGER_NAME_NOT_IN_CHAIN' })
    }
    const pre = composePreApply(refuse, dumpHook({ dir, release: 'dist-v1.2.0', exporter: ex, pgDumpMajor: async () => 18, fs: posixFs(), audit: () => order.push('dump') }))
    await expect(pre('0004_a.sql', fakeCtx('gremion_platform').ctx as never)).rejects.toThrow(/LEDGER_NAME_NOT_IN_CHAIN/)
    expect(order).toEqual(['chain'])
    expect(ex.dumps).toEqual([])
    expect(readEvents(dir)).toEqual([])
    const ok: string[] = []
    await composePreApply(() => void ok.push('a'), undefined, () => void ok.push('b'))('f', fakeCtx('x').ctx as never)
    expect(ok).toEqual(['a', 'b'])
  })

  it('scopeOf: the platform, a (tenant, module) database, anything else refused', () => {
    expect(scopeOf('gremion_platform')).toEqual({ scope: 'platform', customerId: null, moduleId: null })
    expect(scopeOf('t_0192f0c12b3c7d4e8f00112233445566__board')).toEqual({ scope: 'customer', customerId: '0192f0c1-2b3c-7d4e-8f00-112233445566', moduleId: 'board' })
    expect(() => scopeOf('kernel')).toThrow(/DUMP_SCOPE/)
  })
})

describe('small parts', () => {
  it('uuidv7 is a canonical v7 carrying the timestamp', () => {
    const at = new Date('2026-09-29T03:00:00.000Z')
    const id = uuidv7(at)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(at.getTime())
  })

  it('parsePgDumpMajor reads the major, refuses garbage', () => {
    expect(parsePgDumpMajor('pg_dump (PostgreSQL) 18.1\n')).toBe(18)
    expect(parsePgDumpMajor('pg_dump (PostgreSQL) 17.6 (Debian 17.6-1.pgdg13+1)')).toBe(17)
    expect(() => parsePgDumpMajor('bash: pg_dump: command not found')).toThrow(/PG_DUMP_VERSION/)
  })

  it('cli: usage is exit 2; a chain that is not tenant-store class is exit 2 naming its class', async () => {
    const io = { lines: [] as string[], out(l: string) { this.lines.push(l) }, err(l: string) { this.lines.push(l) } }
    expect(await runCli([], {}, io)).toBe(2)
    expect(await runCli(['migrate', '--chain'], {}, io)).toBe(2)
    expect(await runCli(['migrate', '--chain', 'kernel-data', '--release', 'dist-v1.0.0'], {}, io)).toBe(2)
    expect(io.lines.join('\n')).toMatch(/class legacy-boot, not tenant-store/)
    expect(await runCli(['migrate', '--chain', 'platform', '--release', 'dist-v1.0.0'], {}, io)).toBe(2)
    expect(io.lines.join('\n')).toMatch(/GREMION_MIGRATE_URL is not set/)
  })

  it('ledger events survive a round trip; liveDumps drops a deleted one', () => {
    const dir = freshDir()
    mkdirSync(join(dir, 'x'), { recursive: true })
    const base: DumpEvent = { v: 1, event: 'created', at: 'now', migration_dump_id: 'a', release: 'r', scope: 'platform', customer_id: null, module_id: null, database: 'd', by_kind: 'system' }
    appendEvent(dir, base)
    appendEvent(dir, { ...base, migration_dump_id: 'b' })
    appendEvent(dir, { ...base, event: 'deleted', reason: 'switched' })
    expect(liveDumps(readEvents(dir)).map((e) => e.migration_dump_id)).toEqual(['b'])
    expect(readFileSync(join(dir, LEDGER_FILE), 'utf8').trim().split('\n')).toHaveLength(3)
  })
})
