// The pure heart of snapshot.mjs: given a suite's manifest entry, its
// discovered-file universe and a (possibly injected) command runner, decide
// its verdict; given every suite's verdicts, decide the file-set that is
// missing (a) manifest suite files, (b) unclaimed test files, and (c) the
// snapshot's own row/exit shape. snapshot.mjs (the CLI) does nothing but
// wire real fs/git/run to these functions, so every rule below is provable
// against inline fixtures with no process spawned and no disk touched.

import { filterMatching } from './discover.mjs'
import { parseCounts, parseNodeTest, missingToolReason } from './parse-output.mjs'
import { DEFAULT_TIMEOUT_MS } from './run.mjs'

/**
 * Evaluate one suite.
 *
 * @param suite            one suites.json entry
 * @param discoveredFiles  every test file (the 5 shapes) found under this repo
 * @param opts.stackEnvFile   path to a --stack-env file, or undefined — for
 *                            messages only; NEVER used to decide whether a
 *                            requiresStack suite runs (see stackEnvExists)
 * @param opts.stackEnvExists boolean: true only when the caller (snapshot.mjs)
 *                            confirmed --stack-env's file actually exists on
 *                            disk. LOW fix: a `--stack-env <file>` flag used
 *                            to be treated as "stack present" whenever the
 *                            flag was given at all, even for a nonexistent
 *                            file — `--stack-env does-not-exist.env` let a
 *                            requiresStack suite actually RUN (against no
 *                            real stack), producing a confusing "no Tests
 *                            summary line" FAIL instead of the honest,
 *                            cheap "no stack" FAIL the brief calls for.
 *                            Checking file existence is the CALLER's job
 *                            (this module stays pure — no fs access, see the
 *                            file header), so callers must resolve this
 *                            boolean themselves before invoking evaluateSuite.
 * @param opts.runFn          (command, cwd) => {exitCode, output, timedOut, spawnError}
 */
