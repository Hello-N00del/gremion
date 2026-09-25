import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateSuite,
  findUnclaimed,
  unclaimedRows,
  overallExit,
  unknownOnlyRows,
  snapshotBaseName,
  renderMarkdown,
} from './snapshot-core.mjs'
import { DEFAULT_TIMEOUT_MS } from './run.mjs'

function baseOpts(overrides = {}) {
  return {
    joinRepo: (p) => `/repo/${p}`,
    runFn: () => ({ exitCode: 0, output: '', timedOut: false, spawnError: null }),
    ...overrides,
  }
}

test('evaluateSuite: manifest suite whose files are absent is a FAIL, and never runs the command', () => {
  let ran = false
  const suite = {
    id: 'k1',
    repo: 'kernel',
    category: 'unit',
    cwd: '.',
    kind: 'vitest',
    command: 'pnpm test',
    testGlobs: ['nowhere/**/*.test.ts'],
  }
  const opts = baseOpts({ runFn: () => ((ran = true), { exitCode: 0, output: '', timedOut: false, spawnError: null }) })
  const row = evaluateSuite(suite, ['elsewhere/a.test.ts'], opts)
  assert.equal(row.status, 'FAIL')
  assert.match(row.reason, /manifest suite files absent/)
  assert.equal(ran, false)
})

test('evaluateSuite: a stack-requiring suite FAILs with "no stack" and never runs, when --stack-env is absent', () => {
  let ran = false
  const suite = {
    id: 'k2',
    repo: 'kernel',
    category: 'integration',
    cwd: '.',
    kind: 'vitest',
    command: 'pnpm test:integration',
    requiresStack: true,
    testGlobs: ['src/**/*.integration.test.ts'],
  }
  const opts = baseOpts({ runFn: () => ((ran = true), { exitCode: 0, output: '', timedOut: false, spawnError: null }) })
  const row = evaluateSuite(suite, ['src/a.integration.test.ts'], opts)
  assert.equal(row.status, 'FAIL')
  assert.match(row.reason, /no stack/)
  assert.equal(ran, false)
})

test('evaluateSuite: a stack-requiring suite DOES run when --stack-env is given', () => {
  const suite = {
    id: 'k2',
    repo: 'kernel',
    category: 'integration',
    cwd: '.',
    kind: 'vitest',
    command: 'pnpm test:integration',
    requiresStack: true,
    testGlobs: ['src/**/*.integration.test.ts'],
  }
  const opts = baseOpts({
    stackEnvFile: '/tmp/stack.env',
    stackEnvExists: true,
    runFn: () => ({ exitCode: 0, output: '      Tests  3 passed (3)\n', timedOut: false, spawnError: null }),
  })
  const row = evaluateSuite(suite, ['src/a.integration.test.ts'], opts)
  assert.equal(row.status, 'PASS')
  assert.equal(row.collected, 3)
})

test('evaluateSuite: LOW fix — a requiresStack suite still FAILs "no stack" when --stack-env names a file that does not exist, and never runs the command', () => {
  let ran = false
  const suite = {
    id: 'k2b',
    repo: 'kernel',
    category: 'integration',
    cwd: '.',
    kind: 'vitest',
    command: 'pnpm test:integration',
    requiresStack: true,
    testGlobs: ['src/**/*.integration.test.ts'],
  }
  const opts = baseOpts({
    stackEnvFile: '/does/not/exist/stack.env',
    stackEnvExists: false,
    runFn: () => ((ran = true), { exitCode: 0, output: '', timedOut: false, spawnError: null }),
  })
  const row = evaluateSuite(suite, ['src/a.integration.test.ts'], opts)
  assert.equal(row.status, 'FAIL')
  assert.match(row.reason, /does not exist/)
  assert.equal(ran, false, 'a nonexistent --stack-env file must never let the suite actually run')
})

test('evaluateSuite: 0 collected is a FAIL even on exit code 0 — a scan that collected zero files never passes', () => {
  const suite = { id: 'k3', repo: 'kernel', category: 'unit', cwd: '.', kind: 'vitest', command: 'x', testGlobs: ['a.test.ts'] }
  const opts = baseOpts({ runFn: () => ({ exitCode: 0, output: 'no Tests line here', timedOut: false, spawnError: null }) })
  const row = evaluateSuite(suite, ['a.test.ts'], opts)
  assert.equal(row.status, 'FAIL')
  assert.equal(row.collected, 0)
})

