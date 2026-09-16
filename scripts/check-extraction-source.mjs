#!/usr/bin/env node
// Frozen extraction-source guard — spec B 2.4, unit B00-extraction-source-freeze.
//
// Every assertion here is a POST-CONDITION on committed content: the doc's own
// bytes, the module.json files on disk, and scripts/assemble.mjs's own source.
// Never an exit code, never "the command ran".
//
// That rule binds this file's OWN arguments too. Round 1 shipped a version in
// which the agreement arm ran only when a modules root happened to be truthy
// and the CLI read the value from `argv[at + 1]` unchecked, so `--modules-root`
// with its value dropped, a flag-name typo, an empty Make variable or no
// arguments at all each printed "OK ... 0 module.json agree" and exited 0 — the
// success line asserting a check that never ran. Arguments are now parsed
// strictly, a modules root that is not a directory is a problem even under
// --allow-zero, and a run that inspects nothing must ask for --allow-zero and
// is reported as doc-only rather than as agreement.
//
// The contract's helpers live in scripts/lib/extraction-source.mjs (one
// implementation, imported by D2's validator too) and are re-exported here so
// scripts/assemble.mjs has one import to make — the wiring the guard checks for.
//
// Run:  node scripts/check-extraction-source.mjs [--modules-root <dir>] [--allow-zero] [--print]
//       without --modules-root, --allow-zero is required: nothing is inspected.
// Test: node --test scripts/check-extraction-source.test.mjs

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

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

export const ASSEMBLER_PATH = 'scripts/assemble.mjs'

/** A usable modules root is a string naming a real directory — anything else inspects nothing. */
function isModulesDir(modulesRoot) {
  if (typeof modulesRoot !== 'string' || modulesRoot === '') return false
  if (!existsSync(modulesRoot)) return false
  return statSync(modulesRoot).isDirectory()
}

/**
 * Every <modulesRoot>/<id>/module.json, sorted by id. Malformed JSON is reported
 * as a problem rather than thrown: the guard must name the offending file.
 * Only "extractionSource" is read here — the module.json SCHEMA is
 * D2-module-json-and-dist-schema's, and this guard owns exactly one key.
 * A root that is absent or is not a directory yields no entries and no throw;
 * checkVacuity is what refuses it, so a path typo cannot read as "empty".
 */
export function collectModuleJson(modulesRoot) {
  if (!isModulesDir(modulesRoot)) return []
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

/**
 * A run over zero module.json passes vacuously; only the zero-module assemble
 * may ask for that, and it must ask with --allow-zero. `modulesRoot` is passed
 * so the three ways of inspecting nothing stay distinguishable:
 *   - a root that is not a directory (typo, unexpanded variable, a file) — a
 *     problem ALWAYS, because --allow-zero means "no modules yet", never
 *     "wherever you pointed me does not exist";
 *   - a real but empty root — the zero-module assemble, allowed by --allow-zero;
 *   - no root at all — doc + wiring only, also allowed by --allow-zero.
 */
export function checkVacuity(entries, { allowZero = false, modulesRoot = null } = {}) {
  const asked = modulesRoot !== null && modulesRoot !== undefined
  if (asked && !isModulesDir(modulesRoot))
    return [
      `--modules-root ${JSON.stringify(String(modulesRoot))} is not a directory — no module.json could be read and the agreement check would pass vacuously`,
    ]
  if (entries.length > 0 || allowZero) return []
  return asked
    ? [
        `no module.json found under --modules-root ${modulesRoot} — the agreement check would pass vacuously (pass --allow-zero for the zero-module assemble)`,
      ]
    : [
        'no --modules-root given — the agreement check would pass vacuously over zero module.json (pass --allow-zero to check the doc and the assembler wiring only)',
      ]
}

const GUARD_IMPORT_RE = /(?:from\s*|import\s*\(\s*)['"]\.\/check-extraction-source\.mjs['"]/
const GUARD_CALL_RE =
  /\b(?:runChecks|checkExtractionSourceAgreement|checkVacuity|collectModuleJson)\s*\(/

/** Comments are not wiring: a commented-out import must not satisfy the contract. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, '$1')
}

/**
 * scripts/assemble.mjs does not exist until B34-assembler-zero-modules ships it.
 * The moment it does, it must call this guard: an assembler that never runs the
 * agreement check is exactly the silent failure the freeze exists to prevent,
 * and a promise in a spec is not a wiring. An import with no call site is the
 * same silence one step later, so the guard requires both — a static or dynamic
 * import of './check-extraction-source.mjs' (the path the contract names) AND a
 * call to one of the functions it exists to run.
 */
export function checkAssemblerWiring(root) {
  const abs = join(root, ASSEMBLER_PATH)
  if (!existsSync(abs)) return []
  const src = stripComments(readFileSync(abs, 'utf8'))
  if (!GUARD_IMPORT_RE.test(src))
    return [
      `${ASSEMBLER_PATH}: exists but does not import ./check-extraction-source.mjs — the frozen-source agreement check would never run at assemble time`,
    ]
  if (!GUARD_CALL_RE.test(src))
    return [
      `${ASSEMBLER_PATH}: imports ./check-extraction-source.mjs but never calls it — an import with no call site runs no agreement check at assemble time`,
    ]
  return []
}

export function runChecks(root, { modulesRoot = null, allowZero = false } = {}) {
  const frozen = readFrozenExtractionSource(root)
  const entries = collectModuleJson(modulesRoot)
  return {
    frozen,
    entries,
    modulesRoot: modulesRoot ?? null,
    problems: [
      ...checkVacuity(entries, { allowZero, modulesRoot }),
      ...checkExtractionSourceAgreement(entries, frozen),
      ...checkAssemblerWiring(root),
    ],
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

const USAGE =
  'usage: node scripts/check-extraction-source.mjs [--modules-root <dir>] [--allow-zero] [--print]'

function fail(problems) {
  console.error(`[extraction-source] ${problems.length} problem(s):`)
  for (const p of problems) console.error(`  x ${p}`)
  process.exit(1)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const ROOT = KERNEL_ROOT
  let values = {}
  try {
    // strict: an unknown flag, a stray positional, or a --modules-root whose
    // value was dropped is a refusal — never a silently ignored token. A typo
    // in a future Makefile or assembler invocation must not read as green.
    const parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        'modules-root': { type: 'string' },
        'allow-zero': { type: 'boolean' },
        print: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    })
    values = parsed.values
  } catch (err) {
    fail([`bad arguments — ${err.message}`, USAGE])
  }
  const modulesRoot = values['modules-root'] ?? null
  const allowZero = values['allow-zero'] === true
  if (values.print === true) {
    process.stdout.write(`${readFrozenExtractionSource(ROOT)}\n`)
  } else {
    const { frozen, entries, problems } = runChecks(ROOT, { modulesRoot, allowZero })
    if (problems.length > 0) fail(problems)
    // The success line says what was actually inspected. "N module.json agree"
    // over zero manifests was the round-1 defect; a line nobody can misread as
    // coverage is the fix, not a comment saying it is fine.
    const summary =
      modulesRoot === null
        ? 'doc + assembler wiring only, no module.json inspected'
        : entries.length === 0
          ? `no module.json under ${modulesRoot} — zero-module assemble accepted via --allow-zero`
          : `${entries.length} module.json under ${modulesRoot} agree`
    console.log(`[extraction-source] OK — frozen at ${frozen}; ${summary}`)
  }
}
