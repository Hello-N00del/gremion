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
// Run:  node scripts/check-extraction-source.mjs \
//         [--modules-root <dir>] [--allow-zero] [--verify-remote <repo-or-url>] [--print]
//       without --modules-root, --allow-zero is required: nothing is inspected.
//       --print returns before every check, so it refuses the other flags.
// Test: node --test scripts/check-extraction-source.test.mjs

import { execFileSync } from 'node:child_process'
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
 * One entry per module DIRECTORY under <modulesRoot>, sorted by id — not one
 * per module.json that happened to exist. Round 2 shipped the latter, and a
 * root holding two module directories and one manifest printed
 * "OK ... 1 module.json ... agree": the count read as coverage of a root it did
 * not cover, and a module whose extraction wrote no manifest (or wrote
 * `Module.json` / `module.jsonc` / `module.json.tmpl`) was invisible to the
 * guard. So a directory with no `module.json` is carried as `{ missing: true }`
 * and checkExtractionSourceAgreement refuses it. Nothing under the root is
 * skipped silently: an entry that cannot even be stat'ed (a dangling symlink)
 * becomes `{ readError }` rather than an unhandled ENOENT. A plain FILE beside
 * the module directories is not a module and is the one thing ignored.
 *
 * Malformed JSON is reported as a problem rather than thrown: the guard must
 * name the offending file. Only "extractionSource" is read here — the
 * module.json SCHEMA is D2-module-json-and-dist-schema's, and this guard owns
 * exactly one key.
 *
 * A root that is absent or is not a directory yields no entries and no throw;
 * checkVacuity is what refuses it, so a path typo cannot read as "empty".
 */
export function collectModuleJson(modulesRoot) {
  if (!isModulesDir(modulesRoot)) return []
  const entries = []
  for (const id of readdirSync(modulesRoot).sort()) {
    const dir = join(modulesRoot, id)
    let isDir = false
    try {
      isDir = statSync(dir).isDirectory()
    } catch (err) {
      // A dangling symlink, or a race with a writer. Never a skip — the guard
      // names the entry it could not read.
      entries.push({
        id,
        path: id,
        extractionSource: undefined,
        parseError: null,
        readError: err.message,
      })
      continue
    }
    if (!isDir) continue
    const file = join(dir, 'module.json')
    if (!existsSync(file)) {
      entries.push({
        id,
        path: `${id}/module.json`,
        extractionSource: undefined,
        parseError: null,
        missing: true,
      })
      continue
    }
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
 * A run over zero module DIRECTORIES passes vacuously; only the zero-module
 * assemble may ask for that, and it must ask with --allow-zero. The collector
 * yields one entry per module directory, so `entries.length` is the number of
 * modules present: --allow-zero now means "the root holds no module directory"
 * and can no longer be satisfied by a root full of module directories that
 * carry no manifest. `modulesRoot` is passed so the three ways of inspecting
 * nothing stay distinguishable:
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
        `no module directory under --modules-root ${String(modulesRoot)} — the agreement check would pass vacuously (pass --allow-zero for the zero-module assemble)`,
      ]
    : [
        'no --modules-root given — the agreement check would pass vacuously over zero module.json (pass --allow-zero to check the doc and the assembler wiring only)',
      ]
}

// ── The freeze must exist on the REMOTE, not on one machine ─────────────
//
// The annotated tag is this unit's only StuRaOS artefact, and
// D3-first-module-repo-users, D5-remaining-module-repos and
// D11-archive-holding-repo-and-stura-tree all extract from a CLONE, where a
// local-only tag does not resolve. The likely silent recovery is a fall back to
// `master` — exactly the two-source-states straddle the freeze exists to
// prevent, with no artefact saying it happened. Round 2 asserted "must be
// present on origin" in the doc's prose and shipped nothing that could fail;
// this is the executable form.
//
// It is opt-in (`--verify-remote <repo-or-url>`) rather than part of `make
// lint`: it needs the network and it is a post-condition on a repository the
// kernel does not own, so wiring it into every lint would make the kernel's
// build depend on another repo's push state. The kernel doc names the command.

export const TAG_NAME = 'extraction-source'

const REMOTE_REF_RE = /^([0-9a-f]{40})\t(refs\/tags\/\S+)$/gm

/**
 * The refusal, over the literal stdout of
 * `git ls-remote --tags <remote> 'refs/tags/extraction-source*'`. Pure, so the
 * three RED shapes are testable without a network: the tag absent, the tag
 * lightweight (spec B §2.4 requires an annotated tag, and a remote advertises
 * the peeled `^{}` ref only for one), and the tag peeling to another commit.
 */
export function checkRemoteTag(lsRemoteStdout, frozen, remote) {
  const refs = new Map()
  for (const [, sha, ref] of String(lsRemoteStdout).matchAll(REMOTE_REF_RE)) refs.set(ref, sha)
  const tagRef = `refs/tags/${TAG_NAME}`
  const peelRef = `${tagRef}^{}`
  if (!refs.has(tagRef))
    return [
      `${TAG_NAME} is not on ${remote} — \`git ls-remote --tags ${remote} '${tagRef}*'\` lists no such ref, so the freeze exists only on one machine; every extraction runs against a clone and would silently fall back to another commit`,
    ]
  if (!refs.has(peelRef))
    return [
      `${TAG_NAME} on ${remote} is a lightweight tag at ${refs.get(tagRef)} — spec B 2.4 requires an annotated tag, for which the remote also advertises ${peelRef}`,
    ]
  const peeled = refs.get(peelRef)
  if (peeled !== frozen)
    return [
      `${TAG_NAME} on ${remote} peels to ${peeled}, but ${DOC_PATH} records the frozen source ${frozen} — the published tag names a different commit`,
    ]
  return []
}

