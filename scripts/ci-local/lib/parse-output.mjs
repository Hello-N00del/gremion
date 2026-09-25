// Pure parsers: turn a suite's captured stdout+stderr and exit code into a
// { collected, passed, failed, reason? } verdict. No spawning here — run.mjs
// captures the text, this file only reads it — so every parser is provable
// against a fixture string with no process involved.
//
// The shared contract every parser honours: `collected` is the number of
// tests the RUNNER reports it saw. 0 collected is never silently treated as a
// pass — snapshot.mjs's caller enforces that regardless of what a parser
// returns, but each parser also refuses to invent a collected count it did
// not actually read off the output (a parser that cannot find a count returns
// collected: 0 with a `reason`, it never guesses).

/** node's own TAP summary lines: `# tests N`, `# pass N`, `# fail N`. */
export function parseNodeTest(output) {
  const tests = output.match(/^# tests (\d+)$/m)
  const pass = output.match(/^# pass (\d+)$/m)
  const fail = output.match(/^# fail (\d+)$/m)
  if (!tests) {
    return { collected: 0, passed: 0, failed: 0, reason: 'no TAP "# tests" summary line found in output' }
  }
  return {
    collected: Number(tests[1]),
    passed: pass ? Number(pass[1]) : 0,
    failed: fail ? Number(fail[1]) : 0,
  }
}

/**
 * vitest's default reporter, e.g. "      Tests  117 passed (117)" or
 * "      Tests  10 passed | 2 failed (12)".
 */
export function parseVitest(output) {
  const line = output.match(/^\s*Tests\s+(.+)$/m)
  if (!line) {
    return { collected: 0, passed: 0, failed: 0, reason: 'no "Tests" summary line found in vitest output' }
  }
  const body = line[1]
  const passed = body.match(/(\d+)\s+passed/)
  const failed = body.match(/(\d+)\s+failed/)
  const skipped = body.match(/(\d+)\s+skipped/)
  const total = body.match(/\((\d+)\)/)
  const p = passed ? Number(passed[1]) : 0
  const f = failed ? Number(failed[1]) : 0
  const s = skipped ? Number(skipped[1]) : 0
  const collected = total ? Number(total[1]) : p + f + s
  return { collected, passed: p, failed: f }
}

/**
 * Playwright's text reporter summary, e.g. "  20 passed (25s)" or the
 * multi-line "  18 passed" / "  2 failed" shape when there are failures.
 */
export function parsePlaywright(output) {
  const passed = output.match(/(\d+)\s+passed/)
  const failed = output.match(/(\d+)\s+failed/)
  const skipped = output.match(/(\d+)\s+skipped/)
  if (!passed && !failed && !skipped) {
    return { collected: 0, passed: 0, failed: 0, reason: 'no "passed/failed" summary found in playwright output' }
  }
  const p = passed ? Number(passed[1]) : 0
  const f = failed ? Number(failed[1]) : 0
  const s = skipped ? Number(skipped[1]) : 0
  return { collected: p + f + s, passed: p, failed: f }
}

/**
 * bats' TAP output: a `1..N` plan line, then `ok`/`not ok` lines. bats prints
 * the plan line whether or not gathering succeeded — a failed
 * `bats-gather-tests` step (the known Windows-path failure, see README) still
 * emits `1..1` / `not ok 1 bats-gather-tests`, which this correctly reports
 * as 1 collected, 0 passed, 1 failed, rather than 0 collected — the suite DID
 * run, it just found nothing to gather, and that is a real failure to record.
 */
export function parseBats(output) {
  const plan = output.match(/^1\.\.(\d+)$/m)
  if (!plan) {
    return { collected: 0, passed: 0, failed: 0, reason: 'no TAP plan ("1..N") line found in bats output' }
  }
  const collected = Number(plan[1])
  const failed = (output.match(/^not ok /gm) || []).length
  const passed = (output.match(/^ok /gm) || []).length
  return { collected, passed, failed }
}

/** flutter test's summary line, e.g. "00:04 +42: All tests passed!" or "+40 -2: Some tests failed." */
export function parseFlutter(output) {
  const m = output.match(/\+(\d+)(?:\s+-(\d+))?:/)
  if (!m) {
    return { collected: 0, passed: 0, failed: 0, reason: 'no "+N -M:" summary found in flutter test output' }
  }
  const passed = Number(m[1])
  const failed = m[2] ? Number(m[2]) : 0
  return { collected: passed + failed, passed, failed }
}

/**
 * A guard script with no per-assertion count of its own (its OWN unit test,
 * run first in the same command, is what supplies a real collected count —
 * see the `guard` composite in run.mjs). Standing alone, a guard is one
 * pass/fail arm.
 */
export function parseGuard(output, exitCode) {
  return { collected: 1, passed: exitCode === 0 ? 1 : 0, failed: exitCode === 0 ? 0 : 1 }
}

export const PARSERS = {
  'node-test': parseNodeTest,
  vitest: parseVitest,
  playwright: parsePlaywright,
  bats: parseBats,
  flutter: parseFlutter,
  guard: parseGuard,
}

/**
 * Dispatch by suite `kind`. For the composite `guard` kind, prefer a
 * node-test TAP summary if the combined output contains one (the suite's own
 * `*.test.mjs` ran first) and fall back to the bare pass/fail arm otherwise.
 */
export function parseCounts(kind, output, exitCode) {
  if (kind === 'guard') {
    const tap = parseNodeTest(output)
    if (tap.collected > 0) {
      if (tap.failed > 0) {
        // `&&` short-circuited on the suite's own test — the guard script
        // never ran, so nothing is added on its behalf.
        return { collected: tap.collected, passed: tap.passed, failed: tap.failed }
      }
      // The test phase was clean and the guard script ran; its exit code is
      // one more pass/fail arm on top of the suite's own count.
      return {
        collected: tap.collected + 1,
        passed: tap.passed + (exitCode === 0 ? 1 : 0),
        failed: tap.failed + (exitCode === 0 ? 0 : 1),
      }
    }
    return parseGuard(output, exitCode)
  }
  const parser = PARSERS[kind]
  if (!parser) {
    return { collected: 0, passed: 0, failed: 0, reason: `unknown suite kind '${kind}'` }
  }
  return parser(output, exitCode)
}