test('evaluateSuite: a suite that could not run (missing tool) is a FAIL, not a skip', () => {
  const suite = { id: 'k4', repo: 'kernel', category: 'shell', cwd: '.', kind: 'bats', command: 'bats x', testGlobs: ['x.bats'] }
  const opts = baseOpts({
    runFn: () => ({ exitCode: 1, output: 'bats: not found', timedOut: false, spawnError: new Error('spawn bats ENOENT') }),
  })
  const row = evaluateSuite(suite, ['x.bats'], opts)
  assert.equal(row.status, 'FAIL')
  assert.match(row.reason, /could not run/)
})

test('evaluateSuite: a timed-out suite is a FAIL with a "timed out after Ns" reason naming the resolved timeout', () => {
  const suite = { id: 'k5', repo: 'kernel', category: 'unit', cwd: '.', kind: 'vitest', command: 'x', timeoutMs: 600_000, testGlobs: ['a.test.ts'] }
  const opts = baseOpts({ runFn: () => ({ exitCode: 1, output: '', timedOut: true, spawnError: null }) })
  const row = evaluateSuite(suite, ['a.test.ts'], opts)
  assert.equal(row.status, 'FAIL')
  assert.match(row.reason, /timed out after 600s/)
})

test('evaluateSuite: passes the suite\'s own timeoutMs to runFn, and falls back to run.mjs\'s DEFAULT_TIMEOUT_MS when the suite omits it', () => {
  const seen = []
  const record = (command, cwd, runOpts) => (seen.push(runOpts), { exitCode: 0, output: '      Tests  1 passed (1)\n', timedOut: false, spawnError: null })

  const withTimeout = { id: 'k5a', repo: 'kernel', category: 'unit', cwd: '.', kind: 'vitest', command: 'x', timeoutMs: 600_000, testGlobs: ['a.test.ts'] }
  evaluateSuite(withTimeout, ['a.test.ts'], baseOpts({ runFn: record }))
  assert.equal(seen[0].timeoutMs, 600_000)

  const withoutTimeout = { id: 'k5b', repo: 'kernel', category: 'unit', cwd: '.', kind: 'vitest', command: 'x', testGlobs: ['a.test.ts'] }
  evaluateSuite(withoutTimeout, ['a.test.ts'], baseOpts({ runFn: record }))
  assert.equal(seen[1].timeoutMs, DEFAULT_TIMEOUT_MS)
})

test('evaluateSuite: HIGH fix — a timeout is reported as "timed out", never the generic "could not run", even when runFn also sets spawnError (defense-in-depth against the old misattribution)', () => {
  const suite = { id: 'k5c', repo: 'kernel', category: 'unit', cwd: '.', kind: 'vitest', command: 'x', timeoutMs: 120_000, testGlobs: ['a.test.ts'] }
  const opts = baseOpts({
    runFn: () => ({ exitCode: 1, output: '', timedOut: true, spawnError: new Error('spawnSync ETIMEDOUT') }),
  })
  const row = evaluateSuite(suite, ['a.test.ts'], opts)
  assert.equal(row.status, 'FAIL')
  assert.match(row.reason, /timed out after 120s/)
  assert.doesNotMatch(row.reason, /could not run/)
})

test('evaluateSuite: a clean run is a PASS with real counts', () => {
  const suite = { id: 'k6', repo: 'kernel', category: 'unit', cwd: '.', kind: 'vitest', command: 'x', testGlobs: ['a.test.ts'] }
  const opts = baseOpts({ runFn: () => ({ exitCode: 0, output: '      Tests  5 passed (5)\n', timedOut: false, spawnError: null }) })
  const row = evaluateSuite(suite, ['a.test.ts'], opts)
  assert.deepEqual([row.status, row.collected, row.passed, row.failed], ['PASS', 5, 5, 0])
})

