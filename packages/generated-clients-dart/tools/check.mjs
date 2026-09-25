#!/usr/bin/env node
// packages/generated-clients-dart/tools/check.mjs
//
// `pnpm --filter @gremion/generated-clients-dart codegen:check` (runs
// images:pull first). TRD-405 for Dart, standalone until the verify suite
// (TASK-045) can register it. Fails closed, naming every problem, on:
//   - a registry surface with no package, a stale spec (.generated-from), a
//     hand-edited / missing / extra file anywhere in a surface package (the
//     whole file set is regenerated and compared byte for byte);
//   - a package dir that is not a registered surface, Dart in src/ or tools/;
//   - a hand-written client: any *.dart outside the surface packages
//     (apps/mobile/** included) containing a path of a registered OpenAPI spec;
//   - pub get / build_runner / dart analyze failing, or any `error -` line;
//   - vacuity: M (openapi+active registry entries) must be >= 1 and N == M;
//   - no generator / Dart SDK at the pinned versions (PATH or Docker).
import { checkDartCodegenDrift, finalizeCheck } from '../src/codegen-drift.ts'
import { scanForHandWrittenClients } from '../src/hand-client-scan.ts'
import { realGenerate } from '../src/pipeline.ts'
import { REPO_ROOT } from '../src/repo-root.ts'
import { resolveDart, resolveGenerator } from '../src/tools.ts'

const log = (m) => console.log(`[dart-codegen-check] ${m}`)
let verdict
try {
  const scan = scanForHandWrittenClients(REPO_ROOT)
  const tools = { generator: resolveGenerator({ log }), dart: resolveDart({ log }) }
  const drift = checkDartCodegenDrift(REPO_ROOT, { generate: realGenerate(tools, log) })
  verdict = finalizeCheck({ ...drift, problems: [...drift.problems, ...scan] }, { requireSurfaces: true })
} catch (e) {
  console.error(`[dart-codegen-check] FAILED — ${e.message}`)
  process.exit(1)
}
if (!verdict.ok) {
  console.error(`[dart-codegen-check] FAILED — ${verdict.summary}; ${verdict.problems.length} problem(s):`)
  for (const p of verdict.problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(`[dart-codegen-check] OK — ${verdict.summary}; no hand-written client of a specified surface found.`)
