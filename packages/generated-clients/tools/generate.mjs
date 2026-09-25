#!/usr/bin/env node
// packages/generated-clients/tools/generate.mjs
//
// Writes every generated TypeScript client (GENERATED_CLIENTS in
// ../src/codegen.ts). `pnpm --filter @gremion/generated-clients generate`.
// This script is NOT shipped (tools/ is deliberately out of package.json's
// `files`) — it is the write side of the pair; `src/codegen-drift.ts` is the
// read/verify side that ships and that `contracts:check` runs.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GENERATED_CLIENTS, generateClientSource } from '../src/codegen.ts'
import { REPO_ROOT } from '../src/repo-root.ts'

const here = dirname(fileURLToPath(import.meta.url))
void here // repo root comes from src/repo-root.ts, kept here only for clarity

for (const spec of GENERATED_CLIENTS) {
  const outPath = join(REPO_ROOT, spec.outputFile)
  const source = generateClientSource(REPO_ROOT, spec)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, source, 'utf8') // LF — generateClientSource() never emits \r\n
  console.log(`generated ${spec.outputFile} from ${spec.specFile}`)
}
