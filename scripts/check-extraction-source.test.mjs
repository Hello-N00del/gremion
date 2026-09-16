#!/usr/bin/env node
// node --test suite for the frozen extraction-source guard
// (spec B 2.4, unit B00-extraction-source-freeze).
//
// Same idiom as scripts/check-cve-floors.test.mjs: assert POST-CONDITIONS on
// real file content, never an exit code. Every helper is exercised against the
// REAL committed state (must be clean) and against a synthetic broken state
// (must produce a problem) — a guard that cannot be shown failing is not a guard.
//
// The helpers are imported through scripts/check-extraction-source.mjs, which
// re-exports scripts/lib/extraction-source.mjs. The lib is the single
// implementation D2's validateDistManifest imports; the re-export is not a
// second one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DOC_PATH,
  SHA_RE,
  parseFrozenExtractionSource,
  readFrozenExtractionSource,
  collectModuleJson,
  checkExtractionSourceAgreement,
  checkVacuity,
  runChecks,
  checkAssemblerWiring,
  ASSEMBLER_PATH,
} from './check-extraction-source.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FROZEN = 'f276af5925abacdcfd05f6613fc11afff2d804c5'
const OTHER = '0123456789abcdef0123456789abcdef01234567'

test('the committed kernel doc records the frozen extraction source', () => {
  assert.equal(readFrozenExtractionSource(ROOT), FROZEN)
  assert.match(readFrozenExtractionSource(ROOT), SHA_RE)
})

test('DOC_PATH is the one place the SHA is recorded', () => {
  assert.equal(DOC_PATH, 'docs/ops/extraction-source.md')
})

test('the parser reads the canonical line', () => {
  assert.equal(
    parseFrozenExtractionSource(`# heading\n\nextraction-source: ${FROZEN}\n\ntrailing prose\n`),
    FROZEN
  )
})

test('the parser refuses a doc with no canonical line', () => {
  assert.throws(
    () => parseFrozenExtractionSource(`# heading\n\nfrozen at ${FROZEN}\n`),
    /no canonical line/
  )
})

test('the parser refuses a doc that records the SHA twice — "recorded once" is the contract', () => {
  assert.throws(
    () => parseFrozenExtractionSource(`extraction-source: ${FROZEN}\nextraction-source: ${OTHER}\n`),
    /2 canonical lines/
  )
})

test('the parser refuses an uppercase or short SHA', () => {
  assert.throws(
    () => parseFrozenExtractionSource(`extraction-source: ${FROZEN.toUpperCase()}\n`),
    /no canonical line/
  )
  assert.throws(
    () => parseFrozenExtractionSource(`extraction-source: ${FROZEN.slice(0, 12)}\n`),
    /no canonical line/
  )
})

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

const FIXTURES = join(ROOT, 'test/fixtures/extraction-source/agree')

function scratchModules(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'b00-modules-'))
  for (const [id, body] of Object.entries(spec)) {
    mkdirSync(join(dir, id), { recursive: true })
    // body === null creates the module DIRECTORY and no manifest — the shape an
    // extraction that never wrote module.json leaves behind. It must be a
    // problem, never a silent skip: that is round 2's HIGH.
    if (body === null) continue
    writeFileSync(
      join(dir, id, 'module.json'),
      typeof body === 'string' ? body : JSON.stringify(body, null, 2)
    )
  }
  return dir
}

test('the committed fixture pair agrees with the frozen source', () => {
  const entries = collectModuleJson(FIXTURES)
  assert.equal(entries.length, 2, 'fixture must carry two module.json, or the RED case is untestable')
  assert.deepEqual(entries.map((e) => e.id), ['calendar', 'users'])
  assert.deepEqual(checkExtractionSourceAgreement(entries, FROZEN), [])
})

test('checkExtractionSourceAgreement(manifests) defaults to the kernel doc — the form D2 calls', () => {
  // Spec D D.1.2: exactly one validator. D2's validateDistManifest in
  // scripts/validate-module-schemas.mjs imports THIS function and has no root
  // of its own to pass, so the one-argument form must read DOC_PATH itself.
  // The entry shape below is what D2 maps each module.json it validates onto.
  assert.deepEqual(checkExtractionSourceAgreement(collectModuleJson(FIXTURES)), [])
  const bad = [{ id: 'x', path: 'x/module.json', extractionSource: OTHER, parseError: null }]
  assert.match(
    checkExtractionSourceAgreement(bad).join('\n'),
    /disagrees with the frozen source f276af5925abacdcfd05f6613fc11afff2d804c5/
  )
})

