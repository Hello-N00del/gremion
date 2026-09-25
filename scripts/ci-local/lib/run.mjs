// Suite execution: spawn a suite's command in its cwd, capture combined
// output, and never hang the caller — every invocation carries a timeout, so
// a wedged suite becomes a recorded FAIL instead of a stuck snapshot/guard
// run. This is the one file in the package that touches child_process for
// running an arbitrary suite command; run() takes an injectable `spawnFn` so
// callers can unit-test the FAIL paths (timeout, missing tool) without
// actually spawning anything slow.

import { spawnSync } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 120_000

/**
 * Run `command` (a shell string — suites.json commands are plain shell, e.g.
 * "pnpm run test:unit" or "node --test x.test.mjs && node x.mjs") in `cwd`.
 *
 * @returns {{ exitCode: number, output: string, timedOut: boolean, spawnError: Error|null }}
 *   exitCode is 1 on a timeout or a spawn error (missing tool, bad cwd) —
 *   never 0 — so a caller that only checks exitCode still fails closed.
 */
export function run(command, cwd, { timeoutMs = DEFAULT_TIMEOUT_MS, spawnFn = spawnSync } = {}) {
  const result = spawnFn(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })

  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const output = stdout + (stderr ? `\n${stderr}` : '')

  if (result.error) {
    // ENOENT (missing tool), a bad cwd, or (per Node docs) the timeout itself
    // surfacing as an error on some platforms.
    const timedOut = result.signal === 'SIGTERM' || /ETIMEDOUT/.test(String(result.error))
    return {
      exitCode: 1,
      output: output || String(result.error.message ?? result.error),
      timedOut,
      spawnError: result.error,
    }
  }

  if (result.signal) {
    // Killed by a signal (spawnSync sets this on timeout, and it may leave
    // status null) — always a FAIL, never a bare "it ran to some exit code".
    return { exitCode: 1, output, timedOut: result.signal === 'SIGTERM', spawnError: null }
  }

  return { exitCode: result.status ?? 1, output, timedOut: false, spawnError: null }
}
