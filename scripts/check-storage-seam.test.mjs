#!/usr/bin/env node
// node --test suite for the storage-seam bypass scan (TASK-117 TDD 5). Same
// idiom as check-toolchain.test.mjs: assert POST-CONDITIONS on real file
// content and on synthetic broken trees, never only an exit code. Every RED
// case here is one the guard must be seen failing on before it is trusted.
//
// Scratch trees live under <checkout>/.scratch/t117/, never os.tmpdir().

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { ALLOWLIST, SCAN_ROOTS, SEAM_DIR, scan } from './check-storage-seam.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = join(ROOT, '.scratch', 't117')
const SCRIPT = join(ROOT, 'scripts', 'check-storage-seam.mjs')
let seq = 0

/** An empty tree with every scan root present (so only the seeded files count). */
function emptyTree() {
  const dir = join(SCRATCH, `seam-${process.pid}-${Date.now()}-${seq++}`)
  for (const r of SCAN_ROOTS) mkdirSync(join(dir, r), { recursive: true })
  return dir
}
function seed(tree, rel, text) {
  mkdirSync(dirname(join(tree, rel)), { recursive: true })
  writeFileSync(join(tree, rel), text)
}
const BYPASS = "import { writeFileSync } from 'node:fs'\nexport function leak() {\n  writeFileSync('/data/x.pdf', 'y')\n}\n"
const guards = (r) => r.findings.map((f) => `${f.guard} ${f.file}:${f.line}`)

// ── the real tree ─────────────────────────────────────────────────────────

test('GREEN — the real tree passes, and actually looked at files', () => {
  const r = scan({ root: ROOT })
  assert.deepEqual(r.problems, [])
  assert.deepEqual(r.findings, [])
  assert.ok(r.filesScanned > 100, `only ${r.filesScanned} files scanned`)
  // every allowlist entry was exercised (a stale entry is itself a problem)
  assert.equal(r.allowlisted.length >= ALLOWLIST.length, true)
})

test('the CLI exits 0 on the real tree and says how much it scanned', () => {
  const out = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /check-storage-seam: OK — \d+ files scanned/)
})

// ── s3: raw fs writes outside the seam ────────────────────────────────────

