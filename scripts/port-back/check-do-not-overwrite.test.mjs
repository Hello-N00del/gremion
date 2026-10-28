// Unit B3 (spec B §A.1). The do-not-overwrite set is the frozen list the
// kernel-wins direction rests on: 43 paths the kernel holds and the StuRa tree
// does not, plus 2 kernel-ahead theme files whose StuRa-tree bytes must never
// land here. Measured from `verify-manifest --json` at kernel f7ac8260 and
// StuRaOS f276af59. TASK-022 amended it to 42 + 2: it deletes
// docker/traefik/dynamic/tls.yml (the Cloudflare Origin default-certificate
// store) on purpose, so that row and its assertion left in the same commit.
// TASK-041 amended it to 41 + 2: it deletes gremion-ui/scripts/check-domain-
// regex.mjs with the wildcard edge (the B10 amendment), in the same commit.
//
//   node --test scripts/port-back/check-do-not-overwrite.test.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test, { describe } from 'node:test'

const SET_FILE = path.join(import.meta.dirname, 'do-not-overwrite.json')
const set = JSON.parse(readFileSync(SET_FILE, 'utf8'))

describe('do-not-overwrite.json — shape', () => {
  test('declares its own entry count and carries exactly that many', () => {
    assert.equal(set.expectedEntries, 41)
    assert.equal(set.doNotDelete.length + set.kernelAhead.length, set.expectedEntries)
  })

  test('doNotDelete carries the 39 remaining measured paths, sorted and unique', () => {
    assert.equal(set.doNotDelete.length, 39)
    assert.deepEqual(set.doNotDelete, [...new Set(set.doNotDelete)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
  })

  test('every named kernel-ahead surface of spec B §A.1 is in the set', () => {
    const has = (p) => set.doNotDelete.includes(p)
    assert.equal(
      set.doNotDelete.filter((p) => p.startsWith('gremion-ui/src/lib/components/dashboard/')).length,
      11,
    )
    assert.ok(has('gremion-ui/src/lib/components/committee/CommitteeCard.svelte'))
    assert.ok(has('gremion-ui/src/lib/source-offer.ts'))
    assert.ok(has('gremion-ui/src/lib/source-offer.test.ts'))
    assert.ok(has('gremion-ui/src/lib/source-offer.wiring.test.ts'))
    assert.ok(has('gremion-ui/src/lib/components/layout/ThemeToggle.svelte'))
    // TASK-041 deleted the DOMAIN_REGEX detector with the wildcard edge (the B10
    // amendment): its row left the set in the same commit as the file.
    assert.ok(!has('gremion-ui/scripts/check-domain-regex.mjs'))
    // TASK-022 deleted the Cloudflare Origin certificate store (spec B "Edge"
    // §2, TRD-042). A protected row for a path that must NOT come back would
    // make the guard demand the very file the edge removed.
    assert.ok(!has('docker/traefik/dynamic/tls.yml'))
    // TASK-042 (zero-tenant boot) deleted this path on purpose (the first-run wizard, Q1):
    // its row left the set in the same commit as the file.
    assert.ok(!has('gremion-ui/src/routes/setup/steps/wizard-submit-schema.test.ts'))
    // Concatenated so the TASK-042 deletion assertion does not read it as a carrier.
    assert.ok(!has('gremion-ui/src/lib/server/tenant/' + 'register-default.env.test.ts'))
    // 12, not the 13 the plan's prose says: the measured set at f7ac8260 carries
    // k8s/base/keycloak/pdb.yaml plus 5 dev and 6 production ingressroute patches.
    // The plan's own frozen JSON lists the same 12; only its prose miscounted.
    assert.equal(set.doNotDelete.filter((p) => p.startsWith('k8s/')).length, 12)
    assert.equal(
      set.doNotDelete.filter((p) => /^scripts\/(check-|kernel-hygiene)/.test(p)).length,
      5,
    )
  })

  test('kernelAhead names the theme engine and pins the forbidden StuRa blob', () => {
    assert.deepEqual(set.kernelAhead.map((e) => e.path).sort(), [
      'gremion-ui/src/lib/theme/instance-theme.test.ts',
      'gremion-ui/src/lib/theme/instance-theme.ts',
    ])
    for (const e of set.kernelAhead) assert.match(e.forbiddenProductBlob, /^[0-9a-f]{40}$/)
  })

  test('records the two SHAs it was frozen at', () => {
    assert.equal(set.frozenAt.kernel, 'f7ac82609eb4b6dedd415d2ef6d7f8d1736ae543')
    assert.equal(set.frozenAt.stura, 'f276af5925abacdcfd05f6613fc11afff2d804c5')
  })
})

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { after, before } from 'node:test'

import { check, indexBlobs, parseArgs, protectedPaths, worktreeBlobs } from './check-do-not-overwrite.mjs'

const CLI = fileURLToPath(new URL('./check-do-not-overwrite.mjs', import.meta.url))

// A throwaway kernel-shaped repo, never the real tree. Comparison is by git
// blob SHA, so this has to be a real repo with a real commit — the same code
// path production takes, EOL normalisation included.

function write(root, rel, body) {
  const abs = path.join(root, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, body)
}

const SMALL_TEMPLATE = {
  schemaVersion: 1,
  expectedEntries: 3,
  frozenAt: { kernel: 'f7ac82609eb4b6dedd415d2ef6d7f8d1736ae543', stura: 'f276af5925abacdcfd05f6613fc11afff2d804c5' },
  doNotDelete: ['a/keep-one.ts', 'a/keep-two.ts'],
  kernelAhead: [{ path: 'b/ahead.ts', forbiddenProductBlob: null }],
}

const KERNEL_BYTES = 'export const kernelVersion = true\n'
const STURA_BYTES = 'export const staleProductVersion = true\n'

/** A committed fixture repo plus a set whose forbidden blob is the StuRa bytes. */
function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'b3-dno-'))
  const g = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'b3@fixture.invalid')
  g('config', 'user.name', 'b3 fixture')
  g('config', 'commit.gpgsign', 'false')
  write(root, 'a/keep-one.ts', 'export const one = 1\n')
  write(root, 'a/keep-two.ts', 'export const two = 2\n')
  write(root, 'b/ahead.ts', KERNEL_BYTES)
  execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'pipe' })
  g('commit', '-qm', 'fixture')
  const small = structuredClone(SMALL_TEMPLATE)
  // The blob the StuRa tree would bring for b/ahead.ts.
  small.kernelAhead[0].forbiddenProductBlob = execFileSync(
    'git', ['-C', root, 'hash-object', '--stdin'],
    { input: STURA_BYTES, encoding: 'utf8' },
  ).trim()
  return { root, small }
}