export function evaluateSuite(suite, discoveredFiles, opts) {
  const matchedFiles = claimedFiles(suite, discoveredFiles)
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

  // TASK-012-FU2: a suite whose files are claimed but which has no runner in
  // this tree (e.g. an overlay source tree not yet wired into an app). Always
  // a FAIL with the manifest's own reason; never skipped, never run.
  if (suite.unrunnable) {
    return {
      ...base,
      collected: 0,
      passed: 0,
      failed: 0,
      status: 'FAIL',
      exitCode: null,
      reason: `could not run: ${suite.unrunnable}`,
    }
  }

  // Q4 default: integration/e2e suites never bring up a stack themselves.
  // Without a --stack-env file that actually EXISTS, they FAIL with "no
  // stack" and are never skipped (LOW fix: presence of the flag used to be
  // enough, regardless of whether the named file existed).
  if (suite.requiresStack && !opts.stackEnvExists) {
    return {
      ...base,
      collected: 0,
      passed: 0,
      failed: 0,
      status: 'FAIL',
      exitCode: null,
      reason: opts.stackEnvFile
        ? `--stack-env file '${opts.stackEnvFile}' does not exist — pass a real file to run this suite`
        : 'no stack — pass --stack-env <file> to run this suite',
    }
  }

  const cwd = suite.cwd ? opts.joinRepo(suite.cwd) : opts.joinRepo('.')
  // HIGH fix: every suite used to inherit run.mjs's DEFAULT_TIMEOUT_MS
  // (120s) with no way to raise it, so a genuinely passing, merely SLOW
  // suite (measured: a kernel vitest unit run taking 220s) was recorded as a
  // false FAIL — "could not run: ... ETIMEDOUT" — on every reading.
  // suite.timeoutMs (suites.json) lets the manifest give the largest suites
  // real headroom; suites that omit it keep the same 120s default.
  const timeoutMs = suite.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const { exitCode, output, timedOut, spawnError } = opts.runFn(suite.command, cwd, { timeoutMs })
  const counts = parseCounts(suite.kind, output, exitCode)

  let status = 'PASS'
  let reason
  // HIGH fix: checked BEFORE spawnError. run.mjs now reports a timeout as
  // `timedOut: true, spawnError: null` (mutually exclusive), but this order
  // is kept defensively so a caller-supplied runFn that still sets both
  // (e.g. an older or third-party implementation) is never misattributed as
  // a generic "could not run" — the honest, more specific reason wins.
  if (timedOut) {
    status = 'FAIL'
    reason = `suite timed out after ${Math.round(timeoutMs / 1000)}s`
  } else if (spawnError) {
    status = 'FAIL'
    // TASK-012-FU (LOW): name the tool on a spawn-time ENOENT.
    const tool = spawnError.code === 'ENOENT' && spawnError.path ? `missing tool: ${spawnError.path} (${spawnError.message})` : undefined
    reason = `could not run: ${tool ?? spawnError.message ?? spawnError}`
  } else if (counts.collected === 0) {
    status = 'FAIL'
    // TASK-012-FU (LOW): a shell's own "not found" beats the parser's
    // "no summary" — the row then says WHY nothing was collected.
    reason = missingToolReason(output, exitCode) ?? counts.reason ?? '0 tests collected'
  } else if ((counts.skipped ?? 0) > 0 && counts.passed === 0 && counts.failed === 0) {
    // MEDIUM fix: "Tests  12 skipped (12)" used to be collected 12 = PASS.
    // A suite that ran nothing is not a pass (fail-closed verify, no skip).
    status = 'FAIL'
    reason = `all ${counts.skipped} collected test(s) were skipped — nothing actually ran`
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
  //
  // Deliberately one-directional: FAIL only when node collected FEWER tests
  // than the naive `^test\(/gm` count found (real under-registration — the
  // vacuity case this check exists for). `countDeclared`'s regex is only a
  // LOWER BOUND: lint-extraction-source's own comment already warns it is
  // fragile the moment a file's tests "no longer start at column 0", and
  // kernel-scripts-node-test (suites.json) composes MANY files under one
  // command, most of which this package does not own and cannot hold to
  // that column-0 discipline. A file with nested/looped/dynamically
  // registered tests (indented, so missed by the regex) makes node collect
  // MORE than the naive count — that is normal, not a stopped-registering
  // regression, and treating `!==` as failing in that direction would make
  // this suite permanently, meaninglessly RED on the real kernel tree (see
  // TASK-012 gate evidence: scripts/port-back/check-do-not-overwrite.test.mjs
  // alone declares 0 at column 0 while genuinely registering dozens, nested
  // under its own describe blocks).
  if ((suite.kind === 'node-test' || suite.kind === 'guard') && opts.countDeclared) {
    const tap = parseNodeTest(output)
    if (tap.collected > 0) {
      const declared = opts.countDeclared(matchedFiles)
      if (declared !== undefined && tap.collected < declared) {
        status = 'FAIL'
        reason = `declared ${declared} test(s) in [${matchedFiles.join(', ')}] but node collected only ${tap.collected} — tests may have stopped registering`
      }
    }
  }

  return {
    ...base,
    collected: counts.collected,
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped ?? 0,
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
  const claimed = new Set(suites.flatMap((s) => claimedFiles(s, discoveredFiles)))
  return discoveredFiles.filter((f) => !claimed.has(f))
}

/**
 * The files one suite owns: those its testGlobs reach minus those its
 * excludeGlobs name (files its command deliberately does not run, e.g. a
 * vitest `exclude`). A suite's glob alone would also claim an excluded file
 * for a runner that never executes it.
 */
export function claimedFiles(suite, discoveredFiles) {
  const matched = filterMatching(suite.testGlobs ?? [], discoveredFiles)
  const excluded = suite.excludeGlobs?.length ? new Set(filterMatching(suite.excludeGlobs, matched)) : null
  return excluded ? matched.filter((f) => !excluded.has(f)) : matched
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

/** 0 if every row PASSed, 1 if any row FAILed — and 1 for an empty row list: a snapshot that recorded nothing is never green. */
export function overallExit(rows) {
  if (rows.length === 0) return 1
  return rows.some((r) => r.status === 'FAIL') ? 1 : 0
}

/**
 * FAIL rows for `--only` ids that name no suite in either repo. A mistyped
 * id used to produce a snapshot with zero suite rows and exit 0.
 */
export function unknownOnlyRows(onlyIds, manifest) {
  if (!onlyIds) return []
  const known = new Set(Object.values(manifest).flatMap((suites) => (Array.isArray(suites) ? suites.map((s) => s.id) : [])))
  return onlyIds
    .filter((id) => !known.has(id))
    .map((id) => ({
      id: `only:${id}`,
      repo: null,
      category: 'only',
      command: null,
      cwd: null,
      matchedFiles: [],
      collected: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      status: 'FAIL',
      exitCode: null,
      reason: `--only names '${id}', which is not a suite id in suites.json`,
    }))
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
  lines.push(`- vertical: \`${snapshot.vertical.branch}\` @ \`${snapshot.vertical.sha}\``)
  lines.push(`- os: ${snapshot.os}`)
  lines.push(`- started: ${snapshot.startedAt}`)
  lines.push(`- finished: ${snapshot.finishedAt}`)
  lines.push(`- overall exit: ${snapshot.overallExit}`)
  // MEDIUM fix: a --only subset reading used to render identically to a
  // full reading (only the JSON's `only` field told them apart), and wrote
  // the SAME <date>-<ksha7>-<ssha7> filename, so a passing subset could
  // silently overwrite a full F1/re-init/first-offer reading of the same
  // tips. This line makes a partial reading visually unmistakable in the
  // .md a human actually reads; snapshot.mjs's filename suffix (see
  // snapshotBaseName's caller) is what stops the overwrite itself.
  if (Array.isArray(snapshot.only) && snapshot.only.length > 0) {
    lines.push(`- only: ${snapshot.only.join(', ')} (PARTIAL — not a full reading; do not file as an F1/re-init/first-offer snapshot)`)
  }
  lines.push('')
  lines.push('| repo | category | suite | command | collected | passed | failed | skipped | status | exit | reason |')
  lines.push('|---|---|---|---|---:|---:|---:|---:|---|---:|---|')
  const cell = (v) => String(v ?? '').replace(/\|/g, '\\|')
  for (const r of snapshot.suites) {
    lines.push(
      `| ${r.repo} | ${r.category} | ${r.id} | ${r.command ? `\`${cell(r.command)}\`` : ''} | ${r.collected} | ${r.passed} | ${r.failed} | ${r.skipped ?? 0} | ${r.status} | ${r.exitCode ?? ''} | ${cell(r.reason)} |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}
