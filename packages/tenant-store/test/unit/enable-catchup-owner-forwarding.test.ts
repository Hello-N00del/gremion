// CD stage 1, unit U6g: the owner uid of a ROOT one-shot reaches BOTH dump calls of the enable path. take.ts and
// retire.ts are tested with an ownerUid directly (src/dump/retire.test.ts); what no test there can see is the
// forwarding in between: GREMION_MIGRATION_DUMP_OWNER_UID -> catchupDump -> dumpHook -> takeDump, and -> retireDump.
// Drop the uid from either hop and every catch-up of the root one-shot refuses with DUMP_DIR_OWNER (fail closed, but
// the feature is dead). A root process and a directory of the deploy user are stubbed through DumpFs.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { catchupDump } from '../../src/dump/catchup.js'
import { liveDumps, readEvents } from '../../src/dump/ledger.js'
import type { DumpFs } from '../../src/dump/take.js'
import type { Exporter } from '../../src/lifecycle/types.js'

const SCRATCH = fileURLToPath(new URL('../../../../.scratch/u6g-uid/', import.meta.url))
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
const DB = 't_0192f0c12b3c7d4e8f00112233445566__finance'
const exporter: Exporter = {
  async dump(target, file) {
    writeFileSync(file, `PGDMP fake dump of ${target.database}`, { flag: 'wx', mode: 0o600 })
  },
  async list() {
    return `;\n; Archive created at 2026-11-17 03:00:00 UTC\n;     dbname: ${DB}\n`
  },
}
const ctx = { sql: (async () => [{ db: DB, major: 18, bytes: '1000' }]) as never, dir: '/x', applied: [], pending: ['002_a.sql'] } as never

function rootFs(chowned: [string, number][]): DumpFs {
  // this process is root, the directory belongs to the deploy user 1000
  return { statDir: () => ({ isDirectory: true, mode: 0o700, uid: 1000 }), freeBytes: () => 10 ** 12, uid: 0, chown: (p, u) => void chowned.push([p, u]) }
}
function freshDir(): string {
  mkdirSync(SCRATCH, { recursive: true })
  const d = mkdtempSync(join(SCRATCH, 'dump-'))
  roots.push(d)
  return d
}
const build = (dir: string, env: Record<string, string>, fs: DumpFs) =>
  catchupDump({ env: { GREMION_MIGRATION_DUMP_DIR: dir, ...env }, release: 'dist-v9.9.9', exporter, pgUserFor: () => 'finance', pgDumpMajor: async () => 18, fs, audit: () => {} })

describe('catchupDump forwards GREMION_MIGRATION_DUMP_OWNER_UID to the take and to the retire', () => {
  it('as root, with the uid set: the take and the retire both pass the owner check and hand the ledger and the dump to that uid', async () => {
    const chowned: [string, number][] = []
    const dir = freshDir()
    const c = build(dir, { GREMION_MIGRATION_DUMP_OWNER_UID: '1000' }, rootFs(chowned))

    await c.upgradeHooks('finance', 'finance-postgres')!.preApply!('002_a.sql', ctx)
    expect(liveDumps(readEvents(dir))).toHaveLength(1)
    const afterTake = chowned.length
    expect(chowned.some(([p]) => p.endsWith('.dump'))).toBe(true)

    await c.retire.afterEnable('dist-v9.9.9', DB)
    expect(liveDumps(readEvents(dir))).toEqual([])
    // the retire made its own lock as root: it went to the same uid (the ledger it appended to already belonged to it)
    expect(chowned.length).toBeGreaterThan(afterTake)
    expect(chowned.every(([, u]) => u === 1000)).toBe(true)
    expect(chowned.slice(afterTake).some(([p]) => p.endsWith('ledger.lock'))).toBe(true)
  })

  it('as root, with the uid NOT set: the take refuses DUMP_DIR_OWNER (the check is not relaxed for root), and so does a retire', async () => {
    const dir = freshDir()
    const c = build(dir, {}, rootFs([]))
    await expect(c.upgradeHooks('finance', 'finance-postgres')!.preApply!('002_a.sql', ctx)).rejects.toThrow(/DUMP_DIR_OWNER/)
    await expect(c.retire.afterEnable('dist-v9.9.9', DB)).rejects.toThrow(/DUMP_DIR_OWNER/)
    await expect(c.retire.afterDrop(DB)).rejects.toThrow(/DUMP_DIR_OWNER/)
  })

  it('afterDrop forwards the uid as well', async () => {
    const chowned: [string, number][] = []
    const dir = freshDir()
    const c = build(dir, { GREMION_MIGRATION_DUMP_OWNER_UID: '1000' }, rootFs(chowned))
    await c.upgradeHooks('finance', 'finance-postgres')!.preApply!('002_a.sql', ctx)
    const afterTake = chowned.length
    await c.retire.afterDrop(DB)
    expect(liveDumps(readEvents(dir))).toEqual([])
    expect(chowned.length).toBeGreaterThan(afterTake)
  })
})