describe('check-do-not-overwrite — behaviour', () => {
  let FIX
  let SMALL
  const stage = () => execFileSync('git', ['-C', FIX, 'add', '-A'], { stdio: 'pipe' })
  const now = () => check(SMALL, indexBlobs(FIX), worktreeBlobs(FIX, protectedPaths(SMALL)))

  before(() => {
    const f = makeFixture()
    FIX = f.root
    SMALL = f.small
  })

  after(() => rmSync(FIX, { recursive: true, force: true }))

  test('a clean tree produces no failures', () => {
    assert.deepEqual(now(), [])
  })

  test('a deleted do-not-delete path is refused by name', () => {
    rmSync(path.join(FIX, 'a/keep-two.ts'))
    stage()
    const out = now()
    assert.equal(out.length, 1)
    assert.equal(
      out[0],
      'PORT-BACK REFUSED: a/keep-two.ts is in the do-not-overwrite set and is no longer tracked in the kernel',
    )
    write(FIX, 'a/keep-two.ts', 'export const two = 2\n')
    stage()
    assert.deepEqual(now(), [])
  })

  test('a kernel-ahead path overwritten with the StuRa-tree bytes is refused', () => {
    write(FIX, 'b/ahead.ts', STURA_BYTES)
    stage()
    const out = now()
    assert.equal(out.length, 1)
    assert.match(out[0], /^PORT-BACK REFUSED: b\/ahead\.ts now carries the StuRa-tree blob [0-9a-f]{40}; kernel wins on this path \(spec B §2\.1\)$/)
    write(FIX, 'b/ahead.ts', KERNEL_BYTES)
    stage()
    assert.deepEqual(now(), [])
  })

  test('an ordinary kernel edit to a protected path is allowed', () => {
    write(FIX, 'a/keep-one.ts', 'export const one = 1\nexport const added = true\n')
    stage()
    assert.deepEqual(now(), [])
  })

  test('a short set is refused rather than passing vacuously', () => {
    const out = check({ ...SMALL, doNotDelete: [], kernelAhead: [] }, indexBlobs(FIX))
    assert.deepEqual(out, [
      'PORT-BACK REFUSED: the do-not-overwrite set declares 3 entries but carries 0',
    ])
  })

  test('the real set loads against the real kernel with no failures', () => {
    const kernel = path.join(import.meta.dirname, '..', '..')
    assert.deepEqual(check(set, indexBlobs(kernel), worktreeBlobs(kernel, protectedPaths(set))), [])
  })
})