/** checkRemoteTag against a real remote. An unreachable remote is a problem, never a crash. */
export function verifyRemoteTag(remote, frozen = readFrozenExtractionSource()) {
  let out
  try {
    out = execFileSync('git', ['ls-remote', '--tags', remote, `refs/tags/${TAG_NAME}*`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    const detail = String(err.stderr || err.message || err).trim().split('\n').pop()
    return [`${remote} could not be read — git ls-remote failed: ${detail}`]
  }
  return checkRemoteTag(out, frozen, remote)
}

const GUARD_IMPORT_RE = /(?:from\s*|import\s*\(\s*)['"]\.\/check-extraction-source\.mjs['"]/
const GUARD_NAMES = ['runChecks', 'checkExtractionSourceAgreement', 'checkVacuity', 'collectModuleJson']

/**
 * The local names an assembler could call the guard by. A correctly wired
 * assembler that renames the import — `import { runChecks as check }` — used to
 * be refused, a false RED B34 would have hit; a namespace import
 * (`import * as guard`) already worked because `guard.runChecks(` still
 * contains the exported name. Both are wiring, so both are accepted.
 */
function guardBindings(src) {
  const names = new Set(GUARD_NAMES)
  const add = (list) => {
    for (const part of list.split(',')) {
      const t = part.trim()
      if (!t) continue
      const renamed = t.match(/(?:\bas\b|:)\s*([A-Za-z_$][\w$]*)\s*$/)
      names.add(renamed ? renamed[1] : t.split(/[\s:]+/)[0])
    }
  }
  for (const m of src.matchAll(
    /import\s+([^'"]*?)\s*from\s*['"]\.\/check-extraction-source\.mjs['"]/g
  )) {
    const clause = m[1]
    const ns = clause.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/)
    if (ns) names.add(ns[1])
    const braces = clause.match(/\{([^}]*)\}/)
    if (braces) add(braces[1])
    const dflt = clause.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/)
    if (dflt) names.add(dflt[1])
  }
  for (const m of src.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?import\s*\(\s*['"]\.\/check-extraction-source\.mjs['"]/g
  ))
    names.add(m[1])
  for (const m of src.matchAll(
    /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?import\s*\(\s*['"]\.\/check-extraction-source\.mjs['"]/g
  ))
    add(m[1])
  return [...names]
}

function callsGuard(src) {
  const names = guardBindings(src).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`\\b(?:${names.join('|')})\\s*\\(`).test(src)
}

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
  if (!callsGuard(src))
    return [
      `${ASSEMBLER_PATH}: imports ./check-extraction-source.mjs but never calls it — an import with no call site runs no agreement check at assemble time`,
    ]
  return []
}

export function runChecks(root, { modulesRoot = null, allowZero = false, verifyRemote = null } = {}) {
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
      ...(verifyRemote === null || verifyRemote === undefined
        ? []
        : verifyRemoteTag(verifyRemote, frozen)),
    ],
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

const USAGE =
  'usage: node scripts/check-extraction-source.mjs [--modules-root <dir>] [--allow-zero] [--verify-remote <repo-or-url>] [--print]'

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
        'verify-remote': { type: 'string' },
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
  const verifyRemote = values['verify-remote'] ?? null
  if (values.print === true) {
    // --print returns before every check, so a --print run that also carries a
    // checking flag would exit 0 having inspected nothing — the same shape as
    // the round-1 defect, one flag over. Refuse the combination rather than
    // ignore the token.
    const ignored = ['modules-root', 'allow-zero', 'verify-remote'].filter(
      (k) => values[k] !== undefined
    )
    if (ignored.length > 0)
      fail([
        `--print inspects nothing: it writes the frozen SHA and returns before the agreement, vacuity, wiring and remote checks. ${ignored
          .map((k) => `--${k}`)
          .join(', ')} would be silently ignored and the exit 0 would read as a green run of a check that never happened`,
        USAGE,
      ])
    process.stdout.write(`${readFrozenExtractionSource(ROOT)}\n`)
  } else {
    let result
    try {
      result = runChecks(ROOT, { modulesRoot, allowZero, verifyRemote })
    } catch (err) {
      // A doc with no canonical line, or two, throws from the parser. It is a
      // problem with the record, so it must render through the guard's own
      // formatter rather than escape as a raw stack past it.
      fail([err.message])
    }
    const { frozen, entries, problems } = result
    if (problems.length > 0) fail(problems)
    // The success line says what was actually inspected. "N module.json agree"
    // over zero manifests was the round-1 defect; a line nobody can misread as
    // coverage is the fix, not a comment saying it is fine.
    // The line names the number of module DIRECTORIES, not the number of
    // manifests that happened to be found: "1 module.json agree" over a root
    // holding two modules was round 2's HIGH, a count read as coverage.
    const withManifest = entries.filter((e) => e.missing !== true && !e.readError).length
    const summary =
      modulesRoot === null
        ? 'doc + assembler wiring only, no module.json inspected'
        : entries.length === 0
          ? `no module directory under ${modulesRoot} — zero-module assemble accepted via --allow-zero`
          : `${withManifest} of ${entries.length} module directories under ${modulesRoot} carry an agreeing module.json`
    console.log(`[extraction-source] OK — frozen at ${frozen}; ${summary}`)
  }
}