test('RED — a raw fs write seeded in gremion-ui/src/lib/server/ fails s3 (copy of the real tree)', () => {
  const tree = join(SCRATCH, `seam-real-${process.pid}-${Date.now()}`)
  for (const r of SCAN_ROOTS) {
    cpSync(join(ROOT, r), join(tree, r), { recursive: true, filter: (src) => !/[\\/](node_modules|dist|\.svelte-kit)$/.test(src) })
  }
  seed(tree, 'gremion-ui/src/lib/server/bypass.ts', BYPASS)
  try {
    const r = scan({ root: tree })
    assert.deepEqual(guards(r), ['s3 gremion-ui/src/lib/server/bypass.ts:1', 's3 gremion-ui/src/lib/server/bypass.ts:3'])
    const cli = spawnSync(process.execPath, [SCRIPT, '--root', tree], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(cli.status, 1)
    assert.match(cli.stderr, /s3 gremion-ui\/src\/lib\/server\/bypass\.ts:3 .*writeFileSync/)
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
})

test('RED — s3 sees aliased, namespace, require, dynamic-import and getBuiltinModule writes', () => {
  const tree = emptyTree()
  seed(tree, 'gremion-ui/src/a.ts', "import { writeFile as w } from 'fs/promises'\nawait w('x', 'y')\n")
  seed(tree, 'gremion-ui/src/b.ts', "import * as fs from 'node:fs'\nfs.promises.appendFile('x', 'y')\n")
  seed(tree, 'gremion-public/src/c.js', "const fs = require('fs')\nfs.createWriteStream('x')\n")
  seed(tree, 'modules/content/d.ts', "const { rm } = await import('node:fs/promises')\nawait rm('x')\n")
  seed(tree, 'packages/foo/src/e.ts', "const fs = process.getBuiltinModule('node:fs')\nfs.renameSync('a', 'b')\n")
  seed(tree, 'gremion-ui/src/f.svelte', "<script>\nimport fse from 'fs-extra'\nfse.outputFileSync('x', 'y')\n</script>\n")
  try {
    const r = scan({ root: tree, allowlist: [] })
    const files = [...new Set(r.findings.filter((f) => f.guard === 's3').map((f) => f.file))].sort()
    assert.deepEqual(files, [
      'gremion-public/src/c.js',
      'gremion-ui/src/a.ts',
      'gremion-ui/src/b.ts',
      'gremion-ui/src/f.svelte',
      'modules/content/d.ts',
      'packages/foo/src/e.ts',
    ])
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
})

test('GREEN — reads, the seam itself, and test files are not s3 findings', () => {
  const tree = emptyTree()
  seed(tree, 'gremion-ui/src/read.ts', "import { readFileSync, existsSync } from 'node:fs'\nreadFileSync('x')\n")
  seed(tree, `${SEAM_DIR}/src/local.ts`, BYPASS)
  seed(tree, 'gremion-ui/src/lib/server/x.test.ts', BYPASS)
  seed(tree, 'gremion-ui/src/noimport.svelte', '<td class="truncate">{rm(x)}</td>\n')
  try {
    const r = scan({ root: tree, allowlist: [] })
    assert.deepEqual(r.findings, [])
    assert.deepEqual(r.problems, [])
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
})

// ── s1 / s2 ───────────────────────────────────────────────────────────────

test('RED — s1: an export named getStorage (or the storage proxy) fails; getStorageFor does not', () => {
  const tree = emptyTree()
  seed(tree, 'gremion-ui/src/lib/server/storage/index.ts', 'export function getStorage() {}\nexport function getStorageFor(t) {}\n')
  seed(tree, 'gremion-ui/src/lib/server/storage/proxy.ts', 'export const storage = {}\n')
  seed(tree, 'packages/x/src/y.ts', 'const g = 1\nexport { g as getStorage }\n')
  try {
    const r = scan({ root: tree, allowlist: [] })
    assert.deepEqual(guards(r).sort(), [
      's1 gremion-ui/src/lib/server/storage/index.ts:1',
      's1 gremion-ui/src/lib/server/storage/proxy.ts:1',
      's1 packages/x/src/y.ts:2',
    ])
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
})

test('RED — s2: an ambient tenant read under a storage/ directory fails', () => {
  const tree = emptyTree()
  seed(tree, 'gremion-ui/src/lib/server/storage/index.ts', "import { currentTenantId } from '../tenant/context'\nconst t = currentTenantId()\n")
  seed(tree, `${SEAM_DIR}/src/index.ts`, 'const t = requireTenant().id\n')
  seed(tree, 'gremion-ui/src/lib/server/other.ts', 'const t = currentTenantId()\n')
  try {
    const r = scan({ root: tree, allowlist: [] })
    assert.deepEqual(guards(r).sort(), [
      's2 gremion-ui/src/lib/server/storage/index.ts:2',
      's2 packages/storage/src/index.ts:1',
    ])
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
})

// ── vacuity and allowlist hygiene ─────────────────────────────────────────

test('RED — zero files scanned is refused, not a vacuous pass', () => {
  const tree = emptyTree()
  try {
    const r = scan({ root: tree, allowlist: [] })
    assert.match(r.problems.join('\n'), /scanned zero files/)
    const cli = spawnSync(process.execPath, [SCRIPT, '--root', tree], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(cli.status, 1)
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
})

test('RED — a missing scan root is refused', () => {
  const tree = emptyTree()
  rmSync(join(tree, 'gremion-ui/src'), { recursive: true })
  seed(tree, 'packages/x/src/y.ts', 'export const y = 1\n')
  try {
    assert.match(scan({ root: tree, allowlist: [] }).problems.join('\n'), /scan root gremion-ui\/src does not exist/)
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
})

test('every allowlist entry carries a reason and a residual', () => {
  assert.ok(ALLOWLIST.length > 0)
  for (const e of ALLOWLIST) {
    assert.ok(typeof e.path === 'string' && e.path.length > 0)
    assert.ok(typeof e.reason === 'string' && e.reason.length > 20, `${e.path}: no reason`)
    assert.ok(typeof e.residual === 'string' && e.residual.length > 20, `${e.path}: no residual`)
  }
})

test('RED — a stale allowlist entry (matches no write) and an entry with no reason are refused', () => {
  const tree = emptyTree()
  seed(tree, 'gremion-ui/src/w.ts', BYPASS)
  try {
    const r = scan({
      root: tree,
      allowlist: [
        { path: 'gremion-ui/src/w.ts', reason: 'fixture reason long enough', residual: 'fixture residual long enough' },
        { path: 'gremion-ui/src/gone.ts', reason: 'fixture reason long enough', residual: 'fixture residual long enough' },
        { path: 'gremion-ui/src/w2.ts', reason: '', residual: '' },
      ],
    })
    assert.deepEqual(r.findings, [])
    const p = r.problems.join('\n')
    assert.match(p, /allowlist entry gremion-ui\/src\/gone\.ts is stale/)
    assert.match(p, /allowlist entry gremion-ui\/src\/w2\.ts has no reason/)
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
})