// ------------------------------------------------ the working tree, not just
//                                                   the index (round 2)
//
// A port-back is a `cp -r`/`rsync`: the damage is on disk long before anyone
// runs `git add`. Round 1 compared index blobs only, so the guard printed "45
// entries intact" over a tree whose 11 dashboard files had just been deleted.
// Each case below asserts BOTH halves — that the index-only call is blind, and
// that the call the CLI actually makes refuses.
describe('check-do-not-overwrite — the working tree, not just the index', () => {
  let FIX
  let SMALL
  const indexOnly = () => check(SMALL, indexBlobs(FIX))
  const full = () => check(SMALL, indexBlobs(FIX), worktreeBlobs(FIX, protectedPaths(SMALL)))

  before(() => {
    const f = makeFixture()
    FIX = f.root
    SMALL = f.small
  })

  after(() => rmSync(FIX, { recursive: true, force: true }))

  test('for a clean tree the working-tree SHAs ARE the index SHAs', () => {
    const idx = indexBlobs(FIX)
    const wt = worktreeBlobs(FIX, protectedPaths(SMALL))
    for (const p of protectedPaths(SMALL)) {
      assert.equal(wt.get(p), idx.get(p), `${p}: working tree ${wt.get(p)} vs index ${idx.get(p)}`)
    }
  })

  test('an UNSTAGED deletion of a protected path is refused', () => {
    rmSync(path.join(FIX, 'a/keep-two.ts'))
    assert.deepEqual(indexOnly(), [], 'the index arm alone is blind here — that is the defect being guarded')
    assert.deepEqual(full(), [
      'PORT-BACK REFUSED: a/keep-two.ts is in the do-not-overwrite set and is gone from the kernel working tree',
    ])
    write(FIX, 'a/keep-two.ts', 'export const two = 2\n')
    assert.deepEqual(full(), [])
  })

  test('an UNSTAGED overwrite of a kernel-ahead path with the StuRa bytes is refused', () => {
    write(FIX, 'b/ahead.ts', STURA_BYTES)
    assert.deepEqual(indexOnly(), [])
    const out = full()
    assert.equal(out.length, 1)
    assert.match(
      out[0],
      /^PORT-BACK REFUSED: b\/ahead\.ts now carries the StuRa-tree blob [0-9a-f]{40} in the working tree; kernel wins on this path \(spec B §2\.1\)$/,
    )
    write(FIX, 'b/ahead.ts', KERNEL_BYTES)
    assert.deepEqual(full(), [])
  })

  test('an UNSTAGED wipe of a whole protected directory is refused once per file', () => {
    rmSync(path.join(FIX, 'a'), { recursive: true })
    const blind = indexOnly()
    const out = full()
    write(FIX, 'a/keep-one.ts', 'export const one = 1\n')
    write(FIX, 'a/keep-two.ts', 'export const two = 2\n')
    assert.deepEqual(blind, [])
    assert.equal(out.length, 2, out.join('\n'))
    assert.deepEqual(out.map((l) => l.split(' ')[2]).sort(), ['a/keep-one.ts', 'a/keep-two.ts'])
    assert.ok(out.every((l) => l.endsWith('is gone from the kernel working tree')), out.join('\n'))
    assert.deepEqual(full(), [])
  })

  test('an unstaged ordinary edit to a protected path is still allowed', () => {
    write(FIX, 'a/keep-one.ts', 'export const one = 1\nexport const added = true\n')
    assert.deepEqual(full(), [])
    write(FIX, 'a/keep-one.ts', 'export const one = 1\n')
  })
})

