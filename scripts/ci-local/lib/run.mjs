// Suite execution: spawn a suite's command in its cwd, capture combined
// output, and never hang the caller — every invocation carries a timeout, so
// a wedged suite becomes a recorded FAIL instead of a stuck snapshot/guard
// run. This is the one file in the package that touches child_process for
// running an arbitrary suite command; run() takes an injectable `spawnFn` so
// callers can unit-test the FAIL paths (timeout, missing tool) without
// actually spawning anything slow.

import { spawnSync, execFileSync } from 'node:child_process'

export const DEFAULT_TIMEOUT_MS = 120_000

// A suite command that itself invokes `node --test` (kind 'node-test' or
// 'guard') must never inherit these — Node's own test runner sets them on
// every child-process-isolated test file (NODE_TEST_CONTEXT=child-v8,
// NODE_TEST_WORKER_ID=<n>), and a NESTED `node --test` that inherits them
// silently changes behaviour: it stops printing its TAP/spec summary to
// stdout at all (it believes it is itself one of the parent's coordinated
// test workers). That is invisible unless you diff env vars — the nested
// run still exits 0, it just produces no "# tests" line, so
// parse-output.mjs's parseNodeTest reads it as "0 collected" and the whole
// suite row goes FAIL for a reason that has nothing to do with the suite
// itself. This bites for real, not just in this package's own dev-loop:
// suites.json's kernel-scripts-node-test suite runs `node --test
// scripts/ci-local/**/*.test.mjs`, which includes snapshot.test.mjs, whose
// tests spawn suite commands via this very function — so a real snapshot
// run inherits NODE_TEST_CONTEXT one level up unless it is stripped here.
const NODE_TEST_ENV_KEYS = ['NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']

function cleanEnv() {
  const env = { ...process.env }
  for (const key of NODE_TEST_ENV_KEYS) delete env[key]
  return env
}

/**
 * Best-effort kill of `pid`'s whole process tree/group, not just `pid`
 * itself. HIGH fix: spawnSync's own `timeout` option only guarantees the
 * IMMEDIATE spawned process is signaled. For a STRING command (run with
 * shell:true), that immediate process is the shell (`cmd.exe` on Windows,
 * `/bin/sh` on POSIX) — a long-running grandchild it forked (vitest,
 * Playwright) is never touched by that signal and keeps running as an
 * orphan after `run()` returns. Measured directly: a kernel gremion-ui
 * vitest run that exceeded the old 120s default left its node process
 * (observed PID, started at the timeout) still running minutes later.
 *
 *  - Windows: `taskkill /T /F /PID <pid>` walks the process's own child
 *    tree by parent PID and force-kills all of it.
 *  - POSIX: `run()` spawns with `detached: true`, which makes the child the
 *    leader of its OWN process group (pgid === its pid). Signaling the
 *    NEGATIVE pid delivers to the whole group in one call.
 *
 * Never throws: the target may have already exited (a real race, not the
 * bug this exists for), which both `taskkill` and `kill(-pid)` report as an
 * error — that failure is expected and silently swallowed.
 */
export function killProcessTree(pid, { platform = process.platform, killFn = process.kill, execFileFn = execFileSync } = {}) {
  if (pid === undefined || pid === null) return
  try {
    if (platform === 'win32') {
      execFileFn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' })
    } else {
      killFn(-pid, 'SIGKILL')
    }
  } catch {
    /* best effort — the tree may already be gone */
  }
}

/**
 * Run `command` in `cwd`. Two forms, and the difference is a security
 * boundary:
 *
 *  - an ARRAY `[file, ...args]` is spawned directly, with NO shell. Every
 *    command that carries a runtime value (a --base ref, a repo path, a
 *    report path) must use this form: nothing in `args` is ever parsed by a
 *    shell, so a git ref named `$(touch x)` or a path holding backticks
 *    stays inert data (CRITICAL fix: guards.mjs used to interpolate --base
 *    and paths into a shell string run with shell:true).
 *  - a STRING is run through the shell. Only for suites.json commands,
 *    which are committed, reviewed text with no runtime value spliced in
 *    (they need the shell for `pnpm` shims and `&&`).
 *
 * @returns {{ exitCode: number, output: string, timedOut: boolean, spawnError: Error|null }}
 *   exitCode is 1 on a timeout or a spawn error (missing tool, bad cwd) —
 *   never 0 — so a caller that only checks exitCode still fails closed.
 *   `timedOut` and `spawnError` are mutually exclusive: a timeout is always
 *   reported as `timedOut: true, spawnError: null`, even though Node's own
 *   spawnSync also sets `result.error` (ETIMEDOUT) in that case — a caller
 *   that checked `spawnError` first used to misreport a timeout as "could
 *   not run" instead of "timed out" (HIGH fix, see snapshot-core.mjs).
 */
export function run(command, cwd, { timeoutMs = DEFAULT_TIMEOUT_MS, spawnFn = spawnSync, killTreeFn = killProcessTree } = {}) {
  const isWindows = process.platform === 'win32'
  const options = {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    env: cleanEnv(),
    // POSIX only: makes the spawned shell/process the leader of its own
    // process group, so killProcessTree can signal the whole group by its
    // negative pid. Windows has no equivalent spawn option — taskkill /T
    // walks the tree by parent PID instead.
    detached: !isWindows,
  }
  const result = Array.isArray(command)
    ? spawnFn(command[0], command.slice(1), { ...options, shell: false })
    : spawnFn(command, { ...options, shell: true })

  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const output = stdout + (stderr ? `\n${stderr}` : '')

  // Checked FIRST, before result.error: spawnSync's own timeout sets BOTH
  // result.error (ETIMEDOUT) and, on POSIX, result.signal — a real "could
  // not run" spawn error (ENOENT, bad cwd) never sets either.
  const timedOut = result.signal === 'SIGTERM' || /ETIMEDOUT/.test(String(result.error ?? ''))
  if (timedOut) {
    killTreeFn(result.pid)
    return {
      exitCode: 1,
      output: output || String(result.error?.message ?? result.error ?? 'suite timed out'),
      timedOut: true,
      spawnError: null,
    }
  }

  if (result.error) {
    // ENOENT (missing tool), a bad cwd, or another spawn-time failure.
    return {
      exitCode: 1,
      output: output || String(result.error.message ?? result.error),
      timedOut: false,
      spawnError: result.error,
    }
  }

  if (result.signal) {
    // Killed by a non-timeout signal — always a FAIL, never a bare "it ran
    // to some exit code".
    return { exitCode: 1, output, timedOut: false, spawnError: null }
  }

  return { exitCode: result.status ?? 1, output, timedOut: false, spawnError: null }
}
