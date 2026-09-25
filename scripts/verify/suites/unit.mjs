// TASK-045: unit suite (brief S5). Five sub-checks, each counted a different
// way because each tool lies about "nothing ran" differently:
//   - gremion-ui / gremion-public / @gremion/ports: vitest JSON reporter.
//   - scripts/**/*.test.mjs: node --test TAP summary, cross-checked against
//     the declared `test(` count (see lib/parsers.mjs's countDeclaredNodeTests
//     doc comment for why the raw TAP summary alone is not enough).
//   - test/*.bats + test/host/*.bats: bats' own TAP output.
import { globSync } from 'node:fs'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { countDeclaredNodeTests, parseBatsTap, parseNodeTapSummary, parseVitestJsonFile, summarizeVitestFailures } from '../lib/parsers.mjs'
import { run, toolAvailable } from '../lib/proc.mjs'

const REPO_ROOT = new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')

function vitestSubcheck({ cwd, testScript = 'test:unit' }) {
  const outFile = path.join(mkdtempSync(path.join(tmpdir(), 'verify-vitest-')), 'result.json')
  const res = run('pnpm', ['exec', 'vitest', 'run', '--reporter=json', `--outputFile=${outFile}`], {
    cwd,
  })
  const parsed = parseVitestJsonFile(outFile)
  const failureLines = parsed && parsed.failed > 0 ? summarizeVitestFailures(outFile) : []
  rmSync(path.dirname(outFile), { recursive: true, force: true })
  if (!parsed) {
    return { unparseable: true, detail: `${cwd}: vitest produced no parseable JSON report (exit ${res.code})\n${tail(res.stdout + res.stderr)}` }
  }
  const detail = failureLines.length > 0 ? `${cwd}:\n  ${failureLines.join('\n  ')}` : ''
  return { unparseable: false, ...parsed, detail }
}

// Runs node --test PER FILE, one process per file, exactly like the
// Makefile's lint-extraction-source / lint-toolchain targets do -- so the
// same declared-`test(`-count-vs-TAP-plan check applies file by file. Running
// them together (tried first) flattens every file's tests into one shared
// TAP stream where a file with 0 declared tests contributes a single
// synthetic "file itself" entry indistinguishable, in the aggregate, from a
// real skipped test -- per-file is what makes that entry unambiguous: THIS
// file declared 0 and collected 1, a mismatch that can never happen by
// chance.
function nodeTestSubcheck({ cwd, files }) {
  if (files.length === 0) {
    return { unparseable: false, collected: 0, passed: 0, failed: 0, skipped: 0, detail: 'no scripts/**/*.test.mjs files found' }
  }
  let collected = 0
  let passed = 0
  let failed = 0
  let skipped = 0
  for (const file of files) {
    const declared = countDeclaredNodeTests([readFileSync(path.join(cwd, file), 'utf8')])
    const res = run('node', ['--test', '--test-reporter=tap', file], { cwd })
    const summary = parseNodeTapSummary(res.stdout + res.stderr)
    if (!summary) {
      return { unparseable: true, detail: `${file}: node --test produced no parseable TAP summary\n${tail(res.stdout + res.stderr)}` }
    }
    if (declared === 0) {
      return { unparseable: true, detail: `${file}: declares 0 top-level test() but node --test collected ${summary.collected} -- the file has no real tests (it becomes its own synthetic passing entry)` }
    }
    if (summary.collected !== declared) {
      return { unparseable: true, detail: `${file}: declares ${declared} test(s) but node --test collected ${summary.collected} -- tests stopped registering, or moved off column 0` }
    }
    collected += summary.collected
    passed += summary.passed
    failed += summary.failed
    skipped += summary.skipped
  }
  return { unparseable: false, collected, passed, failed, skipped }
}

