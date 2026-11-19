// CD stage 1, unit U6g: the retire of one database's dump (retireDump, retireDatabaseDumps), the root owner
// hand-over (ownerUid), and the server fields of a module-server dump line. No database: a fake exporter and a
// fake DumpFs on a real scratch directory. The real-uid half (a real root process, a real uid 1000) is
// test/integration/enable-catchup-uid.test.ts.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { Exporter } from '../lifecycle/types.js'
import { appendEvent, DumpError, LEDGER_FILE, LEDGER_LOCK, liveDumps, readEvents, type DumpEvent } from './ledger.js'
import { retireDatabaseDumps, retireDump } from './retire.js'
import { checkDumpDir, handOverFor, takeDump, type DumpFs, type TakeDumpOptions } from './take.js'

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
const SCRATCH = fileURLToPath(new URL('../../../../.scratch/u6g-retire/', import.meta.url))
function freshDir(): string {
  mkdirSync(SCRATCH, { recursive: true })
  const d = mkdtempSync(join(SCRATCH, 'dump-'))
  roots.push(d)
  return d
}

const DB_A = 't_0192f0c12b3c7d4e8f00112233445566__finance'
const DB_B = 't_0192f0c12b3c7d4e8f00aabbccddeeff__calendar'
const CUSTOMER_A = '0192f0c1-2b3c-7d4e-8f00-112233445566'

function fsAs(over: { uid?: number | undefined; owner?: number; mode?: number } = {}, chowns?: [string, number][]): DumpFs {
  return {
    statDir: () => ({ isDirectory: true, mode: over.mode ?? 0o700, uid: over.owner ?? 1000 }),
    freeBytes: () => 10 ** 12,
    uid: 'uid' in over ? over.uid : 1000,
    ...(chowns ? { chown: (p: string, uid: number) => void chowns.push([p, uid]) } : {}),
  }
}

function fakeExporter(): Exporter & { services: string[] } {
  const services: string[] = []
  return {
    services,
    async dump(target, file) {
      services.push(target.service)
      writeFileSync(file, `PGDMP fake dump of ${target.database}`, { flag: 'wx', mode: 0o600 })
    },
    async list(file) {
      const db = /(t_[0-9a-f]{32}__[a-z]+)\./.exec(file)?.[1] ?? 'gremion_platform'
      return `;\n; Archive created at 2026-11-17 03:00:00 UTC\n;     dbname: ${db}\n`
    },
  }
}

const probe = { serverMajor: async () => 18, pgDumpMajor: async () => 18, databaseBytes: async () => 1000 }

function take(dir: string, over: Partial<TakeDumpOptions> = {}) {
  const database = over.database ?? DB_A
  const mod = /__([a-z]+)$/.exec(database)![1]!
  return takeDump({
    dir,
    release: 'dist-v1.0.0',
    database,
    scope: 'customer',
    customerId: CUSTOMER_A,
    moduleId: mod,
    exporter: fakeExporter(),
    probe,
    fs: fsAs(),
    audit: () => {},
    ...over,
  })
}

const reasonOf = (dir: string) => readEvents(dir).filter((e) => e.event === 'deleted')

