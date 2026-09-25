#!/usr/bin/env node
// node --test suite for the in-tree module source scan (TASK-200, TDD 2 + TDD 4).
//
// Fixture trees only: every RED case plants the exact coupling the scan exists
// to refuse (the two seeded imports named in the brief among them) and asserts
// the finding; every allowlist case asserts that the allowance is reasoned,
// exists and is not stale.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import {
  extractSpecifiers,
  extractPathLiterals,
  extractDockerCopySources,
  validateCoupledTests,
  scanModules,
  checkDiscovery,
  coupledExcludes,
} from './check-module-source-scan.mjs'

const WS_OK = "packages:\n  - 'gremion-ui'\n  - 'packages/*'\n  - 'modules/*'\n"

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 't200-scan-'))
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const BASE = {
  'pnpm-workspace.yaml': WS_OK,
  'modules/finance/package.json': '{"name":"finance-service"}',
  'modules/finance/src/index.ts': "import { a } from './a'\nexport { a }\n",
  'modules/finance/src/a.ts': 'export const a = 1\n',
  'modules/COUPLED-TESTS.json': JSON.stringify({ entries: [] }),
}

const NO_DOCKER = {}

test('extractSpecifiers reads static, re-export, side-effect, dynamic, require and vi.mock forms', () => {
  const src = [
    "import x from './x'",
    "import type { T } from '../t'",
    "import {\n  a,\n  b,\n} from '../../multi'",
    "import './side-effect'",
    "export * from './reexp'",
    "export { y } from './y'",
    "const m = await import('./dyn')",
    "const r = require('./req')",
    "vi.mock('../mocked')",
    "export const notASpecifier = 'plain string'",
  ].join('\n')
  const specs = extractSpecifiers(src).map((s) => s.spec)
  for (const s of ['./x', '../t', '../../multi', './side-effect', './reexp', './y', './dyn', './req', '../mocked'])
    assert.ok(specs.includes(s), `missing ${s} in ${JSON.stringify(specs)}`)
  assert.ok(!specs.includes('plain string'))
})

test('extractPathLiterals resolves every base idiom the copied modules use', () => {
  const src = [
    "const here = dirname(fileURLToPath(import.meta.url))",
    "const HERE = fileURLToPath(new URL('.', import.meta.url))",
    "const a = path.join(__dirname, '..', '..', '..', 'docker-compose.yml')",
    "const b = resolve(here, '../../../k8s/base/nats')",
    "const c = new URL('../../../gremion-ui/x.ts', import.meta.url)",
    "const d = join(process.cwd(), '..', 'x')",
    "const e = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')",
    "const f = join(HERE, '..', 'src', 'aggregator')",
    "const g = join(fileURLToPath(import.meta.url), '..', '..')",
    "const h = join(someVar, 'x')",
    "const i = join(HERE, name)",
    "const s = parts.join('/')",
  ].join('\n')
  const lits = extractPathLiterals(src, 'modules/votes/test/a.test.ts')
  const by = Object.fromEntries(lits.map((l) => [l.line, l]))
  assert.equal(lits.length, 9, JSON.stringify(lits))
  assert.equal(by[2].resolved, 'modules/votes/test')
  assert.equal(by[3].resolved, 'docker-compose.yml')
  assert.equal(by[4].resolved, 'k8s/base/nats')
  assert.equal(by[5].resolved, 'gremion-ui/x.ts')
  assert.deepEqual([by[6].base, by[6].resolved], ['module', 'modules/x'])
  assert.deepEqual([by[7].base, by[7].resolved], ['file', 'modules/votes/migrations'])
  assert.deepEqual([by[8].base, by[8].resolved], ['file', 'modules/votes/src/aggregator'])
  assert.equal(by[9].resolved, 'modules/votes')
  assert.deepEqual([by[10].base, by[10].resolved], ['unknown', 'modules/votes/x'])
})

test('extractDockerCopySources skips --from= stages and reads every source of a COPY', () => {
  const df = [
    'FROM node:26-alpine AS builder',
    'COPY package.json pnpm-lock.yaml ./',
    'COPY upstream/gremion/packages/ports ./upstream/gremion/packages/ports/',
    'COPY --chown=node services/finance ./services/finance/',
    'COPY --from=builder /repo/services/finance/dist ./dist',
    'COPY ["a b", "c"]',
  ].join('\n')
  const srcs = extractDockerCopySources(df).map((s) => s.source)
  assert.deepEqual(srcs, ['package.json', 'pnpm-lock.yaml', 'upstream/gremion/packages/ports', 'services/finance', 'a b'])
})

test('GREEN: a module whose imports stay inside it has zero findings', () => {
  const t = tree(BASE)
  try {
    const r = scanModules(t.root, { dockerAllowlist: NO_DOCKER })
    assert.deepEqual(r.problems, [])
    assert.equal(r.filesScanned, 2)
    assert.ok(r.specifiers >= 1)
  } finally {
    t.cleanup()
  }
})

