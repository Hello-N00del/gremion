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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync, lstatSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PATH_EXEMPTIONS, checkFiles, staleExemptions } from './check-postgres-major.mjs'
import {
  MODULE_ID_MAP,
  MODULE_APP_PREFIXES,
  CONTENT_UI_PREFIXES,
  appOwners,
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

/** One in-process-half file per moved module besides content: [dir under gremion-ui/src/, file, module id]. */
const APP_FIXTURE = [
  ['lib/server/board/', 'b.ts', 'board'],
  ['lib/server/calendar/', 'k.ts', 'calendar'],
  ['lib/server/elections/', 'e.ts', 'elections'],
  ['lib/server/files/', 'f.ts', 'files'],
  ['lib/server/messages/', 'm.ts', 'messaging'],
  ['lib/server/polls/', 'p.ts', 'votes'],
  ['lib/server/newsletter/', 'q.ts', 'publishing'],
  ['lib/server/vault/', 'w.ts', 'vault'],
]

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
  for (const [dir, name] of APP_FIXTURE) put(stura, `gremion-ui/src/${dir}${name}`, `export const x = '${dir}'\n`)
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
  for (const [dir, name, id] of APP_FIXTURE) put(kernel, `modules/${id}/app/${dir}${name}`, `export const x = '${dir}'\n`)
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
  // The per-module table (TASK-205): one module per path, the landed layout (no src/ level).
  assert.equal(mapSourcePath('gremion-ui/src/routes/api/calendar/+server.ts'), 'modules/calendar/app/routes/api/calendar/+server.ts')
  assert.equal(mapSourcePath('gremion-ui/src/lib/modules/manifests/messages.ts'), 'modules/messaging/app/lib/modules/manifests/messages.ts')
  assert.equal(mapSourcePath('gremion-ui/src/lib/votes/aggregator.ts'), 'modules/elections/app/lib/votes/aggregator.ts')
  assert.equal(mapSourcePath('gremion-ui/src/lib/client/cast-service.ts'), 'modules/votes/app/lib/client/cast-service.ts')
  assert.equal(mapSourcePath('gremion-ui/src/routes/users/+page.svelte'), null, 'users/** is TASK-131, not a module app file')
  // TASK-205c: publishing (the newsletter half, its leaf callback routes and audit consumer) and vault (vault and vault-extern).
  assert.equal(mapSourcePath('gremion-ui/src/routes/newsletter/+page.svelte'), 'modules/publishing/app/routes/newsletter/+page.svelte')
  assert.equal(mapSourcePath('gremion-ui/src/routes/api/internal/newsletter/render/+server.ts'), 'modules/publishing/app/routes/api/internal/newsletter/render/+server.ts')
  assert.equal(mapSourcePath('gremion-ui/src/lib/server/events/newsletter-audit-consumer.ts'), 'modules/publishing/app/lib/server/events/newsletter-audit-consumer.ts')
  assert.equal(mapSourcePath('gremion-ui/src/lib/modules/manifests/newsletter.ts'), 'modules/publishing/app/lib/modules/manifests/newsletter.ts')
  assert.equal(mapSourcePath('gremion-ui/src/routes/vault/+page.svelte'), 'modules/vault/app/routes/vault/+page.svelte')
  assert.equal(mapSourcePath('gremion-ui/src/routes/vault-extern/+page.svelte'), 'modules/vault/app/routes/vault-extern/+page.svelte')
  assert.equal(mapSourcePath('gremion-ui/src/lib/modules/manifests/vault.ts'), 'modules/vault/app/lib/modules/manifests/vault.ts')
  assert.equal(mapSourcePath('gremion-ui/src/lib/modules/manifests/vaultwarden.ts'), null, 'vaultwarden.* is TASK-157, not the vault half')
  assert.equal(mapSourcePath('gremion-ui/src/lib/server/handover/handover-vault-links.ts'), null, 'handover-vault-links moves with the handover half (TASK-205d)')
  assert.equal(mapSourcePath('gremion-ui/src/routes/api/internal/content/portal-publish/+server.ts'), 'modules/content/app/routes/api/internal/content/portal-publish/+server.ts')
  assert.deepEqual(appOwners('gremion-ui/src/lib/server/events/content-audit-consumer.ts'), ['content'])
  for (const id of ['board', 'calendar', 'content', 'elections', 'files', 'messaging', 'publishing', 'vault', 'votes']) assert.ok(MODULE_APP_PREFIXES[id].length > 0, id)
  assert.deepEqual(appOwners('gremion-ui/src/lib/server/board/x.ts'), ['board'])
})