describe('retireDump: one database of one release', () => {
  it('unlinks the file and its acl sidecar, closes the ledger line (the host shape), removes the empty release directory', async () => {
    const dir = freshDir()
    const d = await take(dir)
    const acl = d.path.replace(/\.dump$/, '.acl.json')
    writeFileSync(acl, '{"v":1}')
    const lines: string[] = []

    const r = await retireDump(dir, 'dist-v1.0.0', DB_A, 'enable committed', { fs: fsAs(), audit: (l) => lines.push(l) })

    expect(r.retired).toEqual([d.id])
    expect(existsSync(d.path)).toBe(false)
    expect(existsSync(acl)).toBe(false)
    expect(existsSync(join(dir, 'dist-v1.0.0'))).toBe(false)
    expect(liveDumps(readEvents(dir))).toEqual([])
    const gone = reasonOf(dir)
    expect(gone).toHaveLength(1)
    expect(gone[0]).toMatchObject({ v: 1, event: 'deleted', migration_dump_id: d.id, release: 'dist-v1.0.0', scope: 'customer', customer_id: CUSTOMER_A, module_id: 'finance', database: DB_A, by_kind: 'system', reason: 'enable committed' })
    expect(gone[0]!.deleted_at).toBe(gone[0]!.at)
    expect(gone[0]!.file).toBe(readEvents(dir)[0]!.file)
    expect(lines).toEqual([expect.stringMatching(/^premigration-dump deleted id=\S+ release=dist-v1\.0\.0 db=t_[0-9a-f]{32}__finance reason="enable committed"$/)])
    expect(existsSync(join(dir, LEDGER_LOCK))).toBe(false)
  })

  it('touches nothing of another database or another release; the release directory stays while another dump is in it', async () => {
    const dir = freshDir()
    const a = await take(dir)
    const b = await take(dir, { database: DB_B })
    await retireDump(dir, 'dist-v1.0.0', DB_A, 'enable committed', { fs: fsAs(), audit: () => {} })
    expect(existsSync(a.path)).toBe(false)
    expect(existsSync(b.path)).toBe(true)
    expect(liveDumps(readEvents(dir)).map((e) => e.database)).toEqual([DB_B])
    expect(existsSync(join(dir, 'dist-v1.0.0'))).toBe(true)
    // another RELEASE's live dump of the SAME database is not retired by this release's retire
    const dir2 = freshDir()
    const other = await take(dir2, { release: 'dist-vOTHER' })
    expect((await retireDump(dir2, 'dist-v1.0.0', DB_A, 'enable committed', { fs: fsAs(), audit: () => {} })).retired).toEqual([])
    expect(existsSync(other.path)).toBe(true)
    expect(liveDumps(readEvents(dir2))).toHaveLength(1)
  })

  it('a no-op without a live dump: no ledger line, and a second retire after a first is a no-op too', async () => {
    const dir = freshDir()
    expect((await retireDump(dir, 'dist-v1.0.0', DB_A, 'enable committed', { fs: fsAs(), audit: () => {} })).retired).toEqual([])
    expect(existsSync(join(dir, LEDGER_FILE))).toBe(false)
    await take(dir)
    await retireDump(dir, 'dist-v1.0.0', DB_A, 'enable committed', { fs: fsAs(), audit: () => {} })
    const before = readEvents(dir).length
    expect((await retireDump(dir, 'dist-v1.0.0', DB_A, 'enable committed', { fs: fsAs(), audit: () => {} })).retired).toEqual([])
    expect(readEvents(dir)).toHaveLength(before)
  })

  it('a retire that died after the unlink is repeated: the missing file is not an error and the line is closed', async () => {
    const dir = freshDir()
    const d = await take(dir)
    rmSync(d.path)
    expect((await retireDump(dir, 'dist-v1.0.0', DB_A, 'enable committed', { fs: fsAs(), audit: () => {} })).retired).toEqual([d.id])
    expect(liveDumps(readEvents(dir))).toEqual([])
  })

  it('after the retire a host-style take of ANOTHER label succeeds (no DUMP_SERIES); before it, it refuses', async () => {
    const dir = freshDir()
    await take(dir)
    await expect(take(dir, { release: 'dist-v2.0.0' })).rejects.toMatchObject({ code: 'DUMP_SERIES' })
    await retireDump(dir, 'dist-v1.0.0', DB_A, 'enable committed', { fs: fsAs(), audit: () => {} })
    expect((await take(dir, { release: 'dist-v2.0.0' })).status).toBe('created')
  })

  it('refuses a stale ledger lock, a corrupt ledger, a ledger line that names a file outside the directory, an empty reason, a bad release', async () => {
    const dir = freshDir()
    await take(dir)
    const code = async (p: Promise<unknown>) => ((await p.then(() => 'no error', (e: DumpError) => e.code)) as string)
    writeFileSync(join(dir, LEDGER_LOCK), '4242 2026-11-17T00:00:00Z\n')
    expect(await code(retireDump(dir, 'dist-v1.0.0', DB_A, 'r', { fs: fsAs() }))).toBe('LEDGER_LOCKED')
    rmSync(join(dir, LEDGER_LOCK))
    expect(await code(retireDump(dir, 'dist-v1.0.0', DB_A, '  ', { fs: fsAs() }))).toBe('DUMP_SCOPE')
    expect(await code(retireDump(dir, '../x', DB_A, 'r', { fs: fsAs() }))).toBe('RELEASE_INVALID')
    const evil = freshDir()
    const line: DumpEvent = { v: 1, event: 'created', at: 'x', migration_dump_id: 'id-1', release: 'dist-v1.0.0', scope: 'platform', customer_id: null, module_id: null, database: 'gremion_platform', by_kind: 'system', file: '../outside.dump', sha256: 'a', bytes: 1 }
    appendEvent(evil, line)
    expect(await code(retireDump(evil, 'dist-v1.0.0', 'gremion_platform', 'r', { fs: fsAs() }))).toBe('LEDGER_CORRUPT')
    expect(liveDumps(readEvents(evil))).toHaveLength(1)
    writeFileSync(join(dir, LEDGER_FILE), '{"not":"an event"}\n')
    expect(await code(retireDump(dir, 'dist-v1.0.0', DB_A, 'r', { fs: fsAs() }))).toBe('LEDGER_CORRUPT')
  })

  it('refuses a directory this process does not own, like every other dump call', async () => {
    const dir = freshDir()
    await expect(retireDump(dir, 'dist-v1.0.0', DB_A, 'r', { fs: fsAs({ owner: 2000 }) })).rejects.toMatchObject({ code: 'DUMP_DIR_OWNER' })
    await expect(retireDump(undefined, 'dist-v1.0.0', DB_A, 'r')).rejects.toMatchObject({ code: 'DUMP_DIR_UNSET' })
  })
})

