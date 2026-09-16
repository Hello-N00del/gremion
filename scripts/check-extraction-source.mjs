#!/usr/bin/env node
// Frozen extraction-source guard — spec B 2.4, unit B00-extraction-source-freeze.
//
// Every assertion here is a POST-CONDITION on committed content: the doc's own
// bytes, the module.json files on disk, and scripts/assemble.mjs's own source.
// Never an exit code, never "the command ran".
//
// The contract's helpers live in scripts/lib/extraction-source.mjs (one
// implementation, imported by D2's validator too) and are re-exported here so
// scripts/assemble.mjs has one import to make — the wiring the guard checks for.
//
// Run:  node scripts/check-extraction-source.mjs [--modules-root <dir>] [--allow-zero] [--print]
// Test: node --test scripts/check-extraction-source.test.mjs

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DOC_PATH,
  SHA_RE,
  KERNEL_ROOT,
  parseFrozenExtractionSource,
  readFrozenExtractionSource,
  checkExtractionSourceAgreement,
} from './lib/extraction-source.mjs'

export {
  DOC_PATH,
  SHA_RE,
  KERNEL_ROOT,
  parseFrozenExtractionSource,
  readFrozenExtractionSource,
  checkExtractionSourceAgreement,
}

/**
 * Every <modulesRoot>/<id>/module.json, sorted by id. Malformed JSON is reported
 * as a problem rather than thrown: the guard must name the offending file.
 * Only "extractionSource" is read here — the module.json SCHEMA is
 * D2-module-json-and-dist-schema's, and this guard owns exactly one key.
 */
export function collectModuleJson(modulesRoot) {
  if (!existsSync(modulesRoot)) return []
  const entries = []
  for (const id of readdirSync(modulesRoot).sort()) {
    const dir = join(modulesRoot, id)
    if (!statSync(dir).isDirectory()) continue
    const file = join(dir, 'module.json')
    if (!existsSync(file)) continue
    let parsed = null
    let parseError = null
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      parseError = err.message
    }
    entries.push({
      id,
      path: `${id}/module.json`,
      extractionSource: parsed === null ? undefined : parsed.extractionSource,
      parseError,
    })
  }
  return entries
}

/** A run over zero module.json passes vacuously; only the zero-module assemble may ask for that. */
export function checkVacuity(entries, { allowZero = false } = {}) {
  if (entries.length === 0 && !allowZero)
    return [
      'no module.json found under the given --modules-root — the agreement check would pass vacuously (pass --allow-zero for the zero-module assemble)',
    ]
  return []
}

export function runChecks(root, { modulesRoot = null, allowZero = false } = {}) {
  const frozen = readFrozenExtractionSource(root)
  const entries = modulesRoot ? collectModuleJson(modulesRoot) : []
  return {
    frozen,
    entries,
    problems: [
      ...(modulesRoot ? checkVacuity(entries, { allowZero }) : []),
      ...checkExtractionSourceAgreement(entries, frozen),
    ],
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const ROOT = KERNEL_ROOT
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--modules-root')
  const modulesRoot = at === -1 ? null : argv[at + 1]
  const allowZero = argv.includes('--allow-zero')
  if (argv.includes('--print')) {
    process.stdout.write(`${readFrozenExtractionSource(ROOT)}\n`)
  } else {
    const { frozen, entries, problems } = runChecks(ROOT, { modulesRoot, allowZero })
    if (problems.length > 0) {
      console.error(`[extraction-source] ${problems.length} problem(s):`)
      for (const p of problems) console.error(`  x ${p}`)
      process.exit(1)
    }
    console.log(`[extraction-source] OK — frozen at ${frozen}; ${entries.length} module.json agree`)
  }
}
