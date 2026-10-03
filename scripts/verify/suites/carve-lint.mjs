// TASK-045: carve-lint suite. `lint-port-back`, `lint-extraction-source` and
// `lint-unshipped-migrations` are named by the brief (S5); the rest come from
// the places verify must be a SUPERSET of (brief S4):
//   - every `lint-*` target the Makefile defines, including every
//     prerequisite of the `lint` aggregate (integration-gate.sh's
//     lint-sh/yaml/json/compose/hygiene/cve-floors/packages, and TASK-005's
//     lint-compliance, which landed on main after this list was first
//     written and was silently not run until carve-lint.test.mjs caught it);
//   - `lint-toolchain` (TASK-017 wrote it and explicitly left it OUT of
//     `make lint`, naming verify as the thing that wires it in; ownership
//     forbids editing the `lint:` line, so it is wired in here);
//   - the release-1 gate's `pnpm install --frozen-lockfile`, as a
//     lockfile-only, offline check that never touches node_modules
//     (round-1 MEDIUM: verify had dropped it).
// scripts/verify/carve-lint.test.mjs fails if a Makefile lint target is
// missing from CARVE_LINT_TARGETS.
//
// Each make target already runs its own `node --test` suite before its guard
// script and asserts its own collected count (see e.g. lint-extraction-
// source), or is a well-known external linter; carve-lint's job is to run
// every one and refuse to call any of them zero times. Each target is its
// own combineParts part, judged by exit code.
import { stubEnvFilesIfAbsent } from '../lib/envstub.mjs'
import { combineParts } from '../lib/guard.mjs'
import { run, spawnMissing, tail, toolAvailable } from '../lib/proc.mjs'
import { REPO_ROOT } from '../lib/vitest.mjs'

// kind 'make': `make <target>`; kind 'cmd': `<cmd> <args>`. `tool` is an
// external binary the target needs, checked up front so its absence is
// "missing tool: X", never a make failure that looks like a lint finding.
export const CARVE_LINT_TARGETS = [
  { name: 'lint-port-back', kind: 'make', target: 'lint-port-back' },
  { name: 'lint-extraction-source', kind: 'make', target: 'lint-extraction-source' },
  { name: 'lint-unshipped-migrations', kind: 'make', target: 'lint-unshipped-migrations' },
  { name: 'lint-postgres-major', kind: 'make', target: 'lint-postgres-major' },
  { name: 'lint-toolchain', kind: 'make', target: 'lint-toolchain' },
  { name: 'lint-compliance', kind: 'make', target: 'lint-compliance' },
  { name: 'lint-sh', kind: 'make', target: 'lint-sh', tool: 'shellcheck' },
  { name: 'lint-yaml', kind: 'make', target: 'lint-yaml', tool: 'yamllint' },
  { name: 'lint-json', kind: 'make', target: 'lint-json', tool: 'python3' },
  { name: 'lint-compose', kind: 'make', target: 'lint-compose', tool: 'docker' },
  // TASK-022 merged lint-edge-render after this list was written (the meta-test
  // caught it on main, R25). It renders the production composition: docker.
  { name: 'lint-edge-render', kind: 'make', target: 'lint-edge-render', tool: 'docker' },
  // TASK-040: the pooled-stack guard renders state, both app colours, ops and
  // mail with every profile (TRD-177/038/045): docker.
  { name: 'lint-pooled-stack', kind: 'make', target: 'lint-pooled-stack', tool: 'docker' },
  // TASK-041 (L3-08): the edge host-model guard (no HostRegexp leg, no
  // wildcard env key, no apex host injection, no leftmost-label resolver).
  { name: 'lint-edge-host', kind: 'make', target: 'lint-edge-host' },
  // TASK-020 (R25): no direct tenant-DB connection outside @gremion/tenant-store.
  { name: 'lint-tenant-db-access', kind: 'make', target: 'lint-tenant-db-access' },
  // TASK-200 (R27): the in-tree module guards (no modules/** import or path
  // leaving its own module; no module migration basename colliding with the
  // kernel chain or another chain). Merged into the `lint` aggregate by the
  // unit; the meta-test caught the missing rows at verify r5.
  { name: 'lint-module-scan', kind: 'make', target: 'lint-module-scan' },
  { name: 'lint-module-migration-names', kind: 'make', target: 'lint-module-migration-names' },
  // TASK-029 (G5b): the migration register (chains, pad/order, claim, lock,
  // StuRa slugs). scripts/migrations/wiring.test.mjs fails if this row goes.
  { name: 'lint-migration-register', kind: 'make', target: 'lint-migration-register' },
  // R25-oxlint: the standalone oxlint ratchet (scripts/check-lint-js.mjs).
  { name: 'lint-js', kind: 'make', target: 'lint-js' },
  { name: 'lint-hygiene', kind: 'make', target: 'lint-hygiene' },
  { name: 'lint-cve-floors', kind: 'make', target: 'lint-cve-floors' },
  { name: 'lint-packages', kind: 'make', target: 'lint-packages' },
  // TASK-048 (TRD-350/066/354): every deployed image pinned by digest, no
  // object storage. Brief G4 fixes tool 'docker' (the release toolchain).
  { name: 'lint-image-digests', kind: 'make', target: 'lint-image-digests', tool: 'docker' },
  // TASK-198: the chat module's Synapse (module suites + the compose render of
  // messaging-postgres and matrix): docker. The scratch proof (synapse-proof)
  // is deliberately NOT here.
  { name: 'lint-synapse', kind: 'make', target: 'lint-synapse', tool: 'docker' },
  {
    name: 'lockfile-frozen',
    kind: 'cmd',
    cmd: 'pnpm',
    args: ['install', '--frozen-lockfile', '--lockfile-only', '--offline'],
  },
]

/**
 * @param {{only?: string[], cwd?: string}} [opts] `only` restricts to a
 *   subset of target names (used by tests; `verify --only carve-lint` runs
 *   them all).
 */
export function runCarveLintSuite({ only, cwd = REPO_ROOT } = {}) {
  const targets = only ? CARVE_LINT_TARGETS.filter((t) => only.includes(t.name)) : CARVE_LINT_TARGETS
  if (targets.length === 0) {
    return combineParts([])
  }
  if (targets.some((t) => t.name === 'lint-compose' || t.name === 'lint-hygiene')) {
    try {
      stubEnvFilesIfAbsent(cwd)
    } catch (err) {
      return combineParts([{ label: 'stub .env / legal/legal.env', unparseable: true, detail: err.message }])
    }
  }
  const parts = targets.map((t) => {
    const label = t.name
    if (t.tool && !toolAvailable(t.tool)) return { label, toolMissing: t.tool }
    const [cmd, args] = t.kind === 'make' ? ['make', [t.target]] : [t.cmd, t.args]
    const res = run(cmd, args, { cwd })
    if (spawnMissing(res)) return { label, toolMissing: cmd }
    const ok = res.code === 0
    return { label, collected: 1, passed: ok ? 1 : 0, failed: ok ? 0 : 1, skipped: 0, detail: ok ? '' : `exit ${res.code}: ${tail(res.stdout + res.stderr, 600)}` }
  })
  return combineParts(parts)
}