describe('retireDatabaseDumps: every live dump of a database, whatever release took it (the day-30 drop)', () => {
  it('retires the dump of a release that is not the current one, and leaves other databases alone', async () => {
    const dir = freshDir()
    const failed = await take(dir, { release: 'dist-vFAILED' })
    const other = await take(dir, { database: DB_B, release: 'dist-vFAILED' })
    const r = await retireDatabaseDumps(dir, DB_A, 'database dropped by Karenz', { fs: fsAs(), audit: () => {} })
    expect(r.retired).toEqual([failed.id])
    expect(existsSync(failed.path)).toBe(false)
    expect(existsSync(other.path)).toBe(true)
    expect(reasonOf(dir)[0]).toMatchObject({ release: 'dist-vFAILED', reason: 'database dropped by Karenz' })
    // and a take of another label for the dropped name no longer refuses
    expect((await take(dir, { release: 'dist-vNEXT' })).status).toBe('created')
  })
})

describe('ownerUid: a root process writes into the deploy user\'s directory, and hands everything over', () => {
  it('root + a directory owned by exactly ownerUid: accepted; the release directory, the dump, the ledger and the lock go to ownerUid with their modes', async () => {
    const dir = freshDir()
    const chowns: [string, number][] = []
    const d = await take(dir, { ownerUid: 1000, fs: fsAs({ uid: 0, owner: 1000 }, chowns) })
    expect(d.status).toBe('created')
    const paths = chowns.map(([p]) => p.replace(/\\/g, '/'))
    expect(paths).toContain(join(dir, 'dist-v1.0.0').replace(/\\/g, '/'))
    expect(paths).toContain(d.path.replace(/\\/g, '/'))
    expect(paths).toContain(join(dir, LEDGER_FILE).replace(/\\/g, '/'))
    expect(paths).toContain(join(dir, LEDGER_LOCK).replace(/\\/g, '/'))
    expect(chowns.every(([, uid]) => uid === 1000)).toBe(true)
    // the retire hands the ledger over as well
    chowns.length = 0
    await retireDump(dir, 'dist-v1.0.0', DB_A, 'enable committed', { ownerUid: 1000, fs: fsAs({ uid: 0, owner: 1000 }, chowns), audit: () => {} })
    expect(chowns.map(([p]) => p.replace(/\\/g, '/'))).toEqual(expect.arrayContaining([join(dir, LEDGER_FILE).replace(/\\/g, '/'), join(dir, LEDGER_LOCK).replace(/\\/g, '/')]))
  })

  it('root with a directory owned by uid 1000 and NO ownerUid still fails DUMP_DIR_OWNER (the check is not relaxed for root)', () => {
    expect(() => checkDumpDir('/d', fsAs({ uid: 0, owner: 1000 }))).toThrowError(/DUMP_DIR_OWNER/)
    expect(() => checkDumpDir('/d', fsAs({ uid: 0, owner: 1000 }), undefined)).toThrowError(/DUMP_DIR_OWNER/)
  })

  it('root with an ownerUid that is not the directory owner (another uid, or root itself) fails DUMP_DIR_OWNER', () => {
    expect(() => checkDumpDir('/d', fsAs({ uid: 0, owner: 1000 }), 999)).toThrowError(/DUMP_DIR_OWNER/)
    expect(() => checkDumpDir('/d', fsAs({ uid: 0, owner: 0 }), 1000)).toThrowError(/DUMP_DIR_OWNER/)
    expect(checkDumpDir('/d', fsAs({ uid: 0, owner: 1000 }), 1000)).toBe('/d')
  })

  it('a non-root process owned by another uid still fails, with or without ownerUid; ownerUid does not make it root', () => {
    expect(() => checkDumpDir('/d', fsAs({ uid: 1000, owner: 2000 }))).toThrowError(/DUMP_DIR_OWNER/)
    expect(() => checkDumpDir('/d', fsAs({ uid: 1000, owner: 2000 }), 2000)).toThrowError(/DUMP_DIR_OWNER/)
    expect(() => checkDumpDir('/d', fsAs({ uid: 1000, owner: 2000 }), 1000)).toThrowError(/DUMP_DIR_OWNER/)
  })

  it('a non-root process behaves exactly as before: it owns its directory, ownerUid is ignored and nothing is chowned', async () => {
    const dir = freshDir()
    const chowns: [string, number][] = []
    const d = await take(dir, { ownerUid: 1000, fs: fsAs({ uid: 1000, owner: 1000 }, chowns) })
    expect(d.status).toBe('created')
    expect(chowns).toEqual([])
    expect(handOverFor(fsAs({ uid: 1000 }, chowns), 1000)).toBeUndefined()
    expect(handOverFor(fsAs({ uid: 0 }, chowns), undefined)).toBeUndefined()
    expect(handOverFor(fsAs({ uid: undefined }, chowns), 1000)).toBeUndefined()
  })

  it('an ownerUid that is not a uid is refused before anything is written', () => {
    for (const bad of [-1, 1.5, Number.NaN, 2 ** 32]) expect(() => checkDumpDir('/d', fsAs({ uid: 0, owner: 1000 }), bad)).toThrowError(/DUMP_DIR_OWNER/)
  })
})