// ------------------------------------------------ a malformed set must refuse
//
// `set.doNotDelete ?? []` used to turn a set whose arms were missing or
// mistyped into a weaker guard that still reported clean. A set that cannot be
// enforced is a refusal, not a pass.
describe('check-do-not-overwrite — a set it cannot enforce is refused', () => {
  let FIX
  let SMALL
  before(() => {
    const f = makeFixture()
    FIX = f.root
    SMALL = f.small
  })
  after(() => rmSync(FIX, { recursive: true, force: true }))

  const refusals = (mutate) => {
    const s = structuredClone(SMALL)
    mutate(s)
    return check(s, indexBlobs(FIX), worktreeBlobs(FIX, protectedPaths(s)))
  }

  test('a missing doNotDelete arm is refused, not treated as an empty list', () => {
    const out = refusals((s) => delete s.doNotDelete)
    assert.ok(out.length > 0)
    assert.ok(out.some((l) => l.includes('doNotDelete must be an array of paths')), out.join('\n'))
  })

  test('a kernelAhead row with no forbiddenProductBlob is refused', () => {
    const out = refusals((s) => {
      s.kernelAhead[0].forbiddenProductBlob = undefined
    })
    assert.ok(
      out.some((l) => l.includes('kernelAhead[0] has no 40-hex forbiddenProductBlob')),
      out.join('\n'),
    )
  })

  test('a truncated forbiddenProductBlob is refused rather than never matching', () => {
    const out = refusals((s) => {
      s.kernelAhead[0].forbiddenProductBlob = 'deadbeef'
    })
    assert.ok(out.some((l) => l.includes('kernelAhead[0] has no 40-hex forbiddenProductBlob')))
  })

  test('a non-integer expectedEntries is refused', () => {
    const out = refusals((s) => {
      s.expectedEntries = '3'
    })
    assert.ok(out.some((l) => l.includes('expectedEntries must be an integer')))
  })
})