test("RED: the seeded import from '../../../gremion-ui/src/lib/server/governance/org-units-db'", () => {
  const t = tree({
    ...BASE,
    'modules/finance/src/lib/leak.ts':
      "import x from '../../../gremion-ui/src/lib/server/governance/org-units-db'\nexport default x\n",
  })
  try {
    const r = scanModules(t.root, { dockerAllowlist: NO_DOCKER })
    assert.ok(r.problems.some((p) => /modules\/finance\/src\/lib\/leak\.ts:1/.test(p) && /leaves modules\/finance/.test(p)), r.problems.join('\n'))
  } finally {
    t.cleanup()
  }
})

test("RED: the seeded import from '../../upstream/gremion/...'", () => {
  const t = tree({ ...BASE, 'modules/finance/src/up.ts': "export { p } from '../../upstream/gremion/packages/ports'\n" })
  try {
    const r = scanModules(t.root, { dockerAllowlist: NO_DOCKER })
    assert.ok(r.problems.some((p) => /modules\/finance\/src\/up\.ts:1/.test(p) && /upstream/.test(p)), r.problems.join('\n'))
  } finally {
    t.cleanup()
  }
})

test('RED: a relative import into a SIBLING module leaves its own modules/<id>/', () => {
  const t = tree({ ...BASE, 'modules/finance/src/sib.ts': "import '../../calendar/src/x'\n" })
  try {
    const r = scanModules(t.root, { dockerAllowlist: NO_DOCKER })
    assert.ok(r.problems.some((p) => /sib\.ts:1/.test(p)))
  } finally {
    t.cleanup()
  }
})

test('RED: an @stura* package, a StuRaOS segment, a services/ segment each fail', () => {
  const t = tree({
    ...BASE,
    'modules/finance/src/pkg.ts': "import s from '@stura/kit'\nimport t from 'x/StuRaOS/y'\nimport u from 'z/services/finance/w'\n",
  })
  try {
    const r = scanModules(t.root, { dockerAllowlist: NO_DOCKER })
    const mine = r.problems.filter((p) => /pkg\.ts/.test(p))
    assert.equal(mine.length, 3, mine.join('\n'))
  } finally {
    t.cleanup()
  }
})

test('RED: require(), import(), vi.mock() and a path literal leaving the module each fail', () => {
  const t = tree({
    ...BASE,
    'modules/finance/test/deep.test.ts': [
      "const a = require('../../../x')",
      "const b = await import('../../../y')",
      "vi.mock('../../../z')",
      "const c = path.join(__dirname, '..', '..', '..', 'docker-compose.yml')",
      "const d = new URL('../../../k8s/base/nats/x.yaml', import.meta.url)",
    ].join('\n'),
  })
  try {
    const r = scanModules(t.root, { dockerAllowlist: NO_DOCKER })
    const mine = r.problems.filter((p) => /deep\.test\.ts/.test(p))
    assert.equal(mine.length, 5, mine.join('\n'))
  } finally {
    t.cleanup()
  }
})

test('RED: a nested dirname(fileURLToPath(import.meta.url)) base that climbs out is a finding, not a parse miss', () => {
  const t = tree({
    ...BASE,
    'modules/finance/test/nested.test.ts':
      "const k = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'k8s', 'base')\n",
  })
  try {
    const r = scanModules(t.root, { dockerAllowlist: NO_DOCKER })
    assert.ok(r.problems.some((p) => /nested\.test\.ts:1/.test(p) && /resolves to k8s\/base/.test(p)), r.problems.join('\n'))
  } finally {
    t.cleanup()
  }
})

test('a path literal that stays inside the module is not a finding', () => {
  const t = tree({
    ...BASE,
    'modules/finance/scripts/m.mjs':
      "const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations')\nconst x = join(process.cwd(), 'migrations')\n",
  })
  try {
    assert.deepEqual(scanModules(t.root, { dockerAllowlist: NO_DOCKER }).problems, [])
  } finally {
    t.cleanup()
  }
})

test('RED: a Dockerfile COPY of upstream/ or services/ fails unless the reasoned allowlist names it', () => {
  const df = 'FROM node:26-alpine\nCOPY upstream/gremion/packages/ports ./p/\nCOPY services/finance ./s/\n'
  const t = tree({ ...BASE, 'modules/finance/Dockerfile': df })
  try {
    let r = scanModules(t.root, { dockerAllowlist: NO_DOCKER })
    assert.equal(r.problems.filter((p) => /Dockerfile/.test(p)).length, 2)
    r = scanModules(t.root, { dockerAllowlist: { 'modules/finance/Dockerfile': 'frozen build context (TASK-038)' } })
    assert.deepEqual(r.problems, [])
    assert.equal(r.allowed.length, 2)
    r = scanModules(t.root, { dockerAllowlist: { 'modules/finance/Dockerfile': '' } })
    assert.ok(r.problems.some((p) => /reason/.test(p)))
  } finally {
    t.cleanup()
  }
})

