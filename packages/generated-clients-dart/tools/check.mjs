#!/usr/bin/env node
// packages/generated-clients-dart/tools/check.mjs
//
// `pnpm --filter @gremion/generated-clients-dart codegen:check` (runs
// images:pull first). TRD-405 for Dart, standalone until the verify suite
// (TASK-045) can register it. A thin shim: it resolves the pinned tools
// (failing closed without them) and hands the real pipeline to runCheck()
// (src/check-cli.ts), which does and is tested for everything else. See the
// README "What codegen:check fails on".
import { runCheck } from '../src/check-cli.ts'
import { realGenerate } from '../src/pipeline.ts'
import { REPO_ROOT } from '../src/repo-root.ts'
import { resolveDart, resolveGenerator } from '../src/tools.ts'

/** @param {string} m */
const log = (m) => console.log(`[dart-codegen-check] ${m}`)
let verdict
try {
  const tools = { generator: resolveGenerator({ log }), dart: resolveDart({ log }) }
  verdict = runCheck(REPO_ROOT, realGenerate(tools, log, 'enforce'))
} catch (e) {
  console.error(`[dart-codegen-check] FAILED — ${/** @type {Error} */ (e).message}`)
  process.exit(1)
}
if (!verdict.ok) {
  console.error(`[dart-codegen-check] FAILED — ${verdict.summary}; ${verdict.problems.length} problem(s):`)
  for (const p of verdict.problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(`[dart-codegen-check] OK — ${verdict.summary}; no hand-written client of a specified surface found.`)
