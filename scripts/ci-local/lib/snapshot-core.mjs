// The pure heart of snapshot.mjs: given a suite's manifest entry, its
// discovered-file universe and a (possibly injected) command runner, decide
// its verdict; given every suite's verdicts, decide the file-set that is
// missing (a) manifest suite files, (b) unclaimed test files, and (c) the
// snapshot's own row/exit shape. snapshot.mjs (the CLI) does nothing but
// wire real fs/git/run to these functions, so every rule below is provable
// against inline fixtures with no process spawned and no disk touched.

import { filterMatching } from './discover.mjs'
import { parseCounts, parseNodeTest } from './parse-output.mjs'

/**
 * Evaluate one suite.
 *
 * @param suite            one suites.json entry
 * @param discoveredFiles  every test file (the 5 shapes) found under this repo
 * @param opts.stackEnvFile  path to a --stack-env file, or undefined
 * @param opts.runFn          (command, cwd) => {exitCode, output, timedOut, spawnError}
 */
export function evaluateSuite(suite, discoveredFiles, opts) {
  const matchedFiles = filterMatching(suite.testGlobs ?? [], discoveredFiles)
  const base = {
    id: suite.id,
    repo: suite.repo,
    category: suite.category,
    command: suite.command,
    cwd: suite.cwd,
    matchedFiles,
  }

  // (a) a manifest suite whose files are absent.
  if ((suite.testGlobs ?? []).length > 0 && matchedFiles.length === 0) {
    return {
      ...base,
      collected: 0,
      passed: 0,
      failed: 0,
      status: 'FAIL',
      exitCode: null,
      reason: `manifest suite files absent — none of [${suite.testGlobs.join(', ')}] matched a file on disk`,
    }
  }

  // Q4 default: integration/e2e suites never bring up a stack themselves.
  // Without --stack-env they FAIL with "no stack" and are never skipped.
  if (suite.requiresStack && !opts.stackEnvFile) {
    return {
      ...base,
      collected: 0,
      passed: 0,
      failed: 0,
      status: 'FAIL',
      exitCode: null,
      reason: 'no stack — pass --stack-env <file> to run this suite',
    }
  }

  const cwd = suite.cwd ? opts.joinRepo(suite.cwd) : opts.joinRepo('.')
  const { exitCode, output, timedOut, spawnError } = opts.runFn(suite.command, cwd)
  const counts = parseCounts(suite.kind, output, exitCode)

  let status = 'PASS'
  let reason
  if (spawnError) {
    status = 'FAIL'
    reason = `could not run: ${spawnError.message ?? spawnError}`
  } else if (timedOut) {
    status = 'FAIL'
    reason = 'suite timed out'
  } else if (counts.collected === 0) {
    status = 'FAIL'
    reason = counts.reason ?? '0 tests collected'
  } else if (counts.failed > 0 || exitCode !== 0) {
    status = 'FAIL'
    reason = counts.reason
  }

  // `node --test <file>` exits 0 and reports "1..1" for a file whose tests
  // stopped registering (a throw before the first test() call, or a describe
  // block that never runs) — same idiom as the Makefile's own
  // lint-extraction-source declared-vs-collected check. Only meaningful for
  // node-test-shaped suites, and only when the caller wired a counter (the
  // CLI does; snapshot-core's own unit tests exercise both with and without
  // one).
  if ((suite.kind === 'node-test' || suite.kind === 'guard') && opts.countDeclared) {
    const tap = parseNodeTest(output)
    if (tap.collected > 0) {
      const declared = opts.countDeclared(matchedFiles)
      if (declared !== undefined && declared !== tap.collected) {
        status = 'FAIL'
        reason = `declared ${declared} test(s) in [${matchedFiles.join(', ')}] but node collected ${tap.collected} — tests may have stopped registering`
      }
    }
  }

  return {
    ...base,
    collected: counts.collected,
    passed: counts.passed,
    failed: counts.failed,
    status,
    exitCode,
    reason,
  }
}

/**
 * (b) a test file on disk that no suite in this repo claims. Independent of
 * whether a suite actually RAN — a stack-skipped suite still structurally
 * owns its files, so only files no manifest entry's globs reach at all are
 * reported here.
 */
export function findUnclaimed(discoveredFiles, suites) {
  const allGlobs = suites.flatMap((s) => s.testGlobs ?? [])
  const claimed = new Set(filterMatching(allGlobs, discoveredFiles))
  return discoveredFiles.filter((f) => !claimed.has(f))
}

/** Build the unclaimed files into result rows shaped like evaluateSuite's output. */
export function unclaimedRows(repo, unclaimedFiles) {
  return unclaimedFiles.map((file) => ({
    id: `unclaimed:${file}`,
    repo,
    category: 'unclaimed',
    command: null,
    cwd: null,
    matchedFiles: [file],
    collected: 0,
    passed: 0,
    failed: 1,
    status: 'FAIL',
    exitCode: null,
    reason: `test file '${file}' is not claimed by any suite in suites.json`,
  }))
}

/** 0 if every row PASSed, 1 if any row FAILed. Never trusts an absent row list as green. */
export function overallExit(rows) {
  return rows.some((r) => r.status === 'FAIL') ? 1 : 0
}

/** `<YYYY-MM-DD>-<ksha7>-<ssha7>` — the snapshot's base filename, no extension. */
export function snapshotBaseName(date, kernelShortSha, sturaosShortSha) {
  return `${date}-${kernelShortSha}-${sturaosShortSha}`
}

/** Render the snapshot JSON body as the companion markdown table. */
export function renderMarkdown(snapshot) {
  const lines = []
  lines.push(`# ci-local snapshot — ${snapshot.date}`)
  lines.push('')
  lines.push(`- kernel: \`${snapshot.kernel.branch}\` @ \`${snapshot.kernel.sha}\``)
  lines.push(`- sturaos: \`${snapshot.sturaos.branch}\` @ \`${snapshot.sturaos.sha}\``)
  lines.push(`- os: ${snapshot.os}`)
  lines.push(`- started: ${snapshot.startedAt}`)
  lines.push(`- finished: ${snapshot.finishedAt}`)
  lines.push(`- overall exit: ${snapshot.overallExit}`)
  lines.push('')
  lines.push('| repo | category | suite | collected | passed | failed | status | reason |')
  lines.push('|---|---|---|---:|---:|---:|---|---|')
  for (const r of snapshot.suites) {
    lines.push(
      `| ${r.repo} | ${r.category} | ${r.id} | ${r.collected} | ${r.passed} | ${r.failed} | ${r.status} | ${(r.reason ?? '').replace(/\|/g, '\\|')} |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}
