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
import { countDeclaredNodeTests, parseBatsTap, parseNodeTapSummary, parseVitestJsonFile } from '../lib/parsers.mjs'
import { run, toolAvailable } from '../lib/proc.mjs'

const REPO_ROOT = new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')

function vitestSubcheck({ cwd, testScript = 'test:unit' }) {
  const outFile = path.join(mkdtempSync(path.join(tmpdir(), 'verify-vitest-')), 'result.json')
  const res = run('pnpm', ['exec', 'vitest', 'run', '--reporter=json', `--outputFile=${outFile}`], {
    cwd,
  })
  const parsed = parseVitestJsonFile(outFile)
  rmSync(path.dirname(outFile), { recursive: true, force: true })
  if (!parsed) {
    return { unparseable: true, detail: `${cwd}: vitest produced no parseable JSON report (exit ${res.code})\n${tail(res.stdout + res.stderr)}` }
  }
  return { unparseable: false, ...parsed }
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

function batsSubcheck({ cwd, patterns }) {
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
    return { unparseable: true, detail: `bats produced no parseable TAP plan\n${tail(res.stdout + res.stderr)}` }
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
  return {
    toolMissing: null,
    unparseable: false,
    collected: sum(parts, 'collected'),
    passed: sum(parts, 'passed'),
    failed: sum(parts, 'failed'),
    skipped: sum(parts, 'skipped'),
    detail: '',
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