test('GREEN: a byte-equal copy reports zero mismatches in every set', () => {
  const f = fixture()
  try {
    const r = runParity(f.opts)
    assert.deepEqual(r.problems, [])
    assert.equal(r.sets.A.total, 1)
    assert.equal(r.sets.B.total, 4)
    assert.equal(r.sets.C.total, 1 + APP_FIXTURE.length)
    for (const s of ['A', 'B', 'C']) assert.deepEqual(r.sets[s].mismatches, [])
    assert.match(formatReport(r), /RESULT: OK/)
  } finally {
    f.cleanup()
  }
})

test('RED: a one-byte edit in a set-A file fails; only a BLOB-PINNED kernel-ahead entry excuses it, and never at --copy', () => {
  const f = fixture()
  try {
    put(f.kernel, 'modules/finance/src/a.ts', 'export const a = 3\n')
    let r = runParity(f.opts)
    assert.ok(r.sets.A.mismatches.some((m) => m.kernelPath === 'modules/finance/src/a.ts'))
    assert.ok(r.problems.some((p) => /set A/.test(p) && /modules\/finance\/src\/a\.ts/.test(p)))
    // An unpinned listing does not excuse set A: the pin is what makes it a recorded kernel-ahead edit.
    put(
      f.kernel,
      'modules/EXTRACTION-DELTA.json',
      JSON.stringify({ entries: [{ path: 'modules/finance/src/a.ts', reason: 'x', owner: 'TASK-200' }] }),
    )
    r = runParity(f.opts)
    assert.ok(r.problems.some((p) => /set A/.test(p)))
    // Pinned: excused at the tip (R29-style kernel-ahead edit) ...
    const entry = { path: 'modules/finance/src/a.ts', reason: 'kernel-ahead: later fix', owner: 'TASK-205', blob: blobOf(f.kernel, 'modules/finance/src/a.ts') }
    put(f.kernel, 'modules/EXTRACTION-DELTA.json', JSON.stringify({ entries: [entry] }))
    assert.deepEqual(runParity(f.opts).problems, [])
    // ... but never at the byte-equal copy commit, and a further edit breaks the pin.
    assert.ok(runParity({ ...f.opts, copy: true }).problems.some((p) => /set A/.test(p) && /--copy/.test(p)))
    put(f.kernel, 'modules/finance/src/a.ts', 'export const a = 4\n')
    assert.ok(runParity(f.opts).problems.some((p) => /pins blob/.test(p)))
  } finally {
    f.cleanup()
  }
})

test('RED: a one-byte edit in ANY module\'s app/ file fails unless listed (partition guard, per module)', () => {
  const f = fixture()
  try {
    for (const [dir, name, id] of APP_FIXTURE) {
      const rel = `modules/${id}/app/${dir}${name}`
      put(f.kernel, rel, 'export const x = "edited"\n')
      const r = runParity(f.opts)
      assert.ok(r.problems.some((p) => /set C/.test(p) && p.includes(rel)), `${id}: ${r.problems.join('\n')}`)
      put(f.kernel, rel, `export const x = '${dir}'\n`)
      assert.deepEqual(runParity(f.opts).problems, [], id)
    }
  } finally {
    f.cleanup()
  }
})

test('RED: a StuRa path claimed by two modules is refused (doubly mapped), and never copied to either', () => {
  const f = fixture()
  try {
    const table = {
      ...MODULE_APP_PREFIXES,
      messaging: [...MODULE_APP_PREFIXES.messaging, 'gremion-ui/src/lib/server/polls/'], // overlaps votes
    }
    const r = runParity({ ...f.opts, appPrefixes: table })
    assert.ok(r.problems.some((p) => /doubly mapped/.test(p) && /polls\/p\.ts/.test(p)), r.problems.join('\n'))
    assert.equal(mapSourcePath('gremion-ui/src/lib/server/polls/p.ts', table), null)
  } finally {
    f.cleanup()
  }
})

test('RED: a module whose app prefixes match nothing is refused (zero matches is not a pass)', () => {
  const f = fixture()
  try {
    const table = { ...MODULE_APP_PREFIXES, board: ['gremion-ui/src/lib/server/nonexistent/'] }
    const r = runParity({ ...f.opts, appPrefixes: table })
    assert.ok(r.problems.some((p) => /module board: its app prefixes match no path/.test(p)), r.problems.join('\n'))
  } finally {
    f.cleanup()
  }
})

