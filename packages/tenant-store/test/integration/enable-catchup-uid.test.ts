// CD stage 1, unit U6g: the uid model with the REAL uids, not a stub. The tenant-create one-shot runs as root, the dump
// directory is 0700 and owned by the deploy user (uid 1000), and the host program that reads, verifies and retires the
// dumps runs as that user. A real root process (a container) takes a dump with `ownerUid` 1000; then, as a real uid 1000,
// the file is read, its sha256 is checked against the ledger and the host-style retire runs. The file, the release
// directory and the ledger end owned by 1000 with modes 0600 and 0700. A root process on that directory with NO
// `ownerUid` still fails DUMP_DIR_OWNER, and a non-root process of another uid still fails.
//
// This needs a root process and two other uids, which a CI runner is not, so it runs in a throwaway container of the
// node image (one root process; the deploy-user halves are child processes of it with uid/gid set). The dump code
// that runs there is the real take.ts, ledger.ts and retire.ts, transpiled file by file (no bundle, no dependency).
// It never skips: a runner without docker fails here, as the rest of this suite would.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import { EXPORT_ROOT } from '../harness/lifecycle.js'

const DUMP_SRC = fileURLToPath(new URL('../../src/dump/', import.meta.url))
const IMAGE = 'node:26-alpine'
const DB = 't_0192f0c12b3c7d4e8f00112233445566__finance'

const COMMON = `
const DB = '${DB}'
const exporter = {
  async dump(t, f) { writeFileSync(f, 'PGDMP fake dump of ' + t.database, { flag: 'wx', mode: 0o600 }) },
  async list() { return ';\\n; Archive created at 2026-11-17 03:00:00 UTC\\n;     dbname: ' + DB + '\\n' },
}
const probe = { serverMajor: async () => 18, pgDumpMajor: async () => 18, databaseBytes: async () => 1000 }
const base = (dir, release) => ({ dir, release, database: DB, scope: 'customer', customerId: '0192f0c1-2b3c-7d4e-8f00-112233445566', moduleId: 'finance', exporter, probe, audit: () => {} })
const stat = (p) => { const s = statSync(p); return { uid: s.uid, mode: (s.mode & 0o777).toString(8) } }
const code = async (p) => p.then(() => 'no error', (e) => e.code ?? String(e.message))
`

// runs as root
const SCENARIO = `
import { chmodSync, chownSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { takeDump } from './take.js'
${COMMON}
const dir = '/tmp/dumps'
mkdirSync(dir, { mode: 0o700 })
chownSync(dir, 1000, 1000)
chmodSync(dir, 0o700)
const out = { uid: process.getuid() }
out.rootNoOwnerUid = await code(takeDump(base(dir, 'dist-v1')))
out.rootWrongOwnerUid = await code(takeDump({ ...base(dir, 'dist-v1'), ownerUid: 999 }))
const taken = await takeDump({ ...base(dir, 'dist-v1'), ownerUid: 1000 })
out.take = taken.status
out.stat = { dir: stat(dir), release: stat(dir + '/dist-v1'), dump: stat(taken.path), ledger: stat(dir + '/ledger.jsonl') }
out.lockGone = !existsSync(dir + '/ledger.lock')
const run = (script) => {
  const r = spawnSync(process.execPath, ['/work/' + script, dir], { uid: script === 'as-other.mjs' ? 1001 : 1000, gid: script === 'as-other.mjs' ? 1001 : 1000, encoding: 'utf8' })
  try { return JSON.parse(r.stdout) } catch { return { error: r.stderr || r.stdout, status: r.status } }
}
out.deploy = run('as-deploy.mjs')
out.other = run('as-other.mjs')
console.log(JSON.stringify(out))
`

// runs as uid 1000: what the host's status, verify and switched do, and what a non-root dump process does
const AS_DEPLOY = `
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { liveDumps, readEvents } from './ledger.js'
import { retireDump } from './retire.js'
import { takeDump } from './take.js'
${COMMON}
const dir = process.argv[2]
const live = liveDumps(readEvents(dir))
const e = live[0]
const sha = createHash('sha256').update(readFileSync(join(dir, e.file))).digest('hex')
const out = { uid: process.getuid(), live: live.length, shaMatches: sha === e.sha256, release: e.release }
// a non-root process with an ownerUid behaves exactly as before: it owns its directory, nothing is chowned
const own = await takeDump({ ...base(dir, 'dist-v2-never'), database: DB.replace('finance', 'calendar'), moduleId: 'calendar', ownerUid: 1000, exporter: { ...exporter, async list() { return ';\\n; Archive created at 2026-11-17 03:00:00 UTC\\n;     dbname: ' + DB.replace('finance', 'calendar') + '\\n' } } })
out.nonRootTake = own.status
const r = await retireDump(dir, e.release, e.database, 'switched', { audit: () => {} })
out.retired = r.retired.length
out.stillLive = liveDumps(readEvents(dir)).map((x) => x.release)
out.files = readdirSync(dir).sort()
out.ledger = { uid: statSync(join(dir, 'ledger.jsonl')).uid }
console.log(JSON.stringify(out))
`