test('checkExtractionSourceAgreement goes RED when one module.json carries a different SHA', (t) => {
  const dir = scratchModules({
    users: { schemaVersion: 1, id: 'users', extractionSource: FROZEN },
    calendar: { schemaVersion: 1, id: 'calendar', extractionSource: OTHER },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const problems = checkExtractionSourceAgreement(collectModuleJson(dir), FROZEN)
  assert.ok(problems.length >= 2, problems.join('\n'))
  assert.match(problems.join('\n'), /calendar\/module\.json: extractionSource 0123456789abcdef/)
  assert.match(problems.join('\n'), /two module\.json disagree on extractionSource/)
})

test('checkExtractionSourceAgreement goes RED on an absent key', (t) => {
  const dir = scratchModules({ users: { schemaVersion: 1, id: 'users' } })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.match(
    checkExtractionSourceAgreement(collectModuleJson(dir), FROZEN).join('\n'),
    /extractionSource absent/
  )
})

test('checkExtractionSourceAgreement goes RED on an uppercase, short or non-string value', (t) => {
  const dir = scratchModules({
    a: { id: 'a', extractionSource: FROZEN.toUpperCase() },
    b: { id: 'b', extractionSource: FROZEN.slice(0, 12) },
    c: { id: 'c', extractionSource: 12345 },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const problems = checkExtractionSourceAgreement(collectModuleJson(dir), FROZEN)
  assert.equal(problems.filter((p) => /is not 40 lowercase hex/.test(p)).length, 3, problems.join('\n'))
})

test('unparseable module.json is a problem, not a crash', (t) => {
  const dir = scratchModules({ users: '{ not json' })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.match(
    checkExtractionSourceAgreement(collectModuleJson(dir), FROZEN).join('\n'),
    /not parseable JSON/
  )
})

test('a zero-module run is refused unless allowZero — it would pass vacuously', (t) => {
  const dir = scratchModules({})
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const entries = collectModuleJson(dir)
  assert.deepEqual(entries, [])
  assert.match(checkVacuity(entries, {}).join('\n'), /would pass vacuously/)
  assert.deepEqual(checkVacuity(entries, { allowZero: true }), [])
})

test('runChecks reports zero problems for the committed repo state plus the fixture pair', () => {
  assert.deepEqual(runChecks(ROOT, { modulesRoot: FIXTURES }).problems, [])
  assert.equal(runChecks(ROOT, { modulesRoot: FIXTURES }).frozen, FROZEN)
})

test('no assembler exists yet, so the wiring guard is silent', () => {
  // scripts/assemble.mjs is shipped by B34-assembler-zero-modules. Until then
  // the guard must NOT invent a failure — and must not be silent afterwards.
  assert.equal(ASSEMBLER_PATH, 'scripts/assemble.mjs')
  if (!existsSync(join(ROOT, ASSEMBLER_PATH))) assert.deepEqual(checkAssemblerWiring(ROOT), [])
})

test('the wiring guard goes RED for an assembler that does not import this check', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'b00-root-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'scripts', 'assemble.mjs'), "console.log('assembling')\n")
  assert.match(
    checkAssemblerWiring(dir).join('\n'),
    /scripts\/assemble\.mjs: exists but does not import \.\/check-extraction-source\.mjs/
  )
})

test('the wiring guard passes for an assembler that imports it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'b00-root-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(
    join(dir, 'scripts', 'assemble.mjs'),
    "import { runChecks } from './check-extraction-source.mjs'\nrunChecks(process.cwd(), {})\n"
  )
  assert.deepEqual(checkAssemblerWiring(dir), [])
})

// ── The guard's own vacuity: the CLI surface ───────────────────────────────
//
// Round-1 review found the hole these arms close: the agreement check was run
// only when a modules root happened to be truthy, and the CLI took the value
// from `argv[at + 1]` unvalidated. So `--modules-root` with its value dropped,
// a flag-name typo, or no arguments at all each printed
// `[extraction-source] OK — …; 0 module.json agree` and exited 0 — a success
// line asserting a check that never ran. Every arm below is the real CLI in a
// child process, asserting the rendered stdout/stderr, never the exit code
// alone.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const CLI = join(ROOT, 'scripts/check-extraction-source.mjs')

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

test('the CLI refuses --modules-root with its value omitted, instead of printing a false OK', () => {
  const r = runCli(['--modules-root'])
  assert.doesNotMatch(r.stdout, /OK/, `stdout was: ${r.stdout}`)
  assert.match(r.stderr, /\[extraction-source\] \d+ problem\(s\):/)
  assert.match(r.stderr, /--modules-root/)
  assert.equal(r.code, 1)
})

test('the CLI refuses a flag-name typo rather than silently ignoring it', () => {
  const r = runCli(['--module-root', FIXTURES])
  assert.doesNotMatch(r.stdout, /OK/, `stdout was: ${r.stdout}`)
  assert.match(r.stderr, /--module-root/)
  assert.equal(r.code, 1)
})

test('the CLI accepts the --modules-root=<dir> equals form', () => {
  const r = runCli([`--modules-root=${FIXTURES}`])
  assert.equal(r.code, 0, `stderr was: ${r.stderr}`)
  assert.match(r.stdout, /2 of 2 module directories/)
})

test('the CLI with no arguments refuses instead of reporting agreement over zero manifests', () => {
  const r = runCli([])
  assert.doesNotMatch(r.stdout, /module\.json agree/, `stdout was: ${r.stdout}`)
  assert.match(r.stderr, /would pass vacuously/)
  assert.equal(r.code, 1)
})

test('the doc-only run must ask for it, and its success line claims no agreement it did not check', () => {
  const r = runCli(['--allow-zero'])
  assert.equal(r.code, 0, `stderr was: ${r.stderr}`)
  assert.match(r.stdout, /no module\.json inspected/)
  assert.doesNotMatch(r.stdout, /module\.json agree/)
})

test('a modules root that does not exist is a problem even under --allow-zero', () => {
  const r = runCli(['--modules-root', join(ROOT, 'no-such-modules-root'), '--allow-zero'])
  assert.match(r.stderr, /is not a directory/)
  assert.doesNotMatch(r.stdout, /OK/, `stdout was: ${r.stdout}`)
  assert.equal(r.code, 1)
})

test('a modules root that names a file is a problem, not an ENOTDIR crash', () => {
  const r = runCli(['--modules-root', join(ROOT, 'Makefile')])
  assert.match(r.stderr, /is not a directory/)
  assert.doesNotMatch(r.stderr, /ENOTDIR/, `stderr was: ${r.stderr}`)
  assert.equal(r.code, 1)
})

test('--print still writes the frozen SHA and nothing else', () => {
  const r = runCli(['--print'])
  assert.equal(r.code, 0, `stderr was: ${r.stderr}`)
  assert.equal(r.stdout.trim(), FROZEN)
})

test('runChecks with no modules root refuses unless allowZero — the library-level form of the same hole', () => {
  assert.match(runChecks(ROOT, {}).problems.join('\n'), /would pass vacuously/)
  assert.match(runChecks(ROOT).problems.join('\n'), /would pass vacuously/)
  assert.deepEqual(runChecks(ROOT, { allowZero: true }).problems, [])
})

test('the Makefile recipe passes a real --modules-root — a recipe that drops it would check nothing', () => {
  const mk = readFileSync(join(ROOT, 'Makefile'), 'utf8')
  const after = mk.split(/^lint-extraction-source:.*$/m)[1]
  assert.ok(after, 'no lint-extraction-source target in the Makefile')
  const recipe = after.split(/\n(?=\S)/)[0]
  const m = recipe.match(/check-extraction-source\.mjs\s+--modules-root[= ]\s*(\S+)/)
  assert.ok(m, `the recipe does not pass --modules-root:\n${recipe}`)
  const entries = collectModuleJson(join(ROOT, m[1]))
  assert.ok(entries.length >= 2, `--modules-root ${m[1]} holds ${entries.length} module.json`)
})

test('the wiring guard is not satisfied by a commented-out import', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'b00-root-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(
    join(dir, 'scripts', 'assemble.mjs'),
    "// import { runChecks } from './check-extraction-source.mjs'\nconsole.log('assembling')\n"
  )
  assert.match(checkAssemblerWiring(dir).join('\n'), /scripts\/assemble\.mjs/)
})

