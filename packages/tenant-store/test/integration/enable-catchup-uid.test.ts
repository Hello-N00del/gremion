// CD stage 1, unit U6g: the uid model with the REAL uids, not a stub. The tenant-create one-shot runs as root, the dump
// directory is 0700 and owned by the deploy user (uid 1000), and the host program that reads, verifies and retires the
// dumps runs as that user. A real root process (a container) takes a dump with `ownerUid` 1000; then, as a real uid 1000,
// the file is read, its sha256 is checked against the ledger and the host-style retire runs. The file, the release
// directory and the ledger end owned by 1000 with modes 0600 and 0700. A root process on that directory with NO
// `ownerUid` still fails DUMP_DIR_OWNER, and a non-root process of another uid still fails.
//
// The same container proves the root process never follows a link that the deploy user plants in its directory (it
// can create, rename and replace every entry there): a link in the place of the ledger, of the release directory, of
// the dump file the exporter just wrote, of the lock, and a forged ledger line pointing a retire into a linked
// directory. It also proves root never hands over a node it did not make: a root-owned directory and a root-owned file
// that the directory owner moves into the places root is about to use. Each is refused (DUMP_PATH_UNSAFE, or
// LEDGER_LOCKED for the lock) and a root-owned victim keeps its owner, its mode and its content.
//
// This needs a root process and two other uids, which a CI runner is not, so it runs in a throwaway container of the
// node image (one root process; the deploy-user halves are child processes of it with uid/gid set). The dump code
// that runs there is the real errors.ts, safefs.ts, ledger.ts, take.ts and retire.ts, transpiled file by file (no
// bundle, no dependency). GREMION_TEST_NODE_IMAGE names another node image (a box that has no node:26-alpine),
// GREMION_TEST_DUMP_SRC another copy of the dump sources (the guard-efficacy runs against the code before the fix).
// It never skips: a runner without docker fails here, as the rest of this suite would.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import { EXPORT_ROOT } from '../harness/lifecycle.js'

const DUMP_SRC = process.env.GREMION_TEST_DUMP_SRC ?? fileURLToPath(new URL('../../src/dump/', import.meta.url))
const IMAGE = process.env.GREMION_TEST_NODE_IMAGE ?? 'node:26-alpine'
const DB = 't_0192f0c12b3c7d4e8f00112233445566__finance'

const COMMON = `
const DB = '${DB}'
const exporter = {
  async dump(t, f, sink) { if (sink && sink.fd !== undefined) writeFileSync(sink.fd, 'PGDMP fake dump of ' + t.database); else writeFileSync(f, 'PGDMP fake dump of ' + t.database, { flag: 'wx', mode: 0o600 }) },
  async list() { return ';\\n; Archive created at 2026-11-17 03:00:00 UTC\\n;     dbname: ' + DB + '\\n' },
}
const probe = { serverMajor: async () => 18, pgDumpMajor: async () => 18, databaseBytes: async () => 1000 }
const base = (dir, release) => ({ dir, release, database: DB, scope: 'customer', customerId: '0192f0c1-2b3c-7d4e-8f00-112233445566', moduleId: 'finance', exporter, probe, audit: () => {} })
const stat = (p) => { const s = statSync(p); return { uid: s.uid, mode: (s.mode & 0o777).toString(8) } }
const code = async (p) => p.then(() => 'no error', (e) => e.code ?? String(e.message))
`