// runs as uid 1001, a non-root uid that does not own the directory
const AS_OTHER = `
import { statSync, writeFileSync } from 'node:fs'
import { takeDump } from './take.js'
${COMMON}
const dir = process.argv[2]
const out = { uid: process.getuid() }
out.noOwnerUid = await code(takeDump(base(dir, 'dist-v3')))
out.withOwnerUid1000 = await code(takeDump({ ...base(dir, 'dist-v3'), ownerUid: 1000 }))
out.withOwnerUid1001 = await code(takeDump({ ...base(dir, 'dist-v3'), ownerUid: 1001 }))
console.log(JSON.stringify(out))
`

describe('the dump with the real uids (a root process, the deploy user, another user)', () => {
  const scratch: string[] = []
  afterAll(() => {
    for (const d of scratch) rmSync(d, { recursive: true, force: true })
  })

  it('root with ownerUid 1000 writes into the 0700 directory of uid 1000 and hands the files over; uid 1000 verifies and retires them; the unowned and foreign cases still fail', () => {
    mkdirSync(EXPORT_ROOT, { recursive: true })
    const work = mkdtempSync(join(EXPORT_ROOT, 'u6g-uid-'))
    scratch.push(work)
    // the dump code, as it is in the checkout: transpiled file by file, same names, so its relative imports resolve
    for (const f of ['ledger', 'take', 'retire']) {
      const js = ts.transpileModule(readFileSync(join(DUMP_SRC, `${f}.ts`), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false } })
      writeFileSync(join(work, `${f}.js`), js.outputText)
    }
    writeFileSync(join(work, 'package.json'), '{"type":"module"}')
    writeFileSync(join(work, 'scenario.mjs'), SCENARIO)
    writeFileSync(join(work, 'as-deploy.mjs'), AS_DEPLOY)
    writeFileSync(join(work, 'as-other.mjs'), AS_OTHER)
    // the scenario imports ./take.js from /work, so it runs from there
    const name = `bd-u6g-uid-${randomBytes(4).toString('hex')}`
    const r = spawnSync('docker', ['run', '--rm', '--name', name, '--mount', `type=bind,source=${work},target=/work,readonly`, '-w', '/work', IMAGE, 'node', '/work/scenario.mjs'], { encoding: 'utf8', timeout: 120_000 })
    spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' }) // by explicit name; a no-op after --rm
    expect(r.status, `${r.stderr}\n${r.stdout}`).toBe(0)
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as {
      uid: number
      rootNoOwnerUid: string
      rootWrongOwnerUid: string
      take: string
      stat: Record<string, { uid: number; mode: string }>
      lockGone: boolean
      deploy: { uid: number; live: number; shaMatches: boolean; release: string; nonRootTake: string; retired: number; stillLive: string[]; files: string[]; ledger: { uid: number } }
      other: { uid: number; noOwnerUid: string; withOwnerUid1000: string; withOwnerUid1001: string }
    }

    // the scenario really ran as root, and the deploy half as uid 1000
    expect(out.uid, JSON.stringify(out)).toBe(0)
    expect(out.deploy.uid, JSON.stringify(out.deploy)).toBe(1000)
    // a root process on a directory owned by uid 1000 and NO ownerUid still fails, and so does a wrong ownerUid
    expect(out.rootNoOwnerUid).toBe('DUMP_DIR_OWNER')
    expect(out.rootWrongOwnerUid).toBe('DUMP_DIR_OWNER')
    // with ownerUid 1000 it writes, and everything it wrote ends owned by 1000 with modes 0600 (files) and 0700 (directories)
    expect(out.take).toBe('created')
    expect(out.stat.dir).toEqual({ uid: 1000, mode: '700' })
    expect(out.stat.release).toEqual({ uid: 1000, mode: '700' })
    expect(out.stat.dump).toEqual({ uid: 1000, mode: '600' })
    expect(out.stat.ledger).toEqual({ uid: 1000, mode: '600' })
    expect(out.lockGone).toBe(true)
    // as uid 1000: the dump is readable and its sha256 is the ledger's, the host-style retire works on the root-written ledger
    expect(out.deploy.live).toBe(1)
    expect(out.deploy.shaMatches).toBe(true)
    expect(out.deploy.release).toBe('dist-v1')
    expect(out.deploy.retired).toBe(1)
    // a non-root process with an ownerUid behaves as before (it owns the directory)
    expect(out.deploy.nonRootTake).toBe('created')
    expect(out.deploy.stillLive).toEqual(['dist-v2-never'])
    expect(out.deploy.files).toEqual(['dist-v2-never', 'ledger.jsonl'])
    expect(out.deploy.ledger.uid).toBe(1000)
    // a non-root process of another uid still fails, with or without an ownerUid (it is not root, so the ownerUid grants nothing)
    expect(out.other).toEqual({ uid: 1001, noOwnerUid: 'DUMP_DIR_OWNER', withOwnerUid1000: 'DUMP_DIR_OWNER', withOwnerUid1001: 'DUMP_DIR_OWNER' })
  }, 150_000)
})