// ------------------------------------------------ the CLI itself
//
// Every assertion above calls `check()`. These call the script the Makefile
// and CI call, because the exit code and the stream the refusals land on are
// what `make lint-port-back` actually consumes — and because round 1's
// `--kernal`/`--kernel ""` fallback was invisible to any in-process test.
describe('check-do-not-overwrite — CLI', () => {
  let FIX
  let SETS
  let SET_PATH

  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })

  before(() => {
    const f = makeFixture()
    FIX = f.root
    SETS = mkdtempSync(path.join(tmpdir(), 'b3-set-'))
    SET_PATH = path.join(SETS, 'small.json')
    writeFileSync(SET_PATH, JSON.stringify(f.small, null, 2))
  })

  after(() => {
    rmSync(FIX, { recursive: true, force: true })
    rmSync(SETS, { recursive: true, force: true })
  })

  test('a clean tree exits 0 and NAMES the tree it checked', () => {
    const r = run('--kernel', FIX, '--set', SET_PATH)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /do-not-overwrite: 3 entries intact \(2 must-exist, 1 kernel-ahead\), index and working tree, in /)
    // The resolved work tree, not the caller's spelling: that is what makes a
    // silent substitution visible in the output.
    const top = execFileSync('git', ['-C', FIX, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    assert.ok(r.stdout.includes(top), `${r.stdout} does not name ${top}`)
  })

  test('an UNSTAGED deletion exits 1 through the real CLI', () => {
    rmSync(path.join(FIX, 'a/keep-two.ts'))
    const r = run('--kernel', FIX, '--set', SET_PATH)
    assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`)
    assert.match(r.stderr, /PORT-BACK REFUSED: a\/keep-two\.ts .* is gone from the kernel working tree/)
    assert.equal(r.stdout, '', 'a refusing run must not also print the clean line')
    write(FIX, 'a/keep-two.ts', 'export const two = 2\n')
    assert.equal(run('--kernel', FIX, '--set', SET_PATH).status, 0)
  })

  test('a mistyped option is a hard error, never a silent fallback to this repo', () => {
    const r = run('--kernal', FIX, '--set', SET_PATH)
    assert.equal(r.status, 2, `stdout=${r.stdout}`)
    assert.match(r.stderr, /unknown option "--kernal"/)
    assert.equal(r.stdout, '', 'it must not report GREEN about a tree nobody asked about')
  })

  test('an empty --kernel is a hard error', () => {
    const r = run('--kernel', '', '--set', SET_PATH)
    assert.equal(r.status, 2, `stdout=${r.stdout}`)
    assert.match(r.stderr, /--kernel requires a non-empty value/)
    assert.equal(r.stdout, '')
  })

  test('a --kernel that is not a git work tree is a hard error', () => {
    const r = run('--kernel', path.join(SETS, 'no-such-tree'), '--set', SET_PATH)
    assert.equal(r.status, 2, `stdout=${r.stdout}`)
    assert.match(r.stderr, /does not exist/)
    assert.equal(r.stdout, '')
  })

  test('a --set that is not a file is a hard error, not an empty set', () => {
    const r = run('--kernel', FIX, '--set', path.join(SETS, 'no-such-set.json'))
    assert.equal(r.status, 2, `stdout=${r.stdout}`)
    assert.equal(r.stdout, '')
  })

  test('--kernel with no value does not swallow the next option', () => {
    const r = run('--kernel', '--set', SET_PATH)
    assert.equal(r.status, 2, `stdout=${r.stdout}`)
    assert.match(r.stderr, /--kernel requires a value, got the option "--set"/)
  })

  test('parseArgs accepts --name=value and rejects bare arguments', () => {
    assert.equal(parseArgs(['--kernel=/x'], { kernel: 'd', set: 's' }).kernel, '/x')
    assert.throws(() => parseArgs(['oops'], { kernel: 'd', set: 's' }), /unexpected argument "oops"/)
    assert.throws(() => parseArgs(['--kernel='], { kernel: 'd', set: 's' }), /requires a non-empty value/)
  })
})

// ------------------------------------------------ the guard must actually run
//
// `lint: ... lint-packages lint-port-back` is a SINGLE line, and B00 appends to
// the same line from the same base. A three-way merge conflicts there, and a
// careless "take theirs" drops lint-port-back from the aggregate - a guard that
// stops running with nothing failing, which is the dominant failure class this
// whole unit exists to prevent. These assertions turn that silent drop into a
// red test, and they cover the CI step for the same reason.
describe('check-do-not-overwrite - the guard is wired to something that runs it', () => {
  const KERNEL = path.join(import.meta.dirname, '..', '..')
  const makefile = readFileSync(path.join(KERNEL, 'Makefile'), 'utf8')
  const ci = readFileSync(path.join(KERNEL, '.github', 'workflows', 'ci.yml'), 'utf8')
  const lines = makefile.split(/\r?\n/)

  test('the lint-port-back target runs the suite AND the guard', () => {
    const start = lines.findIndex((l) => l.startsWith('lint-port-back:'))
    assert.notEqual(start, -1, 'the Makefile has no lint-port-back target')
    const recipe = []
    for (let i = start + 1; i < lines.length && (lines[i].startsWith(String.fromCharCode(9)) || lines[i] === ''); i++) {
      if (lines[i] === '') break
      recipe.push(lines[i])
    }
    const body = recipe.join(String.fromCharCode(10))
    assert.match(body, /node --test scripts[/]port-back[/]check-do-not-overwrite[.]test[.]mjs/)
    assert.match(body, /node scripts[/]port-back[/]check-do-not-overwrite[.]mjs/)
  })

  test('the lint aggregate still names lint-port-back', () => {
    const i = lines.findIndex((l) => /^lint:[ 	]/.test(l))
    assert.notEqual(i, -1, 'the Makefile has no lint aggregate')
    let agg = lines[i]
    for (let j = i; agg.trimEnd().endsWith(String.fromCharCode(92)); ) {
      agg = agg.trimEnd().slice(0, -1) + ' ' + lines[++j]
    }
    assert.match(agg, /(^|[ ])lint-port-back([ ]|$)/, `the lint aggregate dropped lint-port-back: ${agg}`)
  })

  test('CI runs the guard as its own step', () => {
    assert.match(ci, /make lint-port-back/, 'ci.yml no longer runs make lint-port-back')
  })
})
