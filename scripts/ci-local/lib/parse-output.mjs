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
//
// `skipped` is added only when the runner reported skipped tests (> 0), so
// a suite whose every collected test was skipped can be told apart from a
// real pass (snapshot-core FAILs it: fail-closed verify allows no skip).

function withSkipped(counts, skipped) {
  return skipped > 0 ? { ...counts, skipped } : counts
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g

/**
 * node's own test-runner summary lines, in either reporter's form: TAP
 * (`# tests N`, `# pass N`, `# fail N`, ...) or spec (`ℹ tests N`,
 * `ℹ pass N`, ...). TAP is read when present; spec is the fallback.
 *
 * TASK-012-FU finding 4 (MEDIUM): only the TAP form used to be read, and
 * this package forces `--test-reporter=tap` only on the `node --test`
 * commands it spells out itself. A node-test suite that suites.json runs
 * through pnpm (`pnpm run test:carve`) gets Node 26's default spec reporter
 * even with stdout piped, so the snapshot recorded FAIL "no TAP summary"
 * with exit 0 for a suite whose 84 tests all passed. ANSI colour codes
 * (FORCE_COLOR) and CRLF line ends are stripped before matching.
 */
export function parseNodeTest(output) {
  const text = String(output ?? '').replace(ANSI_RE, '').replace(/\r\n?/g, '\n')
  // One reporter per read: when a TAP summary exists, spec lines are never
  // mixed in (and vice versa), so counts always come from ONE summary block.
  const tap = /^# tests \d+$/m.test(text)
  const field = (name) => text.match(tap ? new RegExp(`^# ${name} (\\d+)$`, 'm') : new RegExp(`^\\s*ℹ ${name} (\\d+)\\s*$`, 'm'))
  const tests = field('tests')
  const pass = field('pass')
  const fail = field('fail')
  const skipped = field('skipped')
  const todo = field('todo')
  if (!tests) {
    return { collected: 0, passed: 0, failed: 0, reason: 'no test-runner summary ("# tests N" TAP or "ℹ tests N" spec) found in output' }
  }
  return withSkipped(
    {
      collected: Number(tests[1]),
      passed: pass ? Number(pass[1]) : 0,
      failed: fail ? Number(fail[1]) : 0,
    },
    (skipped ? Number(skipped[1]) : 0) + (todo ? Number(todo[1]) : 0),
  )
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
  return withSkipped({ collected, passed: p, failed: f }, s)
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
  return withSkipped({ collected: p + f + s, passed: p, failed: f }, s)
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
  const skipped = (output.match(/^ok .*#\s*skip\b/gim) || []).length
  const passed = (output.match(/^ok /gm) || []).length - skipped
  return withSkipped({ collected, passed, failed }, skipped)
}

/** flutter test's summary line, e.g. "00:04 +42: All tests passed!" or "+40 -2: Some tests failed." */
export function parseFlutter(output) {
  // flutter prints skipped tests as "~N" between the pass and fail counts.
  const m = output.match(/\+(\d+)(?:\s+~(\d+))?(?:\s+-(\d+))?:/)
  if (!m) {
    return { collected: 0, passed: 0, failed: 0, reason: 'no "+N -M:" summary found in flutter test output' }
  }
  const passed = Number(m[1])
  const skipped = m[2] ? Number(m[2]) : 0
  const failed = m[3] ? Number(m[3]) : 0
  return withSkipped({ collected: passed + skipped + failed, passed, failed }, skipped)
}

/**
 * A guard script with no per-assertion count of its own (its OWN unit test,
 * run first in the same command, is what supplies a real collected count —
 * see the `guard` composite in run.mjs). Standing alone, a guard is one
 * pass/fail arm.
 *
 * LOW fix: a FAIL used to carry no `reason` at all — evaluateSuite's FAIL
 * row showed an empty reason for e.g. kernel-runner-policy-guard, and a
 * reader of the snapshot could not tell why it failed without re-running it
 * by hand. `exitCode !== 0` now names the exit code.
 */
export function parseGuard(output, exitCode) {
  return {
    collected: 1,
    passed: exitCode === 0 ? 1 : 0,
    failed: exitCode === 0 ? 0 : 1,
    reason: exitCode === 0 ? undefined : `guard script exited ${exitCode}`,
  }
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
      // one more pass/fail arm on top of the suite's own count. LOW fix: a
      // nonzero exit here used to leave `reason` undefined — evaluateSuite
      // reports `counts.reason` verbatim, so the FAIL row named neither the
      // exit code nor anything else.
      return {
        collected: tap.collected + 1,
        passed: tap.passed + (exitCode === 0 ? 1 : 0),
        failed: tap.failed + (exitCode === 0 ? 0 : 1),
        reason: exitCode === 0 ? undefined : `guard script exited ${exitCode}`,
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

// TASK-012-FU (LOW): suites.json commands run through a shell, so a missing
// binary is not a spawn ENOENT: the shell prints its own "not found" line
// and exits non-zero, and a row used to carry the parser's "no summary
// found" reason (e.g. flutter, which is not on PATH on every box). These are
// the shells' and pnpm's own wordings; the first match names the tool.
const MISSING_TOOL_RES = [
  /^'([^']+)' is not recognized as an internal or external command/m, // cmd.exe
  /^(?:\S*\/)?(?:ba|da|z|k)?sh:(?:\s*\d+:)?(?:\s*line \d+:)?\s*([^\s:]+):\s*(?:command )?not found\s*$/m, // sh/dash/bash
  /^(?:\S*\/)?zsh:\s*command not found:\s*(\S+)\s*$/m,
  /Command "([^"]+)" not found/, // pnpm exec / pnpm run
]

/**
 * `missing tool: <name>` when a NON-ZERO run's output shows the shell (or
 * pnpm) could not find the command, else undefined. A zero exit never counts:
 * a suite that ran and passed is never re-labelled.
 */
export function missingToolReason(output, exitCode) {
  if (exitCode === 0) return undefined
  const text = String(output ?? '').replace(/\r\n?/g, '\n')
  for (const re of MISSING_TOOL_RES) {
    const m = text.match(re)
    if (m) return `missing tool: ${m[1]}`
  }
  return undefined
}
