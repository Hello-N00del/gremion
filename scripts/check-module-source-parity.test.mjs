#!/usr/bin/env node
// node --test suite for the in-tree module source parity guard (TASK-200, TDD 1).
//
// Every case builds a throwaway StuRa-shaped git repository with an annotated
// tag and a throwaway kernel tree, then asserts on the guard's REPORT — never on
// "the command ran". The RED cases are the point: a one-byte edit in a set-A
// file and in a set-B file, an unlisted extra file, a stale delta entry, a
// missing tag, a tag that moved, a missing source path.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PATH_EXEMPTIONS, checkFiles, staleExemptions } from './check-postgres-major.mjs'
import {
  MODULE_ID_MAP,
  CONTENT_UI_PREFIXES,
  mapSourcePath,
  validateDelta,
  runParity,
  formatReport,
} from './check-module-source-parity.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-module-source-parity.mjs')

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.org',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.org',
    },
  }).trim()
}

function blobOf(root, rel) {
  return execFileSync('git', ['hash-object', rel], { cwd: root, encoding: 'utf8' }).trim()
}

function put(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

/**
 * A StuRa-shaped repo: base commit, then a finance change (set A), tagged.
 * Returns { stura, kernel, base, tagCommit, cleanup }. The kernel is a git repo
 * too, because the guard hashes kernel files with `git hash-object`.
 */
function fixture() {
  const top = mkdtempSync(join(tmpdir(), 't200-parity-'))
  const stura = join(top, 'stura')
  const kernel = join(top, 'kernel')
  mkdirSync(stura)
  mkdirSync(kernel)
  git(stura, 'init', '-q', '-b', 'master')
  put(stura, 'services/finance/src/a.ts', 'export const a = 1\n')
  put(stura, 'services/messages/src/m.ts', 'export const m = 1\n')
  put(stura, 'services/newsletter/src/n.ts', 'export const n = 1\n')
  put(stura, 'services/votes/src/v.ts', 'export const v = 1\n')
  put(stura, 'gremion-ui/src/lib/server/content/c.ts', 'export const c = 1\n')
  put(stura, 'gremion-ui/src/lib/server/governance/g.ts', 'not content\n')
  git(stura, 'add', '-A')
  git(stura, 'commit', '-q', '-m', 'base')
  const base = git(stura, 'rev-parse', 'HEAD')
  put(stura, 'services/finance/src/a.ts', 'export const a = 2\n')
  git(stura, 'add', '-A')
  git(stura, 'commit', '-q', '-m', 'finance change')
  git(stura, 'tag', '-a', 'extraction-source-f1', '-m', 'freeze')
  const tagCommit = git(stura, 'rev-parse', 'extraction-source-f1^{commit}')

  git(kernel, 'init', '-q', '-b', 'main')
  put(kernel, 'modules/finance/src/a.ts', 'export const a = 2\n')
  put(kernel, 'modules/messaging/src/m.ts', 'export const m = 1\n')
  put(kernel, 'modules/publishing/src/n.ts', 'export const n = 1\n')
  put(kernel, 'modules/votes/src/v.ts', 'export const v = 1\n')
  put(kernel, 'modules/content/app/lib/server/content/c.ts', 'export const c = 1\n')
  put(kernel, 'modules/EXTRACTION-DELTA.json', JSON.stringify({ entries: [] }))
  return {
    stura,
    kernel,
    base,
    tagCommit,
    opts: { sturaPath: stura, tag: 'extraction-source-f1', kernelRoot: kernel, base, expectedTagCommit: tagCommit },
    cleanup: () => rmSync(top, { recursive: true, force: true }),
  }
}

test('the id map renames exactly messages and newsletter', () => {
  assert.equal(MODULE_ID_MAP.messages, 'messaging')
  assert.equal(MODULE_ID_MAP.newsletter, 'publishing')
  assert.equal(mapSourcePath('services/finance/src/a.ts'), 'modules/finance/src/a.ts')
  assert.equal(mapSourcePath('services/messages/Dockerfile'), 'modules/messaging/Dockerfile')
  assert.equal(mapSourcePath('services/newsletter/package.json'), 'modules/publishing/package.json')
  // Never modules/*/*: one level, the module id, then the service's own tree.
  assert.equal(mapSourcePath('services/votes/test/x.test.ts'), 'modules/votes/test/x.test.ts')
  assert.equal(
    mapSourcePath('gremion-ui/src/lib/server/content/c.ts'),
    'modules/content/app/lib/server/content/c.ts',
  )
  assert.equal(mapSourcePath('gremion-ui/src/lib/server/governance/g.ts'), null)
  assert.ok(CONTENT_UI_PREFIXES.length > 0)
})

test('GREEN: a byte-equal copy reports zero mismatches in every set', () => {
  const f = fixture()
  try {
    const r = runParity(f.opts)
    assert.deepEqual(r.problems, [])
    assert.equal(r.sets.A.total, 1)
    assert.equal(r.sets.B.total, 4)
    assert.equal(r.sets.C.total, 1)
    for (const s of ['A', 'B', 'C']) assert.deepEqual(r.sets[s].mismatches, [])
    assert.match(formatReport(r), /RESULT: OK/)
  } finally {
    f.cleanup()
  }
})

test('RED: a one-byte edit in a set-A file fails, even when the delta lists it', () => {
  const f = fixture()
  try {
    put(f.kernel, 'modules/finance/src/a.ts', 'export const a = 3\n')
    let r = runParity(f.opts)
    assert.ok(r.sets.A.mismatches.some((m) => m.kernelPath === 'modules/finance/src/a.ts'))
    assert.ok(r.problems.some((p) => /set A/.test(p) && /modules\/finance\/src\/a\.ts/.test(p)))
    // Set A never differs at the tip: listing it does not excuse it.
    put(
      f.kernel,
      'modules/EXTRACTION-DELTA.json',
      JSON.stringify({ entries: [{ path: 'modules/finance/src/a.ts', reason: 'x', owner: 'TASK-200' }] }),
    )
    r = runParity(f.opts)
    assert.ok(r.problems.some((p) => /set A/.test(p)))
  } finally {
    f.cleanup()
  }
})

test('RED: a one-byte edit in a set-B file fails unless EXTRACTION-DELTA.json lists it', () => {
  const f = fixture()
  try {
    put(f.kernel, 'modules/messaging/src/m.ts', 'export const m = 2\n')
    let r = runParity(f.opts)
    assert.ok(r.problems.some((p) => /set B/.test(p) && /modules\/messaging\/src\/m\.ts/.test(p)))
    put(
      f.kernel,
      'modules/EXTRACTION-DELTA.json',
      JSON.stringify({
        entries: [
          { path: 'modules/messaging/src/m.ts', reason: 'kernel hygiene h2/(i)', owner: 'TASK-200', blob: blobOf(f.kernel, 'modules/messaging/src/m.ts') },
        ],
      }),
    )
    r = runParity(f.opts)
    assert.deepEqual(r.problems, [])
    assert.equal(r.sets.B.mismatches.length, 1)
    assert.equal(r.sets.B.mismatches[0].listed, true)
  } finally {
    f.cleanup()
  }
})

test('RED: a --copy run refuses every difference, listed or not', () => {
  const f = fixture()
  try {
    put(f.kernel, 'modules/messaging/src/m.ts', 'export const m = 2\n')
    put(
      f.kernel,
      'modules/EXTRACTION-DELTA.json',
      JSON.stringify({
        entries: [{ path: 'modules/messaging/src/m.ts', reason: 'kernel hygiene h2/(i)', owner: 'TASK-200' }],
      }),
    )
    const r = runParity({ ...f.opts, copy: true })
    assert.ok(r.problems.some((p) => /--copy/.test(p)))
  } finally {
    f.cleanup()
  }
})

test('RED: a missing kernel file is a mismatch, never a skip', () => {
  const f = fixture()
  try {
    rmSync(join(f.kernel, 'modules/publishing/src/n.ts'))
    const r = runParity(f.opts)
    assert.ok(r.sets.B.mismatches.some((m) => m.kernelPath === 'modules/publishing/src/n.ts' && m.kernelBlob === null))
    assert.ok(r.problems.length > 0)
  } finally {
    f.cleanup()
  }
})

test('RED: an unlisted extra file inside a module directory fails', () => {
  const f = fixture()
  try {
    put(f.kernel, 'modules/finance/src/extra.ts', 'export {}\n')
    let r = runParity(f.opts)
    assert.ok(r.problems.some((p) => /extra/.test(p) && /modules\/finance\/src\/extra\.ts/.test(p)))
    put(
      f.kernel,
      'modules/EXTRACTION-DELTA.json',
      JSON.stringify({
        entries: [{ path: 'modules/finance/src/extra.ts', reason: 'added', owner: 'TASK-200', blob: blobOf(f.kernel, 'modules/finance/src/extra.ts') }],
      }),
    )
    r = runParity(f.opts)
    assert.deepEqual(r.problems, [])
    assert.equal(r.extras.length, 1)
  } finally {
    f.cleanup()
  }
})

test('RED: a stale delta entry (listed but byte-equal, or pointing nowhere) fails', () => {
  const f = fixture()
  try {
    put(
      f.kernel,
      'modules/EXTRACTION-DELTA.json',
      JSON.stringify({
        entries: [
          { path: 'modules/messaging/src/m.ts', reason: 'r', owner: 'TASK-200' },
          { path: 'modules/nowhere.ts', reason: 'r', owner: 'TASK-200' },
        ],
      }),
    )
    const r = runParity(f.opts)
    assert.ok(r.problems.some((p) => /stale/.test(p) && /modules\/messaging\/src\/m\.ts/.test(p)))
    assert.ok(r.problems.some((p) => /modules\/nowhere\.ts/.test(p)))
  } finally {
    f.cleanup()
  }
})

test('RED: a copied file that .gitignore hides would never be committed — refused, not hashed from disk', () => {
  const f = fixture()
  try {
    put(f.kernel, '.gitignore', 'm.ts\n')
    const r = runParity(f.opts)
    assert.ok(r.problems.some((p) => /ignored/.test(p) && /modules\/messaging\/src\/m\.ts/.test(p)), r.problems.join('\n'))
  } finally {
    f.cleanup()
  }
})

test('RED: a set-A path listed in the delta fails even when it is byte-equal', () => {
  const f = fixture()
  try {
    put(
      f.kernel,
      'modules/EXTRACTION-DELTA.json',
      JSON.stringify({ entries: [{ path: 'modules/finance/src/a.ts', reason: 'x', owner: 'TASK-200' }] }),
    )
    const r = runParity(f.opts)
    assert.ok(r.problems.some((p) => /set-A path/.test(p)), r.problems.join('\n'))
  } finally {
    f.cleanup()
  }
})

test('RED: a delta entry pins the blob it excuses — a further edit to a listed file fails', () => {
  const f = fixture()
  try {
    put(f.kernel, 'modules/messaging/src/m.ts', 'export const m = 2\n')
    const blob = execFileSync('git', ['hash-object', 'modules/messaging/src/m.ts'], { cwd: f.kernel, encoding: 'utf8' }).trim()
    const entry = { path: 'modules/messaging/src/m.ts', reason: 'r', owner: 'TASK-200', blob }
    put(f.kernel, 'modules/EXTRACTION-DELTA.json', JSON.stringify({ entries: [entry] }))
    assert.deepEqual(runParity(f.opts).problems, [])
    put(f.kernel, 'modules/messaging/src/m.ts', 'export const m = 3\n')
    assert.ok(runParity(f.opts).problems.some((p) => /pins blob/.test(p)))
  } finally {
    f.cleanup()
  }
})

test('RED: a mode change (chmod +x) or a symlink in place of a copied file fails', () => {
  const f = fixture()
  try {
    execFileSync('git', ['add', '-A'], { cwd: f.kernel })
    execFileSync('chmod', ['+x', join(f.kernel, 'modules/messaging/src/m.ts')])
    assert.ok(runParity(f.opts).problems.some((p) => /mode/.test(p) && /m\.ts/.test(p)))
    execFileSync('chmod', ['-x', join(f.kernel, 'modules/messaging/src/m.ts')])
    assert.deepEqual(runParity(f.opts).problems, [])
    put(f.kernel, 'modules/elsewhere.ts', 'export const m = 1\n')
    rmSync(join(f.kernel, 'modules/messaging/src/m.ts'))
    execFileSync('ln', ['-s', '../../elsewhere.ts', join(f.kernel, 'modules/messaging/src/m.ts')])
    assert.ok(runParity(f.opts).problems.some((p) => /symlink/.test(p)))
  } finally {
    f.cleanup()
  }
})

test('validateDelta refuses a missing reason, a missing owner and a duplicate path', () => {
  assert.ok(validateDelta({ entries: [{ path: 'modules/a', owner: 'TASK-1' }] }).some((p) => /reason/.test(p)))
  assert.ok(validateDelta({ entries: [{ path: 'modules/a', reason: 'r' }] }).some((p) => /owner/.test(p)))
  assert.ok(
    validateDelta({
      entries: [
        { path: 'modules/a', reason: 'r', owner: 'TASK-1' },
        { path: 'modules/a', reason: 'r', owner: 'TASK-1' },
      ],
    }).some((p) => /duplicate/.test(p)),
  )
  assert.ok(validateDelta({}).some((p) => /entries/.test(p)))
  assert.ok(validateDelta({ entries: [{ path: 'modules/a', reason: 'r', owner: 'TASK-1', blob: 'xyz' }] }).some((p) => /blob/.test(p)))
  assert.deepEqual(validateDelta({ entries: [] }), [])
})

test('RED: a missing tag, a moved tag and a missing source path each refuse', () => {
  const f = fixture()
  try {
    assert.throws(() => runParity({ ...f.opts, tag: 'no-such-tag' }), /no-such-tag/)
    assert.throws(() => runParity({ ...f.opts, expectedTagCommit: f.base }), /peels to/)
    assert.throws(() => runParity({ ...f.opts, sturaPath: join(f.stura, 'nope') }), /not a git/)
  } finally {
    f.cleanup()
  }
})

test('RED: a lightweight tag is refused — the freeze is an annotated tag', () => {
  const f = fixture()
  try {
    git(f.stura, 'tag', 'light-f1', 'extraction-source-f1^{commit}')
    assert.throws(() => runParity({ ...f.opts, tag: 'light-f1' }), /annotated/)
  } finally {
    f.cleanup()
  }
})

test('the CLI exits non-zero on a missing path, a missing tag and no arguments', () => {
  const f = fixture()
  try {
    const noArgs = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
    assert.notEqual(noArgs.status, 0)
    const noPath = spawnSync(process.execPath, [SCRIPT, join(f.stura, 'nope'), 'extraction-source-f1'], {
      encoding: 'utf8',
    })
    assert.notEqual(noPath.status, 0)
    const noTag = spawnSync(process.execPath, [SCRIPT, f.stura, 'no-such-tag'], { encoding: 'utf8' })
    assert.notEqual(noTag.status, 0)
    assert.ok(existsSync(SCRIPT))
  } finally {
    f.cleanup()
  }
})

// Q6: the two set-A files keep their pre-pin tag, so check-postgres-major.mjs
// carries a per-PATH, per-REF exemption for exactly them. Proven here because
// that guard's own suite belongs to another unit.
test('Q6: the postgres exemption excuses exactly two set-A paths and one ref, and goes stale loudly', () => {
  const stale = ['postgres', '16-alpine'].join(':')
  const other = ['postgres', '15-alpine'].join(':')
  assert.deepEqual(
    PATH_EXEMPTIONS.map((e) => e.path).sort(),
    ['modules/finance/test/backfill.integration.test.ts', 'modules/finance/test/bank-money.integration.test.ts'],
  )
  const exempt = PATH_EXEMPTIONS[0].path
  const at = (n, t) => '\n'.repeat(n - 1) + t + '\n'
  const line = PATH_EXEMPTIONS[0].line
  assert.equal(typeof line, 'number')
  assert.deepEqual(checkFiles([{ path: exempt, text: at(line, `docker run ${stale}`) }]), [])
  // same path and ref on ANOTHER line: a second occurrence is not excused
  assert.equal(checkFiles([{ path: exempt, text: at(line, `docker run ${stale}`) + `docker run ${stale}\n` }]).length, 1)
  // same path, another stale ref: still a finding
  assert.equal(checkFiles([{ path: exempt, text: `docker run ${other}\n` }]).length, 1)
  // same ref, any other path (a set-B sibling included): still a finding
  assert.equal(checkFiles([{ path: 'modules/finance/test/api.integration.test.ts', text: `docker run ${stale}\n` }]).length, 1)
  // an exemption whose file no longer carries the ref is stale
  assert.equal(staleExemptions([{ path: exempt, text: 'nothing here\n' }]).length, 2)
  assert.equal(staleExemptions(PATH_EXEMPTIONS.map((e) => ({ path: e.path, text: at(e.line, `x ${stale}`) }))).length, 0)
  // moved to another line: stale
  assert.equal(staleExemptions(PATH_EXEMPTIONS.map((e) => ({ path: e.path, text: at(e.line + 1, `x ${stale}`) }))).length, 2)
})

test('RED: extras anywhere under modules/ — a stray top-level file, an unknown module dir, a non-content app/ file', () => {
  const f = fixture()
  try {
    put(f.kernel, 'modules/stray.ts', 'x')
    put(f.kernel, 'modules/newmod/index.ts', 'x')
    put(f.kernel, 'modules/finance/app/evil.ts', 'x')
    const r = runParity(f.opts)
    assert.ok(r.problems.some((p) => /modules\/stray\.ts sits directly under modules/.test(p)), r.problems.join('\n'))
    assert.ok(r.problems.some((p) => /modules\/newmod\/index\.ts .*unknown module directory/.test(p)))
    assert.ok(r.problems.some((p) => /extra: modules\/finance\/app\/evil\.ts/.test(p)))
  } finally {
    f.cleanup()
  }
})

test("RED: source 'head' checks the committed tree and refuses an uncommitted modules/", () => {
  const f = fixture()
  try {
    execFileSync('git', ['add', '-A'], { cwd: f.kernel })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.org', 'commit', '-qm', 'k'], { cwd: f.kernel })
    assert.deepEqual(runParity({ ...f.opts, source: 'head' }).problems, [])
    // untracked from the index but still on disk: the worktree view would pass, HEAD must not
    execFileSync('git', ['rm', '-q', '--cached', 'modules/votes/src/v.ts'], { cwd: f.kernel })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.org', 'commit', '-qm', 'drop'], { cwd: f.kernel })
    const r = runParity({ ...f.opts, source: 'head' })
    assert.ok(r.problems.some((p) => /uncommitted or untracked/.test(p)), r.problems.join('\n'))
    assert.ok(r.problems.some((p) => /modules\/votes\/src\/v\.ts/.test(p)))
  } finally {
    f.cleanup()
  }
})