test('evaluateSuite: declared-vs-collected mismatch on a node-test suite is a FAIL even though node exited 0 (silent non-registration)', () => {
  const suite = { id: 'k7', repo: 'kernel', category: 'unit', cwd: '.', kind: 'node-test', command: 'node --test a.test.mjs', testGlobs: ['a.test.mjs'] }
  const tapOutput = '1..1\n# tests 1\n# pass 1\n# fail 0\n'
  const opts = baseOpts({
    runFn: () => ({ exitCode: 0, output: tapOutput, timedOut: false, spawnError: null }),
    countDeclared: () => 12, // the file declares 12 test(...) but only 1 registered
  })
  const row = evaluateSuite(suite, ['a.test.mjs'], opts)
  assert.equal(row.status, 'FAIL')
  assert.match(row.reason, /declared 12 test\(s\)/)
})

test('evaluateSuite: declared-vs-collected agreement on a node-test suite stays a PASS', () => {
  const suite = { id: 'k8', repo: 'kernel', category: 'unit', cwd: '.', kind: 'node-test', command: 'node --test a.test.mjs', testGlobs: ['a.test.mjs'] }
  const tapOutput = '1..3\n# tests 3\n# pass 3\n# fail 0\n'
  const opts = baseOpts({
    runFn: () => ({ exitCode: 0, output: tapOutput, timedOut: false, spawnError: null }),
    countDeclared: () => 3,
  })
  const row = evaluateSuite(suite, ['a.test.mjs'], opts)
  assert.equal(row.status, 'PASS')
})

test('evaluateSuite: node collecting MORE tests than the naive declared count is a PASS, never a FAIL — the check is one-directional', () => {
  // Real-world case (seen against the kernel tip's own kernel-scripts-node-test
  // suite): a file with tests nested in a describe block, a loop, or any
  // registration not starting at column 0 makes `countDeclared`'s naive
  // `^test\(/gm` regex undercount. That is NOT the "tests silently stopped
  // registering" failure this check exists for — node registered them all,
  // it just didn't do so in a shape the naive counter can see — so it must
  // never turn a genuinely passing suite red.
  const suite = { id: 'k9', repo: 'kernel', category: 'unit', cwd: '.', kind: 'node-test', command: 'node --test a.test.mjs', testGlobs: ['a.test.mjs'] }
  const tapOutput = '1..245\n# tests 245\n# pass 245\n# fail 0\n'
  const opts = baseOpts({
    runFn: () => ({ exitCode: 0, output: tapOutput, timedOut: false, spawnError: null }),
    countDeclared: () => 216, // naive column-0 count undercounts nested/looped registrations
  })
  const row = evaluateSuite(suite, ['a.test.mjs'], opts)
  assert.equal(row.status, 'PASS')
  assert.equal(row.collected, 245)
})

test('findUnclaimed reports a test file no suite\'s globs reach', () => {
  const suites = [{ testGlobs: ['src/**/*.test.ts'] }]
  const files = ['src/a.test.ts', 'scripts/orphan.test.mjs']
  assert.deepEqual(findUnclaimed(files, suites), ['scripts/orphan.test.mjs'])
})

test('unclaimedRows shapes each orphan as a FAIL row', () => {
  const rows = unclaimedRows('kernel', ['scripts/orphan.test.mjs'])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'FAIL')
  assert.equal(rows[0].repo, 'kernel')
  assert.match(rows[0].reason, /not claimed/)
})

test('overallExit is 0 only when every row PASSed, and 1 for an empty row list (a snapshot that recorded nothing is never green — MEDIUM fix)', () => {
  assert.equal(overallExit([{ status: 'PASS' }, { status: 'PASS' }]), 0)
  assert.equal(overallExit([{ status: 'PASS' }, { status: 'FAIL' }]), 1)
  assert.equal(overallExit([]), 1)
})