describe('the server of a module-server dump is written to its ledger line (the host restore reads it)', () => {
  it('service + pgUser: pg_service and pg_user on the created line, kept on the deleted line; the exporter gets the service', async () => {
    const dir = freshDir()
    const exporter = fakeExporter()
    await take(dir, { exporter, service: 'finance-postgres', pgUser: 'finance' })
    expect(exporter.services).toEqual(['finance-postgres'])
    expect(readEvents(dir)[0]).toMatchObject({ pg_service: 'finance-postgres', pg_user: 'finance' })
    await retireDump(dir, 'dist-v1.0.0', DB_A, 'enable committed', { fs: fsAs(), audit: () => {} })
    expect(reasonOf(dir)[0]).toMatchObject({ pg_service: 'finance-postgres', pg_user: 'finance' })
  })

  it('the main server (no service, or postgres) writes neither field, as before', async () => {
    const dir = freshDir()
    await take(dir)
    await take(dir, { database: DB_B, service: 'postgres', pgUser: 'postgres' })
    for (const e of readEvents(dir)) {
      expect(e).not.toHaveProperty('pg_service')
      expect(e).not.toHaveProperty('pg_user')
    }
  })

  it('a service or role that is not a valid name is refused before pg_dump runs', async () => {
    const dir = freshDir()
    const exporter = fakeExporter()
    await expect(take(dir, { exporter, service: 'finance-postgres', pgUser: 'fin ance' })).rejects.toMatchObject({ code: 'DUMP_SCOPE' })
    await expect(take(dir, { exporter, service: 'finance', pgUser: 'finance' })).rejects.toMatchObject({ code: 'DUMP_SCOPE' })
    expect(exporter.services).toEqual([])
    expect(readdirSync(dir)).toEqual([])
  })
})
