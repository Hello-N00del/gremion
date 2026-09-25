#!/usr/bin/env node
// packages/generated-clients-dart/tools/generate.mjs
//
// `pnpm --filter @gremion/generated-clients-dart generate` (runs images:pull
// first). Regenerates every openapi+active surface in contracts/registry.json
// into packages/generated-clients-dart/<name>/ through the same pipeline the
// check uses (src/pipeline.ts). Not part of the checked surface: this is the
// write side, tools/check.mjs is the read side.
import { realGenerate } from '../src/pipeline.ts'
import { REPO_ROOT } from '../src/repo-root.ts'
import { resolveDart, resolveGenerator } from '../src/tools.ts'
import { syncDartPackages } from '../src/writer.ts'

const log = (m) => console.log(`[dart-codegen] ${m}`)
try {
  const tools = { generator: resolveGenerator({ log }), dart: resolveDart({ log }) }
  const written = syncDartPackages(REPO_ROOT, realGenerate(tools, log), log)
  log(`done: ${written.length} package(s)${written.length ? `: ${written.join(', ')}` : ''}`)
} catch (e) {
  console.error(`[dart-codegen] FAILED — ${e.message}`)
  process.exit(1)
}
