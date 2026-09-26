// TASK-045: process helpers shared by every suite.
//
// spawnSync, not spawn/exec: every suite call is meant to block verify.mjs
// until it finishes (or the caller's own timeout elapses), and a synchronous
// call cannot leak a child past the parent's own 4-minute tool-call ceiling
// the way a forgotten `spawn` + unresolved promise could.
import { spawnSync } from 'node:child_process'

/**
 * Run a command and capture its output. Never throws: a spawn failure (ENOENT
 * -- the tool itself is missing) comes back as `{code: null, error}`, which
 * callers turn into a `toolMissing` guard result rather than an uncaught
 * exception that would crash the whole verify run over one absent binary.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptions} [opts]
 */
export function run(cmd, args = [], opts = {}) {
  const startedAt = Date.now()
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
    ...opts,
  })
  return {
    code: res.status,
    signal: res.signal,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error ?? null,
    durationMs: Date.now() - startedAt,
  }
}

/**
 * Whether `name` resolves on PATH. Used before every suite that shells out to
 * an external binary (docker, bats, shellcheck, psql, python3) so a missing
 * tool is reported as `missing tool: X`, never as a skip or a false pass.
 */
export function toolAvailable(name) {
  const probe = process.platform === 'win32' ? run('where', [name]) : run('which', [name])
  return probe.code === 0
}

/**
 * True when `run()` could not start the command at all (the binary is not
 * on PATH). Callers report that as `toolMissing`, never as a failed or
 * skipped run.
 */
export function spawnMissing(res) {
  return res.error?.code === 'ENOENT'
}

/** The last `n` characters of a tool's output, for a FAIL line's detail. */
export function tail(text, n = 500) {
  return text.length > n ? text.slice(-n) : text
}