test('RED: a services/<unknown>/ path at the tag is unmapped and refused', () => {
  const f = fixture()
  try {
    put(f.stura, 'services/mystery/src/x.ts', 'x\n')
    git(f.stura, 'add', '-A')
    git(f.stura, 'commit', '-q', '-m', 'mystery')
    git(f.stura, 'tag', '-a', 'extraction-source-f9', '-m', 'freeze')
    const tagCommit = git(f.stura, 'rev-parse', 'extraction-source-f9^{commit}')
    const r = runParity({ ...f.opts, tag: 'extraction-source-f9', expectedTagCommit: tagCommit })
    assert.ok(r.problems.some((p) => /services\/mystery\/src\/x\.ts: no module id maps it/.test(p)), r.problems.join('\n'))
  } finally {
    f.cleanup()
  }
})

test('RED: an undeclared kernel-side extra inside a moved module\'s app/ fails; module.json is metadata, not an extra', () => {
  const f = fixture()
  try {
    put(f.kernel, 'modules/calendar/module.json', '{}\n')
    put(f.kernel, 'modules/elections/module.json', '{}\n')
    put(f.kernel, 'modules/elections/package.json', '{}\n')
    assert.deepEqual(runParity(f.opts).problems, [])
    put(f.kernel, 'modules/calendar/app/lib/server/calendar/stray.ts', 'export {}\n')
    const r = runParity(f.opts)
    assert.ok(r.problems.some((p) => /extra: modules\/calendar\/app\/lib\/server\/calendar\/stray\.ts/.test(p)), r.problems.join('\n'))
    // an unrelated module's package.json is NOT metadata
    rmSync(join(f.kernel, 'modules/calendar/app/lib/server/calendar/stray.ts'))
    put(f.kernel, 'modules/calendar/package.json', '{}\n')
    assert.ok(runParity(f.opts).problems.some((p) => /extra: modules\/calendar\/package\.json/.test(p)))
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

// What this filesystem can express, probed rather than assumed from the
// platform name: on Windows a file never carries an exec bit (lstat mode has
// no 0o111, whatever chmod does) and a symlink needs Developer Mode or
// elevation (else EPERM; MSYS `ln -s` silently copies). A RED the platform
// cannot express is SKIPPED with that reason, never faked GREEN; on
// Linux/macOS both run.
function fsCaps() {
  const dir = mkdtempSync(join(tmpdir(), 't200-parity-caps-'))
  try {
    const f = join(dir, 'f')
    writeFileSync(f, '')
    let exec = false
    try {
      chmodSync(f, 0o755)
      exec = (lstatSync(f).mode & 0o111) !== 0
    } catch {
      exec = false
    }
    let link = false
    try {
      symlinkSync('f', join(dir, 'l'))
      link = lstatSync(join(dir, 'l')).isSymbolicLink()
    } catch {
      link = false
    }
    return { exec, link }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const CAPS = fsCaps()
const NO_EXEC = 'this filesystem gives no file an exec bit (Windows): the mode RED cannot be expressed here; it runs on Linux/macOS'
const NO_LINK = 'this platform cannot create a symlink (Windows without Developer Mode): the symlink RED cannot be expressed here; it runs on Linux/macOS'

test('RED: a mode change (chmod +x) of a copied file fails', { skip: CAPS.exec ? false : NO_EXEC }, () => {
  const f = fixture()
  try {
    execFileSync('git', ['add', '-A'], { cwd: f.kernel })
    chmodSync(join(f.kernel, 'modules/messaging/src/m.ts'), 0o755)
    assert.ok(runParity(f.opts).problems.some((p) => /mode/.test(p) && /m\.ts/.test(p)))
    chmodSync(join(f.kernel, 'modules/messaging/src/m.ts'), 0o644)
    assert.deepEqual(runParity(f.opts).problems, [])
  } finally {
    f.cleanup()
  }
})

test('RED: a symlink in place of a copied file fails', { skip: CAPS.link ? false : NO_LINK }, () => {
  const f = fixture()
  try {
    execFileSync('git', ['add', '-A'], { cwd: f.kernel })
    assert.deepEqual(runParity(f.opts).problems, [])
    put(f.kernel, 'modules/elsewhere.ts', 'export const m = 1\n')
    rmSync(join(f.kernel, 'modules/messaging/src/m.ts'))
    symlinkSync('../../elsewhere.ts', join(f.kernel, 'modules/messaging/src/m.ts'))
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
