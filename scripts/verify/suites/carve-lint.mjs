// TASK-045: carve-lint suite. `lint-port-back`, `lint-extraction-source` and
// `lint-unshipped-migrations` are named by the brief (S5); the rest come from
// two other places verify must be a SUPERSET of (brief S4):
//   - integration-gate.sh's lint-* target list (lint-sh/yaml/json/compose/
//     hygiene/cve-floors/packages), the release-1 gate this suite replaces.
//   - the Makefile's own `lint-toolchain` comment (TASK-017 wrote the target
//     but explicitly left it OUT of `make lint`, naming TASK-045/verify as
//     the thing that wires it in -- ownership here forbids editing the `lint:`
//     aggregate line itself, so it is wired in HERE instead).
// lint-postgres-major is the fifth do-not-overwrite-shaped guard in the repo
// and belongs in the same superset for the same reason.
//
// Each target already runs its own `node --test` suite before its guard
// script (the Makefile recipes do this themselves -- see e.g.
// lint-extraction-source's declared-vs-collected check) or is a well-known
// external linter; carve-lint's job is only to run every target and refuse to
// call any of them zero times.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { run, toolAvailable } from '../lib/proc.mjs'

const REPO_ROOT = new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')

// integration-gate.sh's own stub() (vault
// session-2026-09-15-spec-b-d/plan/tooling/integration-gate.sh:35): lint-compose
// and lint-hygiene both read .env / legal/legal.env (docker compose config
// resolution, the g2 hygiene overlay check) and FAIL in a bare worktree that
// has never run `make setup` -- not because anything is wrong, but because
// nothing was ever configured. Ported verbatim: copy .env.example -> .env and
// create an empty legal/legal.env only if each is absent, then assert (the
// same way integration-gate.sh does) that the result is untracked -- both
// paths are gitignored, so a non-empty `git status` here means something
// unexpected is tracked at that path and stubbing must refuse rather than
// silently overwrite it.
function stubEnvFilesIfAbsent(cwd) {
  const envPath = path.join(cwd, '.env')
  const legalDir = path.join(cwd, 'legal')
  const legalEnvPath = path.join(legalDir, 'legal.env')
  if (!existsSync(envPath)) {
    copyFileSync(path.join(cwd, '.env.example'), envPath)
  }
  if (!existsSync(legalEnvPath)) {
    mkdirSync(legalDir, { recursive: true })
    writeFileSync(legalEnvPath, '')
  }
  const status = run('git', ['status', '--porcelain', '--untracked-files=all', '--', '.env', 'legal/legal.env'], { cwd })
  if (status.stdout.trim().length > 0) {
    throw new Error(
      `refusing to stub .env/legal/legal.env: git status is non-empty for a path that should be gitignored -- ` +
        `something unexpected is tracked there:\n${status.stdout}`,
    )
  }
}

// name -> {make: target} | {tool, args} for the two non-`make` external
// checks integration-gate.sh ran directly.
const TARGETS = [
  { name: 'lint-port-back', kind: 'make', target: 'lint-port-back' },
  { name: 'lint-extraction-source', kind: 'make', target: 'lint-extraction-source' },
  { name: 'lint-unshipped-migrations', kind: 'make', target: 'lint-unshipped-migrations' },
  { name: 'lint-postgres-major', kind: 'make', target: 'lint-postgres-major' },
  { name: 'lint-toolchain', kind: 'make', target: 'lint-toolchain' },
  { name: 'lint-sh', kind: 'make', target: 'lint-sh', tool: 'shellcheck' },
  { name: 'lint-yaml', kind: 'make', target: 'lint-yaml', tool: 'yamllint' },
  { name: 'lint-json', kind: 'make', target: 'lint-json', tool: 'python3' },
  { name: 'lint-compose', kind: 'make', target: 'lint-compose', tool: 'docker' },
  { name: 'lint-hygiene', kind: 'make', target: 'lint-hygiene' },
  { name: 'lint-cve-floors', kind: 'make', target: 'lint-cve-floors' },
  { name: 'lint-packages', kind: 'make', target: 'lint-packages' },
]

/**
 * @param {{only?: string[]}} [opts] restrict to a subset of target names
 *   (used by tests; verify.mjs's own `--only carve-lint` runs them all).
 */
export function runCarveLintSuite({ only, cwd = REPO_ROOT } = {}) {
  const targets = only ? TARGETS.filter((t) => only.includes(t.name)) : TARGETS
  if (targets.length === 0) {
    return { toolMissing: null, unparseable: true, collected: 0, passed: 0, failed: 0, skipped: 0, detail: 'no carve-lint targets selected' }
  }
  for (const t of targets) {
    if (t.tool && !toolAvailable(t.tool)) {
      return { toolMissing: t.tool, unparseable: false, collected: 0, passed: 0, failed: 0, skipped: 0, detail: `${t.name} needs ${t.tool}` }
    }
  }
  if (targets.some((t) => t.name === 'lint-compose' || t.name === 'lint-hygiene')) {
    try {
      stubEnvFilesIfAbsent(cwd)
    } catch (err) {
      return { toolMissing: null, unparseable: true, collected: 0, passed: 0, failed: 0, skipped: 0, detail: err.message }
    }
  }
  let passed = 0
  let failed = 0
  const failures = []
  for (const t of targets) {
    const res = run('make', [t.target], { cwd })
    if (res.code === 0) {
      passed += 1
    } else {
      failed += 1
      failures.push(`${t.name} (exit ${res.code}): ${tail(res.stdout + res.stderr, 400)}`)
    }
  }
  return {
    toolMissing: null,
    unparseable: false,
    collected: targets.length,
    passed,
    failed,
    skipped: 0,
    detail: failures.join('\n'),
  }
}

function tail(text, n) {
  return text.length > n ? text.slice(-n) : text
}
