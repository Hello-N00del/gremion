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
import { run, toolAvailable } from '../lib/proc.mjs'

const REPO_ROOT = new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')

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