// runs as root
const SCENARIO = `
import { chmodSync, chownSync, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { takeDump } from './take.js'
import { retireDump } from './retire.js'
${COMMON}
// the bind mount is owned by whoever ran the test (0700 from mkdtemp), so the uid 1000 and 1001 children cannot read it:
// they run from a world-readable copy inside the container
cpSync('/work', '/tmp/app', { recursive: true })
spawnSync('chmod', ['-R', 'a+rX', '/tmp/app'])
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
  const r = spawnSync(process.execPath, ['/tmp/app/dump/' + script, dir], { uid: script === 'as-other.mjs' ? 1001 : 1000, gid: script === 'as-other.mjs' ? 1001 : 1000, encoding: 'utf8' })
  try { return JSON.parse(r.stdout) } catch { return { error: r.stderr || r.stdout, status: r.status } }
}
out.deploy = run('as-deploy.mjs')
out.other = run('as-other.mjs')

// ---- the deploy user plants links in its own directory; the root process must never follow one ----
mkdirSync('/victim', { mode: 0o755 })
// worst case for the rename attacks below: the deploy user may move things out of this directory
chmodSync('/victim', 0o777)
const ROOTDIR = '/victim/rootdir'
const ROOTFILE = '/victim/rootfile'
const ROOTLEDGER = '/victim/rootledger'
const VICTIM = '/victim/target.txt'
const RELROOT = '/victim/relroot'
const ID = '0192f0c1-2b3c-7d4e-8f00-aaaaaaaaaaaa'
const VICTIM_DUMP = RELROOT + '/' + DB + '.' + ID + '.dump'
const snap = (p) => {
  const st = lstatSync(p)
  return JSON.stringify({ uid: st.uid, mode: (st.mode & 0o777).toString(8), content: st.isDirectory() ? readdirSync(p).sort() : readFileSync(p, 'utf8') })
}
const reset = () => {
  rmSync(VICTIM, { force: true })
  writeFileSync(VICTIM, '', { mode: 0o644 })
  chmodSync(VICTIM, 0o644)
  rmSync(RELROOT, { recursive: true, force: true })
  mkdirSync(RELROOT, { mode: 0o755 })
  chmodSync(RELROOT, 0o755)
  rmSync(ROOTDIR, { recursive: true, force: true })
  mkdirSync(ROOTDIR, { mode: 0o777 })
  chmodSync(ROOTDIR, 0o777) // a root-owned directory the deploy user may write to, so it can move it (a directory move needs write access to the directory itself)
  rmSync(ROOTFILE, { force: true })
  writeFileSync(ROOTFILE, 'ROOT OWNED', { mode: 0o644 })
  chmodSync(ROOTFILE, 0o644)
  rmSync(ROOTLEDGER, { force: true })
  writeFileSync(ROOTLEDGER, forged('dist-v9', 'dist-v9/' + DB + '.' + ID + '.dump'), { mode: 0o644 }) // a ledger of root, with a live dump of another release in it
  chmodSync(ROOTLEDGER, 0o644)
}
let atk = 0
const fresh = () => {
  const d = '/tmp/atk' + ++atk
  mkdirSync(d, { mode: 0o700 })
  chownSync(d, 1000, 1000)
  chmodSync(d, 0o700)
  return d
}
const plant = (ops) => spawnSync(process.execPath, ['/tmp/app/dump/plant.mjs', JSON.stringify(ops)], { uid: 1000, gid: 1000, encoding: 'utf8' })
const forged = (rel, file) => JSON.stringify({ v: 1, event: 'created', at: '2026-11-17T03:00:00.000Z', migration_dump_id: ID, release: rel, scope: 'customer', customer_id: '0192f0c1-2b3c-7d4e-8f00-112233445566', module_id: 'finance', database: DB, by_kind: 'system', file, sha256: 'a'.repeat(64), bytes: 9, dump_taken_at: '2026-11-17T03:00:00.000Z' }) + '\\n'
const swapped = { ...exporter, async dump(t, f, sink) { if (sink && sink.fd !== undefined) writeFileSync(sink.fd, 'PGDMP'); else writeFileSync(f, 'PGDMP', { flag: 'wx', mode: 0o600 }); unlinkSync(f); symlinkSync(VICTIM, f) } }
// the exporter writes through the descriptor, then renames the name aside (the node keeps its one link) and plants a link to a root-only file in its place
const renamedAside = { ...exporter, async dump(t, f, sink) { writeFileSync(sink.fd, 'PGDMP'); renameSync(f, f + '.aside'); symlinkSync(VICTIM, f) } }
const attack = async (victim, setup, run) => {
  reset()
  writeFileSync(VICTIM_DUMP, 'VICTIM DUMP', { mode: 0o600 })
  const d = fresh()
  const planted = plant(setup(d))
  if (planted.status !== 0) return { error: 'plant failed: ' + (planted.stderr || planted.stdout) }
  const where = typeof victim === 'function' ? victim(d) : victim
  const before = snap(where)
  const c = await code(run(d))
  return { code: c, unchanged: snap(where) === before, stillThere: existsSync(VICTIM_DUMP) }
}
// a root-owned file the exporter's output is replaced with (moved in by the directory's owner): watched on an open descriptor, because the failed take removes the name
const movedFile = async () => {
  reset()
  const d = fresh()
  const vfd = openSync(ROOTFILE, 'r')
  const facts = () => JSON.stringify({ uid: fstatSync(vfd).uid, mode: (fstatSync(vfd).mode & 0o777).toString(8) })
  const before = facts()
  const moved = { ...exporter, async dump(t, f) { renameSync(ROOTFILE, f) } }
  const c = await code(take1(d, { exporter: moved }))
  return { code: c, unchanged: facts() === before, stillThere: true }
}
// a root-owned file moved into the place of the ledger while the take runs (watched on an open descriptor: uid, mode AND size, so an appended line shows)
const movedLedger = async () => {
  reset()
  const d = fresh()
  const vfd = openSync(ROOTFILE, 'r')
  const facts = () => {
    const st = fstatSync(vfd)
    return JSON.stringify({ uid: st.uid, mode: (st.mode & 0o777).toString(8), size: st.size })
  }
  const before = facts()
  const moved = { ...exporter, async dump(t, f, sink) { if (sink && sink.fd !== undefined) writeFileSync(sink.fd, 'PGDMP fake dump of ' + t.database); else writeFileSync(f, 'PGDMP fake dump of ' + t.database, { flag: 'wx', mode: 0o600 }); renameSync(ROOTFILE, d + '/ledger.jsonl') } }
  const c = await code(take1(d, { exporter: moved }))
  return { code: c, unchanged: facts() === before, stillThere: true }
}
// what could block the process (a FIFO where a file is read) runs in a root child with a clock on it, so a hang is a result and not the end of the run
const rootChild = (spec) => {
  const r = spawnSync(process.execPath, ['/tmp/app/dump/attack-child.mjs', JSON.stringify(spec)], { encoding: 'utf8', timeout: 15000 })
  if (r.error || r.signal) return { hung: true }
  try { return { hung: false, ...JSON.parse(r.stdout.trim().split(String.fromCharCode(10)).at(-1)) } } catch { return { hung: false, error: r.stderr || r.stdout } }
}
const childAttack = (kind, setup) => {
  reset()
  const d = fresh()
  if (setup) {
    const planted = plant(setup(d))
    if (planted.status !== 0) return { error: 'plant failed: ' + (planted.stderr || planted.stdout) }
  }
  return rootChild({ kind, dir: d, victim: VICTIM })
}
const take1 = (d, over) => takeDump({ ...base(d, 'dist-v1'), ownerUid: 1000, ...(over || {}) })
const retire9 = (d) => retireDump(d, 'dist-v9', DB, 'attack', { ownerUid: 1000, audit: () => {} })
out.attacks = {
  ledgerLink: await attack(VICTIM, (d) => [{ op: 'symlink', target: VICTIM, path: d + '/ledger.jsonl' }], (d) => take1(d)),
  releaseLink: await attack(RELROOT, (d) => [{ op: 'symlink', target: RELROOT, path: d + '/dist-v1' }], (d) => take1(d)),
  swappedDump: await attack(VICTIM, () => [], (d) => take1(d, { exporter: swapped })),
  renamedAside: await attack(VICTIM, () => [], (d) => take1(d, { exporter: renamedAside })),
  lockLink: await attack(VICTIM, (d) => [{ op: 'symlink', target: VICTIM, path: d + '/ledger.lock' }], (d) => take1(d)),
  retireLinkedRelease: await attack(
    RELROOT,
    (d) => [
      { op: 'write', path: d + '/ledger.jsonl', text: forged('dist-v9', 'dist-v9/' + DB + '.' + ID + '.dump') },
      { op: 'symlink', target: RELROOT, path: d + '/dist-v9' },
    ],
    (d) => retire9(d),
  ),
  retireForgedPath: await attack(
    VICTIM,
    (d) => [{ op: 'write', path: d + '/ledger.jsonl', text: forged('dist-v9', '../../victim/target.txt') }],
    (d) => retire9(d),
  ),
  retireLedgerLink: await attack(VICTIM, (d) => [{ op: 'symlink', target: VICTIM, path: d + '/ledger.jsonl' }], (d) => retire9(d)),
  // a root-owned directory moved to the place of the release directory: it exists, so it is never handed over
  movedDir: await attack((d) => d + '/dist-v1', (d) => [{ op: 'rename', from: ROOTDIR, to: d + '/dist-v1' }], (d) => take1(d)),
  movedFile: await movedFile(),
  // a root-owned file in the place of the ledger: refused by owner, before it is read and before it is appended to
  movedLedgerBefore: await attack((d) => d + '/ledger.jsonl', (d) => [{ op: 'rename', from: ROOTLEDGER, to: d + '/ledger.jsonl' }], (d) => take1(d)),
  movedLedgerDuring: await movedLedger(),
  retireMovedLedger: await attack((d) => d + '/ledger.jsonl', (d) => [{ op: 'rename', from: ROOTLEDGER, to: d + '/ledger.jsonl' }], (d) => retire9(d)),
  // a FIFO where the ledger is read must not hold the process in open(2)
  ledgerFifo: childAttack('take', (d) => [{ op: 'mkfifo', path: d + '/ledger.jsonl' }]),
  // the name of the dump is replaced (by a link to a root-only file, by a FIFO) before the table of contents is read: the exporter is handed the descriptor
  listLink: childAttack('listLink'),
  listFifo: childAttack('listFifo'),
}
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

// runs as uid 1000: the deploy user plants what it can plant in its own directory
const AS_PLANT = `
import { spawnSync } from 'node:child_process'
import { renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
for (const o of JSON.parse(process.argv[2])) {
  if (o.op === 'mkfifo') spawnSync('mkfifo', [o.path])
  if (o.op === 'symlink') symlinkSync(o.target, o.path)
  else if (o.op === 'write') writeFileSync(o.path, o.text, { mode: 0o600 })
  else if (o.op === 'rm') rmSync(o.path, { force: true })
  else if (o.op === 'rename') renameSync(o.from, o.to)
}
console.log('{}')
`

// runs as root, one take per process (the scenario gives it a clock): what could block on a FIFO, and the race between the seal of the dump and the read of its table of contents
const ROOT_CHILD = `
import { readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { takeDump } from './take.js'
${COMMON}
const spec = JSON.parse(process.argv[2])
const state = { readByName: false }
// an exporter whose reader finds the name of the dump already replaced (the deploy user won the race). A reader handed
// the descriptor reads the dump; one that has only the name reads, or waits on, whatever now stands there.
const swapping = (kind) => ({
  ...exporter,
  async list(f, source) {
    unlinkSync(f)
    if (kind === 'link') symlinkSync(spec.victim, f)
    else spawnSync('mkfifo', [f])
    if (source && source.fd !== undefined) {
      readFileSync(source.fd)
      return exporter.list()
    }
    state.readByName = true
    readFileSync(f)
    return exporter.list()
  },
})
const over = spec.kind === 'listLink' ? { exporter: swapping('link') } : spec.kind === 'listFifo' ? { exporter: swapping('fifo') } : {}
const c = await code(takeDump({ ...base(spec.dir, 'dist-v1'), ownerUid: 1000, ...over }))
console.log(JSON.stringify({ code: c, readByName: state.readByName }))
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
    // (the same layout as src/: dump/ beside fd-stream.js, so take's import of ../fd-stream.js resolves)
    const transpile = (from: string, to: string): void => {
      const js = ts.transpileModule(readFileSync(from, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false } })
      writeFileSync(to, js.outputText)
    }
    mkdirSync(join(work, 'dump'))
    for (const f of ['errors', 'safefs', 'ledger', 'take', 'retire'].filter((n) => existsSync(join(DUMP_SRC, `${n}.ts`)))) transpile(join(DUMP_SRC, `${f}.ts`), join(work, 'dump', `${f}.js`))
    transpile(fileURLToPath(new URL('../../src/fd-stream.ts', import.meta.url)), join(work, 'fd-stream.js'))
    writeFileSync(join(work, 'package.json'), '{"type":"module"}')
    writeFileSync(join(work, 'dump', 'scenario.mjs'), SCENARIO)
    writeFileSync(join(work, 'dump', 'as-deploy.mjs'), AS_DEPLOY)
    writeFileSync(join(work, 'dump', 'as-other.mjs'), AS_OTHER)
    writeFileSync(join(work, 'dump', 'plant.mjs'), AS_PLANT)
    writeFileSync(join(work, 'dump', 'attack-child.mjs'), ROOT_CHILD)
    // the scenario imports ./take.js from /work, so it runs from there
    const name = `bd-u6g-uid-${randomBytes(4).toString('hex')}`
    const r = spawnSync('docker', ['run', '--rm', '--name', name, '--mount', `type=bind,source=${work},target=/work,readonly`, '-w', '/work', IMAGE, 'node', '/work/dump/scenario.mjs'], { encoding: 'utf8', timeout: 120_000 })
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
      attacks: Record<string, { code?: string; unchanged?: boolean; stillThere?: boolean; error?: string; hung?: boolean; readByName?: boolean }>
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

    // The deploy user plants a link where the root process is about to open, chmod, chown, write or unlink: every one
    // is refused, and the root-owned victim outside the directory keeps its owner, mode and content (and its files).
    const unsafe = { code: 'DUMP_PATH_UNSAFE', unchanged: true, stillThere: true }
    const a = out.attacks
    expect(a.ledgerLink, JSON.stringify(a)).toEqual(unsafe)
    expect(a.releaseLink, JSON.stringify(a)).toEqual(unsafe)
    expect(a.swappedDump, JSON.stringify(a)).toEqual(unsafe)
    expect(a.renamedAside, JSON.stringify(a)).toEqual(unsafe)
    expect(a.retireLinkedRelease, JSON.stringify(a)).toEqual(unsafe)
    expect(a.retireLedgerLink, JSON.stringify(a)).toEqual(unsafe)
    // nodes of root that the owner moved into place are never handed over: the existing directory is refused, and a
    // file that is not the one the exporter just wrote is refused before its owner or mode changes
    expect(a.movedDir, JSON.stringify(a)).toEqual(unsafe)
    expect(a.movedFile, JSON.stringify(a)).toEqual(unsafe)
    // a root-owned file in the place of the ledger (before the take, while it runs, and for a retire) is refused by owner:
    // it is not read as the ledger and gets no line (uid, mode and size of the victim are as they were)
    expect(a.movedLedgerBefore, JSON.stringify(a)).toEqual(unsafe)
    expect(a.movedLedgerDuring, JSON.stringify(a)).toEqual(unsafe)
    expect(a.retireMovedLedger, JSON.stringify(a)).toEqual(unsafe)
    // a FIFO in the place of the ledger is refused at once, the process is not held in open(2)
    expect(a.ledgerFifo, JSON.stringify(a)).toEqual({ hung: false, code: 'DUMP_PATH_UNSAFE', readByName: false })
    // the table of contents is read from the descriptor that was checked: a name replaced by a link to a root-only file, or by
    // a FIFO, while it is read is never opened, the take is not held up, and the replaced name is refused before the ledger line
    expect(a.listLink, JSON.stringify(a)).toEqual({ hung: false, code: 'DUMP_PATH_UNSAFE', readByName: false })
    expect(a.listFifo, JSON.stringify(a)).toEqual({ hung: false, code: 'DUMP_PATH_UNSAFE', readByName: false })
    // a ledger line that names a path outside <release>/<name>.<id>.dump is refused as a corrupt ledger, and nothing is removed
    expect(a.retireForgedPath, JSON.stringify(a)).toEqual({ code: 'LEDGER_CORRUPT', unchanged: true, stillThere: true })
    // a lock that a link stands in for was never replaced: the lock refuses, as it always did
    expect(a.lockLink, JSON.stringify(a)).toEqual({ code: 'LEDGER_LOCKED', unchanged: true, stillThere: true })
  }, 150_000)
})
