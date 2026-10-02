// TASK-053 (L2-05, TRD-444; brief Q5/Q6): the `boundary-lint` verify suite.
//
// Runs gremion-ui's boundary lint over the WHOLE tree with a scanned-file
// floor, and judges the count it prints -- never the exit code alone:
//
//   pnpm exec tsx scripts/boundary-lint.ts --all --min-files 300   (cwd gremion-ui)
//
// Before TASK-053 nothing invoked `--all` (pre-commit runs `--staged`), and
// `--all` printed `OK (0 file(s) checked)` with exit 0 over an empty tree.
//
// SYNCHRONOUS on purpose: verify.mjs's runAll() calls `runner()` without
// `await` (an async runner reads as collected 0). The one spawn goes through
// lib/proc.mjs's spawnSync `run` (precedent suites/typecheck.mjs).
//
// `tsx` is a gremion-ui devDependency only: never a bare `tsx`, never a root
// dependency. Missing pnpm -> toolMissing 'pnpm'; missing
// gremion-ui/node_modules/.bin/tsx[.cmd] -> toolMissing 'tsx (run pnpm install)'.
//
// Result mapping:
//   OK (N file(s) checked)       collected = passed = N; N below MIN_FILES fails
//                                here too (defence in depth: the CLI's own
//                                refusal could regress)
//   scanned N file(s) (refusal)  collected = N, failed = 1 (N = 0 -> collected 0)
//   N problem(s)                 collected = failed = N
//   anything else                unparseable, with the output's tail
import { existsSync } from 'node:fs'
import path from 'node:path'
import { run, spawnMissing, tail, toolAvailable } from '../lib/proc.mjs'

export const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
/** The floor verify passes (B32 Task 9; boundary-real-tree.test.ts floors at > 300). */
export const MIN_FILES = 300
export const BOUNDARY_LINT_ARGS = ['exec', 'tsx', 'scripts/boundary-lint.ts', '--all', '--min-files', String(MIN_FILES)]

const ZERO = { collected: 0, passed: 0, failed: 0, skipped: 0 }

/** gremion-ui's own tsx shim (posix `tsx`, Windows `tsx.cmd`). */
export function tsxInstalled(uiDir) {
  const bin = path.join(uiDir, 'node_modules', '.bin')
  return existsSync(path.join(bin, 'tsx')) || existsSync(path.join(bin, 'tsx.cmd'))
}

/** Judges one `boundary-lint.ts --all` run (exported for the tests). */
export function judgeBoundaryLint(res, { minFiles = MIN_FILES } = {}) {
  if (spawnMissing(res)) return { toolMissing: 'pnpm', unparseable: false, ...ZERO, detail: 'pnpm could not be started' }
  const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
  const ok = /\[boundary-lint\] OK \((\d+) file\(s\) checked, mode --all\)/.exec(out)
  if (ok && res.code === 0) {
    const n = Number(ok[1])
    if (n < minFiles) {
      return { toolMissing: null, unparseable: false, collected: n, passed: 0, failed: 1, skipped: 0, detail: `boundary-lint reported OK over ${n} file(s), below the floor of ${minFiles} -- a near-empty scan is not a pass` }
    }
    return { toolMissing: null, unparseable: false, collected: n, passed: n, failed: 0, skipped: 0, detail: `scanned ${n} file(s) (floor ${minFiles})` }
  }
  const refused = /\[boundary-lint\] scanned (\d+) file\(s\)/.exec(out)
  if (refused && res.code !== 0) {
    const n = Number(refused[1])
    return { toolMissing: null, unparseable: false, collected: n, passed: 0, failed: 1, skipped: 0, detail: tail(out, 1500) }
  }
  const problems = /\[boundary-lint\] (\d+) problem\(s\)/.exec(out)
  if (problems && res.code !== 0 && Number(problems[1]) > 0) {
    const n = Number(problems[1])
    return { toolMissing: null, unparseable: false, collected: n, passed: 0, failed: n, skipped: 0, detail: tail(out, 3000) }
  }
  return { toolMissing: null, unparseable: true, ...ZERO, detail: `boundary-lint printed no parseable count (exit ${res.code})\n${tail(out)}` }
}

/**
 * @param {object} [opts] every side effect injectable (suite.test.mjs).
 * @returns {{toolMissing: string|null, unparseable: boolean, collected: number, passed: number, failed: number, skipped: number, detail: string}}
 */
export function runBoundaryLintSuite({
  root = REPO_ROOT,
  runFn = run,
  toolAvailableFn = toolAvailable,
  tsxInstalledFn = tsxInstalled,
  minFiles = MIN_FILES,
} = {}) {
  const uiDir = path.join(root, 'gremion-ui')
  if (!toolAvailableFn('pnpm')) {
    return { toolMissing: 'pnpm', unparseable: false, ...ZERO, detail: 'pnpm is not on PATH -- boundary-lint cannot run' }
  }
  if (!tsxInstalledFn(uiDir)) {
    return { toolMissing: 'tsx (run pnpm install)', unparseable: false, ...ZERO, detail: 'gremion-ui/node_modules/.bin/tsx is absent' }
  }
  const args = [...BOUNDARY_LINT_ARGS.slice(0, -1), String(minFiles)]
  return judgeBoundaryLint(runFn('pnpm', args, { cwd: uiDir }), { minFiles })
}
