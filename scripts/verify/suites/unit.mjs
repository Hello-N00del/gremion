// TASK-045: unit suite (brief S5). Five sub-checks, each counted a different
// way because each tool lies about "nothing ran" differently:
//   - gremion-ui / gremion-public / @gremion/ports: vitest JSON reporter plus
//     the exit code (lib/vitest.mjs).
//   - scripts/**/*.test.mjs: node --test TAP summary per file, cross-checked
//     against the declared `test(` count (see lib/parsers.mjs's
//     countDeclaredNodeTests doc comment for why the raw TAP summary alone is
//     not enough).
//   - test/*.bats + test/host/*.bats: bats' own TAP output plus its exit code.
// The parts are combined with lib/guard.mjs#combineParts, so one sub-check
// that collected nothing fails the suite by name instead of hiding inside
// the others' total.
//
// Each part can also be run on its own as `verify --only unit:<part>` (see
// UNIT_PARTS / verify.mjs's registry) -- gremion-ui's vitest alone takes
// about three minutes, so the whole suite does not fit a single 4-minute
// agent tool call. A part run is always a partial record; only a full
// `verify` (every required suite, `unit` whole) satisfies check-record.
import { globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { combineParts } from '../lib/guard.mjs'
import { countDeclaredNodeTests, parseBatsTap, parseNodeTapSummary } from '../lib/parsers.mjs'
import { run, tail, toolAvailable } from '../lib/proc.mjs'
import { REPO_ROOT, runVitestJson } from '../lib/vitest.mjs'

/** One package's own test script, run with the JSON reporter. */
export function vitestSubcheck({ cwd, testScript = 'test:unit', root = REPO_ROOT, label = `${path.basename(cwd)} vitest (${testScript})` }) {
  // Runs the package's OWN script (`pnpm run <testScript>`), not a
  // hand-assembled `vitest run`, so a flag or config a package adds to its
  // script is what verify runs too.
  return runVitestJson({ label, cwd, cmd: 'pnpm', args: ['run', testScript], root })
}

// Runs node --test PER FILE, one process per file, exactly like the
// Makefile's lint-extraction-source / lint-toolchain targets do -- so the
// same declared-`test(`-count-vs-TAP-plan check applies file by file, and a
// file with 0 declared tests is its own empty part (combineParts names it)
// rather than one synthetic "file itself" entry lost in an aggregate.
export function nodeTestParts({ cwd, files }) {
  if (files.length === 0) {
    return [{ label: 'node --test (no *.test.mjs files found)', collected: 0, passed: 0, failed: 0, skipped: 0 }]
  }
  return files.map((file) => {
    const label = `node --test ${file.split(path.sep).join('/')}`
    const declared = countDeclaredNodeTests([readFileSync(path.join(cwd, file), 'utf8')])
    // NODE_TEST_CONTEXT is stripped: when verify itself runs under node --test
    // (its own tests do), an inherited NODE_TEST_CONTEXT=child-v8 makes the
    // child report to that parent in node's internal v8 stream instead of
    // printing TAP, and the summary is unparseable.
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const res = run(process.execPath, ['--test', '--test-reporter=tap', file], { cwd, env })
    const out = res.stdout + res.stderr
    const summary = parseNodeTapSummary(out)
    if (!summary) {
      return { label, unparseable: true, detail: `no parseable TAP summary (exit ${res.code})\n${tail(out)}` }
    }
    if (declared === 0 && summary.failed === 0) {
      return {
        label,
        collected: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        detail: `declares no test() -- node --test counted ${summary.collected}, the file itself as a synthetic passing test`,
      }
    }
    if (summary.failed > 0) {
      return { label, ...summary, detail: tail(out) }
    }
    if (summary.collected !== declared) {
      return {
        label,
        unparseable: true,
        detail: `declares ${declared} test(s) but node --test collected ${summary.collected} -- tests stopped registering, or the file uses t.test()/it() forms this count does not see`,
      }
    }
    if (res.code !== 0) {
      return { label, unparseable: true, detail: `node --test exited ${res.code ?? `on signal ${res.signal}`} with no failed test in its summary -- untrusted\n${tail(out)}` }
    }
    return { label, ...summary }
  })
}

// On win32 the npm bats shim rejects the C:/ path the recipe's own shell
// reports as its cwd (Makefile test-host-docker comment), and native bats
// runs ~200x slower even when it does start. Route through the same
// container image `make test-host-docker` builds (plus python3, for
// test/configure-keycloak.bats's `python3 -m json.tool` -- see
// bats-runner/Dockerfile), against a REAL CLONE: a linked worktree's `.git`
// is a file whose gitdir line is a host-absolute path the container cannot
// resolve.
function batsPartWindows({ label, cwd, patterns }) {
  if (!toolAvailable('docker')) {
    return { label, toolMissing: 'docker' }
  }
  const runnerDir = path.join(cwd, 'test', 'host', 'runner')
  const batsRunnerDockerfile = path.join(cwd, 'scripts', 'verify', 'bats-runner')
  const baseBuild = run('docker', ['build', '-q', '-t', 'gremion-bats:local', runnerDir])
  if (baseBuild.code !== 0) {
    return { label, unparseable: true, detail: `docker build gremion-bats:local failed:\n${tail(baseBuild.stdout + baseBuild.stderr)}` }
  }
  const pyBuild = run('docker', ['build', '-q', '-t', 'gremion-bats-py:local', batsRunnerDockerfile])
  if (pyBuild.code !== 0) {
    return { label, unparseable: true, detail: `docker build gremion-bats-py:local failed:\n${tail(pyBuild.stdout + pyBuild.stderr)}` }
  }

  const cloneDir = mkdtempSync(path.join(tmpdir(), 'verify-bats-clone-'))
  try {
    const clone = run('git', ['clone', '--no-hardlinks', cwd, cloneDir])
    if (clone.code !== 0) {
      return { label, unparseable: true, detail: `git clone into scratch failed:\n${tail(clone.stdout + clone.stderr)}` }
    }
    const files = patterns.flatMap((p) => globSync(p, { cwd: cloneDir })).map((f) => f.split(path.sep).join('/')).sort()
    if (files.length === 0) {
      return { label, collected: 0, passed: 0, failed: 0, skipped: 0, detail: `no files matched ${patterns.join(', ')}` }
    }
    const res = run('docker', ['run', '--rm', '-v', `${cloneDir}:/wt`, '-w', '/wt', 'gremion-bats-py:local', '--tap', ...files], {
      env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    })
    return judgeBats(label, res, 'bats (container)')
  } finally {
    rmSync(cloneDir, { recursive: true, force: true })
  }
}

// A TAP stream can look complete (plan matches ok+not-ok count) while the
// runner itself still exited non-zero for a reason the TAP never recorded
// as a `not ok` -- e.g. it crashed AFTER printing its last result line.
// `failed > 0` already explains a non-zero exit; a non-zero exit with no
// reported failure is not explained by anything the parser saw, so it is
// untrusted, not clean.
function judgeBats(label, res, what) {
  const out = res.stdout + res.stderr
  const parsed = parseBatsTap(out)
  if (!parsed) {
    return { label, unparseable: true, detail: `${what} produced no parseable or complete TAP plan (exit ${res.code})\n${tail(out)}` }
  }
  if (res.code !== 0 && parsed.failed === 0) {
    return { label, unparseable: true, detail: `${what} exited ${res.code ?? `on signal ${res.signal}`} but its TAP output reported no failures -- untrusted\n${tail(out)}` }
  }
  return { label, ...parsed, detail: parsed.failed > 0 ? tail(out, 1500) : '' }
}

function batsPart({ cwd, patterns }) {
  const label = `bats ${patterns.join(' ')}`
  if (process.platform === 'win32') {
    return batsPartWindows({ label, cwd, patterns })
  }
  if (!toolAvailable('bats')) {
    return { label, toolMissing: 'bats' }
  }
  const files = patterns.flatMap((p) => globSync(p, { cwd })).sort()
  if (files.length === 0) {
    return { label, collected: 0, passed: 0, failed: 0, skipped: 0, detail: `no files matched ${patterns.join(', ')}` }
  }
  return judgeBats(label, run('bats', ['--tap', ...files], { cwd }), 'bats')
}

function scriptTestFiles(root) {
  // __fixtures__/** is deliberately excluded: those files exist to be
  // seeded-bad (zero declared tests, all-skip) for verify's OWN guard tests
  // and must never be swept into the real suite they are fixtures for.
  return globSync('scripts/**/*.test.mjs', { cwd: root })
    .filter((f) => !f.split(/[\\/]/).includes('__fixtures__'))
    .sort()
}

/** Part name -> the combineParts parts it produces. Order is run order. */
export const UNIT_PARTS = {
  ui: (root) => [vitestSubcheck({ cwd: path.join(root, 'gremion-ui'), testScript: 'test:unit', root, label: 'gremion-ui vitest (test:unit)' })],
  public: (root) => [vitestSubcheck({ cwd: path.join(root, 'gremion-public'), testScript: 'test', root, label: 'gremion-public vitest (test)' })],
  ports: (root) => [vitestSubcheck({ cwd: path.join(root, 'packages', 'ports'), testScript: 'test', root, label: '@gremion/ports vitest (test)' })],
  node: (root) => nodeTestParts({ cwd: root, files: scriptTestFiles(root) }),
  bats: (root) => [batsPart({ cwd: root, patterns: ['test/*.bats', 'test/host/*.bats'] })],
}

/**
 * @param {{root?: string, only?: string[]}} [opts] `only` restricts the run
 *   to named UNIT_PARTS (used by the `unit:<part>` registry entries); an
 *   unknown part name throws, which runAll reports as a FAIL.
 */
export function runUnitSuite({ root = REPO_ROOT, only } = {}) {
  const names = only ?? Object.keys(UNIT_PARTS)
  for (const n of names) {
    if (!UNIT_PARTS[n]) throw new Error(`unknown unit part: ${n} (known: ${Object.keys(UNIT_PARTS).join(', ')})`)
  }
  return combineParts(names.flatMap((n) => UNIT_PARTS[n](root)))
}