test('RED: a stale allowlist entry (no hit, or no file) fails', () => {
  const t = tree({ ...BASE, 'modules/finance/Dockerfile': 'FROM node:26-alpine\nCOPY package.json ./\n' })
  try {
    let r = scanModules(t.root, { dockerAllowlist: { 'modules/finance/Dockerfile': 'r' } })
    assert.ok(r.problems.some((p) => /stale/.test(p)))
    r = scanModules(t.root, { dockerAllowlist: { 'modules/votes/Dockerfile': 'r' } })
    assert.ok(r.problems.some((p) => /modules\/votes\/Dockerfile/.test(p)))
  } finally {
    t.cleanup()
  }
})

test('the coupled-test list excuses exactly its own files, and is validated', () => {
  const coupled = {
    entries: [{ path: 'modules/finance/test/yearend-parity.test.ts', reason: 'imports the StuRa app half', owner: 'TASK-205' }],
  }
  const t = tree({
    ...BASE,
    'modules/COUPLED-TESTS.json': JSON.stringify(coupled),
    'modules/finance/test/yearend-parity.test.ts': "import { x } from '../../../gremion-ui/src/lib/server/finance/x'\n",
  })
  try {
    const r = scanModules(t.root, { dockerAllowlist: NO_DOCKER })
    assert.deepEqual(r.problems, [])
    assert.equal(r.allowed.length, 1)
    assert.deepEqual(coupledExcludes(t.root, 'finance'), ['--exclude', 'test/yearend-parity.test.ts'])
    assert.deepEqual(coupledExcludes(t.root, 'votes'), [])
  } finally {
    t.cleanup()
  }
})

test('RED: COUPLED-TESTS.json refuses a missing reason, a missing owner, a nonexistent path and a stale entry', () => {
  const t = tree({ ...BASE, 'modules/finance/test/clean.test.ts': "import { a } from '../src/a'\n" })
  try {
    const bad = (entries) => validateCoupledTests(t.root, { entries })
    assert.ok(bad([{ path: 'modules/finance/test/clean.test.ts', owner: 'TASK-205' }]).some((p) => /reason/.test(p)))
    assert.ok(bad([{ path: 'modules/finance/test/clean.test.ts', reason: 'r' }]).some((p) => /owner/.test(p)))
    assert.ok(bad([{ path: 'modules/finance/test/nope.test.ts', reason: 'r', owner: 'TASK-205' }]).some((p) => /does not exist/.test(p)))
    assert.ok(validateCoupledTests(t.root, {}).some((p) => /entries/.test(p)))
    writeFileSync(
      join(t.root, 'modules/COUPLED-TESTS.json'),
      JSON.stringify({ entries: [{ path: 'modules/finance/test/clean.test.ts', reason: 'r', owner: 'TASK-205' }] }),
    )
    const r = scanModules(t.root, { dockerAllowlist: NO_DOCKER })
    assert.ok(r.problems.some((p) => /stale/.test(p) && /clean\.test\.ts/.test(p)), r.problems.join('\n'))
    assert.throws(() => coupledExcludes(t.root, 'finance'), /stale|COUPLED/)
  } finally {
    t.cleanup()
  }
})

test('RED: the scan refuses zero files, and a missing COUPLED-TESTS.json', () => {
  const t = tree({ 'pnpm-workspace.yaml': WS_OK, 'modules/COUPLED-TESTS.json': '{"entries":[]}' })
  try {
    assert.ok(scanModules(t.root, { dockerAllowlist: NO_DOCKER }).problems.some((p) => /zero/.test(p)))
  } finally {
    t.cleanup()
  }
  const u = tree({ 'pnpm-workspace.yaml': WS_OK, 'modules/finance/package.json': '{}', 'modules/finance/a.ts': '' })
  try {
    assert.ok(scanModules(u.root, { dockerAllowlist: NO_DOCKER }).problems.some((p) => /COUPLED-TESTS/.test(p)))
  } finally {
    u.cleanup()
  }
})

test("discovery (TDD 4): 'modules/*' finds every module; RED with 'modules/*/*', a missing glob, or a module with no package.json", () => {
  const t = tree({
    ...BASE,
    'modules/votes/package.json': '{"name":"votes-service"}',
    'modules/content/app/migrations/1200_x.sql': '',
  })
  try {
    // content has no package.json: refused by name.
    let probs = checkDiscovery(t.root, WS_OK)
    assert.ok(probs.some((p) => /modules\/content/.test(p) && /package\.json/.test(p)), probs.join('\n'))
    writeFileSync(join(t.root, 'modules/content/package.json'), '{"name":"content-service"}')
    assert.deepEqual(checkDiscovery(t.root, WS_OK), [])
    probs = checkDiscovery(t.root, "packages:\n  - 'gremion-ui'\n  - 'modules/*/*'\n")
    assert.equal(probs.filter((p) => /silently/.test(p)).length, 3, probs.join('\n'))
    probs = checkDiscovery(t.root, "packages:\n  - 'gremion-ui'\n")
    assert.equal(probs.filter((p) => /silently/.test(p)).length, 3)
  } finally {
    t.cleanup()
  }
})
