#!/usr/bin/env node
// packages/generated-clients/tools/contracts-check.mjs
//
// `pnpm --filter @gremion/generated-clients contracts:check` (brief §5
// decision 2 default, since `verify` — TASK-045 — did not exist at commit
// time). Thin CLI over tools/contracts-check-core.mjs's runContractsCheck():
// registry validity, structural validation + $ref closure on every
// registered spec, the OpenAPI/AsyncAPI compat gate against the base ref,
// codegen drift, and the vacuity guard, in one fail-closed pass.
import { runContractsCheck } from './contracts-check-core.mjs'
import { REPO_ROOT } from '../dist/repo-root.js'

const result = runContractsCheck(REPO_ROOT)

if (!result.ok) {
  console.error(`[contracts-check] FAILED — ${result.problems.length} problem(s):`)
  for (const p of result.problems) console.error(`  - ${p}`)
  process.exit(1)
}

console.log(
  `[contracts-check] OK — ${result.entryCount} registered spec(s), `
  + `${result.compatChecked} compat-checked against ${result.baseRef ?? '(no base ref)'}, codegen clean.`,
)