// On win32 the npm bats shim rejects the C:/ path the recipe's own shell
// reports as its cwd (Makefile test-host-docker comment), and native bats
// runs ~200x slower even when it does start. Route through the same
// container image `make test-host-docker` builds (plus python3, for
// test/configure-keycloak.bats's `python3 -m json.tool` -- see
// bats-runner/Dockerfile), against a REAL CLONE: a linked worktree's `.git`
// is a file whose gitdir line is a host-absolute path the container cannot
// resolve.
function batsSubcheckWindows({ cwd, patterns }) {
  if (!toolAvailable('docker')) {
    return { toolMissing: 'docker' }
  }
  const runnerDir = path.join(cwd, 'test', 'host', 'runner')
  const batsRunnerDockerfile = path.join(cwd, 'scripts', 'verify', 'bats-runner')
  const baseBuild = run('docker', ['build', '-q', '-t', 'gremion-bats:local', runnerDir])
  if (baseBuild.code !== 0) {
    return { unparseable: true, detail: `docker build gremion-bats:local failed:\n${tail(baseBuild.stdout + baseBuild.stderr)}` }
  }
  const pyBuild = run('docker', ['build', '-q', '-t', 'gremion-bats-py:local', batsRunnerDockerfile])
  if (pyBuild.code !== 0) {
    return { unparseable: true, detail: `docker build gremion-bats-py:local failed:\n${tail(pyBuild.stdout + pyBuild.stderr)}` }
  }

  const cloneDir = mkdtempSync(path.join(tmpdir(), 'verify-bats-clone-'))
  try {
    const clone = run('git', ['clone', '--no-hardlinks', cwd, cloneDir])
    if (clone.code !== 0) {
      return { unparseable: true, detail: `git clone into scratch failed:\n${tail(clone.stdout + clone.stderr)}` }
    }
    const files = patterns.flatMap((p) => globSync(p, { cwd: cloneDir })).sort()
    if (files.length === 0) {
      return { unparseable: false, collected: 0, passed: 0, failed: 0, skipped: 0, detail: `no files matched ${patterns.join(', ')}` }
    }
    const res = run(
      'docker',
      ['run', '--rm', '-v', `${cloneDir}:/wt`, '-w', '/wt', 'gremion-bats-py:local', '--tap', ...files],
      { env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
    )
    const parsed = parseBatsTap(res.stdout + res.stderr)
    if (!parsed) {
      return { unparseable: true, detail: `bats (container) produced no parseable or complete TAP plan (docker exit ${res.code})\n${tail(res.stdout + res.stderr)}` }
    }
    // A TAP stream can look complete (plan matches ok+not-ok count) while the
    // container itself still exited non-zero for a reason the TAP never
    // recorded as a `not ok` -- e.g. the runner crashed AFTER printing its
    // last result line. `parsed.failed > 0` already explains a non-zero exit;
    // a non-zero exit with no reported failure at all is not explained by
    // anything this parser saw, so it is treated as untrustworthy, not clean.
    if (res.code !== 0 && parsed.failed === 0) {
      return { unparseable: true, detail: `bats (container) exited ${res.code} but its TAP output reported no failures -- untrusted\n${tail(res.stdout + res.stderr)}` }
    }
    return { unparseable: false, ...parsed }
  } finally {
    rmSync(cloneDir, { recursive: true, force: true })
  }
}

function batsSubcheck({ cwd, patterns }) {
  if (process.platform === 'win32') {
    return batsSubcheckWindows({ cwd, patterns })
  }
  if (!toolAvailable('bats')) {
    return { toolMissing: 'bats' }
  }
  const files = patterns.flatMap((p) => globSync(p, { cwd })).sort()
  if (files.length === 0) {
    return { unparseable: false, collected: 0, passed: 0, failed: 0, skipped: 0, detail: `no files matched ${patterns.join(', ')}` }
  }
  const res = run('bats', ['--tap', ...files], { cwd })
  const parsed = parseBatsTap(res.stdout + res.stderr)
  if (!parsed) {
    return { unparseable: true, detail: `bats produced no parseable or complete TAP plan (exit ${res.code})\n${tail(res.stdout + res.stderr)}` }
  }
  if (res.code !== 0 && parsed.failed === 0) {
    return { unparseable: true, detail: `bats exited ${res.code} but its TAP output reported no failures -- untrusted\n${tail(res.stdout + res.stderr)}` }
  }
  return { unparseable: false, ...parsed }
}

export function runUnitSuite({ root = REPO_ROOT } = {}) {
  const uiDir = path.join(root, 'gremion-ui')
  const publicDir = path.join(root, 'gremion-public')
  const portsDir = path.join(root, 'packages', 'ports')

  const ui = vitestSubcheck({ cwd: uiDir, testScript: 'test:unit' })
  if (ui.unparseable) return unparseableResult(ui.detail)

  const pub = vitestSubcheck({ cwd: publicDir, testScript: 'test' })
  if (pub.unparseable) return unparseableResult(pub.detail)

  const ports = vitestSubcheck({ cwd: portsDir, testScript: 'test' })
  if (ports.unparseable) return unparseableResult(ports.detail)

  // __fixtures__/** is deliberately excluded: those files exist to be
  // seeded-bad (zero declared tests, all-skip) for verify's OWN guard tests
  // and must never be swept into the real suite they are fixtures for.
  const scriptTestFiles = globSync('scripts/**/*.test.mjs', { cwd: root })
    .filter((f) => !f.split(/[\\/]/).includes('__fixtures__'))
    .sort()
  const nodeSuite = nodeTestSubcheck({ cwd: root, files: scriptTestFiles })
  if (nodeSuite.unparseable) return unparseableResult(nodeSuite.detail)

  const bats = batsSubcheck({ cwd: root, patterns: ['test/*.bats', 'test/host/*.bats'] })
  if (bats.toolMissing) return { toolMissing: bats.toolMissing, unparseable: false, collected: 0, passed: 0, failed: 0, skipped: 0 }
  if (bats.unparseable) return unparseableResult(bats.detail)

  const parts = [ui, pub, ports, nodeSuite, bats]
  // Found needed by actually running this suite with real vitest failures
  // present: hard-coding detail: '' here discarded every sub-check's own
  // failure summary the moment the suite as a whole was merely `failed`, not
  // `unparseable` -- the aggregate correctly summed the failed count but gave
  // no lead at all on which tests. Each sub-check's own `detail` (set only
  // when it has something to say -- see vitestSubcheck) is preserved here.
  const detail = parts
    .map((p) => p.detail)
    .filter((d) => d)
    .join('\n')
  return {
    toolMissing: null,
    unparseable: false,
    collected: sum(parts, 'collected'),
    passed: sum(parts, 'passed'),
    failed: sum(parts, 'failed'),
    skipped: sum(parts, 'skipped'),
    detail,
  }
}

function unparseableResult(detail) {
  return { toolMissing: null, unparseable: true, collected: 0, passed: 0, failed: 0, skipped: 0, detail }
}

function sum(parts, key) {
  return parts.reduce((acc, p) => acc + (p[key] ?? 0), 0)
}

function tail(text, n = 400) {
  return text.length > n ? text.slice(-n) : text
}
