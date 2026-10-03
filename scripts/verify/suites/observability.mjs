// TASK-039 (TDD 18): the `observability` verify suite.
//
// Runs every compose/observability/*.test.mjs (the ops project's static
// guards: render shape, host mounts, ports, networks, Grafana access and the
// grafana client, alert conditions and policy, retention, TRD-199) through
// unit.mjs's nodeTestParts, so each file is judged by the same fail-closed
// rules as every other node:test file: a file that declares no test(), a
// collected count that differs from the declared one, or an unparseable TAP
// summary is a FAIL, never a pass. Zero files found is a FAIL too.
//
// The guards render the project with `docker compose config`, so docker
// missing is `toolMissing: 'docker'` (never a skip). The running half is
// test/host/integration/observability-proof.sh (Docker, minutes), not here.
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { combineParts } from '../lib/guard.mjs'
import { toolAvailable } from '../lib/proc.mjs'
import { REPO_ROOT } from '../lib/vitest.mjs'
import { nodeTestParts } from './unit.mjs'

export const OBSERVABILITY_DIR = 'compose/observability'

/** The suite's test files, repo-relative, sorted; [] when the directory is gone. */
export function observabilityTestFiles(root = REPO_ROOT) {
  const dir = path.join(root, OBSERVABILITY_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
    .map((f) => path.join(OBSERVABILITY_DIR, f))
}

export function runObservabilitySuite({ root = REPO_ROOT, toolAvailableFn = toolAvailable, parts = nodeTestParts } = {}) {
  if (!toolAvailableFn('docker')) {
    return { toolMissing: 'docker', unparseable: false, collected: 0, passed: 0, failed: 0, skipped: 0, detail: 'docker is not on PATH -- the ops project cannot be rendered' }
  }
  return combineParts(parts({ cwd: root, files: observabilityTestFiles(root) }))
}