test('the wiring guard goes RED for an assembler that imports the guard and never calls it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'b00-root-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(
    join(dir, 'scripts', 'assemble.mjs'),
    "import { runChecks } from './check-extraction-source.mjs'\nconsole.log('assembling')\n"
  )
  assert.match(checkAssemblerWiring(dir).join('\n'), /never calls it/)
})

test('the wiring guard accepts a dynamic import that calls the guard', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'b00-root-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(
    join(dir, 'scripts', 'assemble.mjs'),
    "const g = await import('./check-extraction-source.mjs')\ng.runChecks(process.cwd(), { modulesRoot: 'modules', allowZero: true })\n"
  )
  assert.deepEqual(checkAssemblerWiring(dir), [])
})

test('the zero-module assemble arm is allowed but is not reported as agreement', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'b00-empty-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ok = runCli(['--modules-root', dir, '--allow-zero'])
  assert.equal(ok.code, 0, 'stderr was: ' + ok.stderr)
  assert.match(ok.stdout, /zero-module assemble accepted via --allow-zero/)
  assert.doesNotMatch(ok.stdout, /module\.json under .* agree/)
  const refused = runCli(['--modules-root', dir])
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /would pass vacuously/)
})

// ── "inspects a subset reads as OK" — round 2's HIGH ───────────────────────
//
// Round 1's hole was "inspects nothing reads as OK". One level down: a module
// DIRECTORY that carries no module.json was skipped by the collector, so a
// modules root holding two modules and one manifest printed
// `OK — …; 1 module.json … agree` and exited 0, and a root full of
// manifest-less module directories read as "zero-module assemble accepted".
// A module whose extraction never wrote a manifest — or wrote `Module.json`,
// `module.jsonc`, `module.json.tmpl` — is exactly the straddle the freeze
// exists to refuse, so it must be a problem and the success line must name the
// number of module DIRECTORIES, not the number of manifests that happened to
// be found.