test('evaluateSuite: a suite whose every collected test was skipped is a FAIL, never a PASS (MEDIUM fix: fail-closed verify allows no skip)', () => {
  const suite = { id: 'v1', repo: 'vertical', category: 'unit', cwd: '.', kind: 'vitest', command: 'pnpm test', testGlobs: ['src/**/*.test.ts'] }
  const allSkipped = evaluateSuite(suite, ['src/a.test.ts'], baseOpts({ runFn: () => ({ exitCode: 0, output: '      Tests  12 skipped (12)\n', timedOut: false, spawnError: null }) }))
  assert.equal(allSkipped.status, 'FAIL')
  assert.match(allSkipped.reason, /all 12 collected test\(s\) were skipped/)
  assert.equal(allSkipped.skipped, 12)

  // Some skipped alongside real passes is still a PASS, with the skip count recorded.
  const partly = evaluateSuite(suite, ['src/a.test.ts'], baseOpts({ runFn: () => ({ exitCode: 0, output: '      Tests  10 passed | 2 skipped (12)\n', timedOut: false, spawnError: null }) }))
  assert.equal(partly.status, 'PASS')
  assert.equal(partly.skipped, 2)
})

test('unknownOnlyRows: an --only id that names no suite in either repo is a FAIL row; known ids add nothing (MEDIUM fix: a typo used to give an empty, green snapshot)', () => {
  const manifest = { kernel: [{ id: 'kernel-a' }], vertical: [{ id: 'vertical-b' }] }
  assert.deepEqual(unknownOnlyRows(undefined, manifest), [])
  assert.deepEqual(unknownOnlyRows(['kernel-a', 'vertical-b'], manifest), [])
  const rows = unknownOnlyRows(['kernel-a', 'kernal-a'], manifest)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'FAIL')
  assert.equal(rows[0].id, 'only:kernal-a')
  assert.match(rows[0].reason, /not a suite id/)
})

test('snapshotBaseName composes date + both short SHAs', () => {
  assert.equal(snapshotBaseName('2026-09-25', 'abc1234', 'def5678'), '2026-09-25-abc1234-def5678')
})

test('renderMarkdown includes both repos\' sha/branch, the overall exit and one row per suite', () => {
  const snapshot = {
    date: '2026-09-25',
    kernel: { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', branch: 'unit/TASK-012-ci-local' },
    vertical: { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', branch: 'main' },
    os: 'win32',
    startedAt: '2026-09-25T01:00:00.000Z',
    finishedAt: '2026-09-25T01:00:05.000Z',
    overallExit: 1,
    suites: [
      { repo: 'kernel', category: 'unit', id: 'k1', command: 'pnpm vitest run', collected: 5, passed: 5, failed: 0, status: 'PASS', exitCode: 0, reason: undefined },
      { repo: 'kernel', category: 'shell', id: 'k2', collected: 0, passed: 0, failed: 0, status: 'FAIL', reason: 'no stack' },
    ],
  }
  const md = renderMarkdown(snapshot)
  assert.match(md, /unit\/TASK-012-ci-local/)
  assert.match(md, /aaaaaaa/)
  assert.match(md, /bbbbbbb/)
  assert.match(md, /overall exit: 1/)
  assert.match(md, /\| kernel \| unit \| k1 \| `pnpm vitest run` \| 5 \| 5 \| 0 \| 0 \| PASS \| 0 \|/)
  assert.match(md, /no stack/)
  // No `only` field set on this snapshot (a full reading) — the .md must
  // never claim PARTIAL for one.
  assert.doesNotMatch(md, /PARTIAL/)
})

test('renderMarkdown renders an "only: ... (PARTIAL)" line when the snapshot was a --only subset run (MEDIUM fix: a subset reading looked identical to a full one in the .md, with only the JSON\'s `only` field telling them apart)', () => {
  const snapshot = {
    date: '2026-09-25',
    kernel: { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', branch: 'main' },
    vertical: { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', branch: 'main' },
    os: 'win32',
    startedAt: '2026-09-25T01:00:00.000Z',
    finishedAt: '2026-09-25T01:00:05.000Z',
    overallExit: 0,
    only: ['kernel-unit', 'vertical-unit'],
    suites: [{ repo: 'kernel', category: 'unit', id: 'kernel-unit', command: 'x', collected: 1, passed: 1, failed: 0, status: 'PASS', exitCode: 0 }],
  }
  const md = renderMarkdown(snapshot)
  assert.match(md, /only: kernel-unit, vertical-unit \(PARTIAL/)
})