test('a module directory with no module.json is a problem, not a silent skip', (t) => {
  const dir = scratchModules({
    users: { schemaVersion: 1, id: 'users', extractionSource: FROZEN },
    calendar: null,
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const entries = collectModuleJson(dir)
  assert.equal(entries.length, 2, `the collector must see both module directories: ${JSON.stringify(entries)}`)
  assert.match(
    checkExtractionSourceAgreement(entries, FROZEN).join('\n'),
    /calendar\/: no module\.json/
  )
})

test('the CLI refuses a modules root whose module directories are not all covered', (t) => {
  const dir = scratchModules({
    users: { schemaVersion: 1, id: 'users', extractionSource: FROZEN },
    calendar: null,
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = runCli(['--modules-root', dir])
  assert.doesNotMatch(r.stdout, /OK/, `stdout was: ${r.stdout}`)
  assert.match(r.stderr, /calendar\/: no module\.json/)
  assert.equal(r.code, 1)
})

test('--allow-zero means "no module directories", never "no manifests were found"', (t) => {
  const dir = scratchModules({ users: null, calendar: null })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = runCli(['--modules-root', dir, '--allow-zero'])
  assert.doesNotMatch(r.stdout, /zero-module assemble accepted/, `stdout was: ${r.stdout}`)
  assert.doesNotMatch(r.stdout, /OK/, `stdout was: ${r.stdout}`)
  assert.match(r.stderr, /users\/: no module\.json/)
  assert.match(r.stderr, /calendar\/: no module\.json/)
  assert.equal(r.code, 1)
})

test('the success line counts module directories, not manifests that happened to exist', () => {
  const r = runCli(['--modules-root', FIXTURES])
  assert.equal(r.code, 0, `stderr was: ${r.stderr}`)
  assert.match(r.stdout, /2 of 2 module directories under .* carry an agreeing module\.json/)
})
