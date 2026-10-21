// src/lib/server/tenant/kernel-portable.guard.test.ts
// L3-17 — these three files are the ones a future kernel API takes over
// UNCHANGED (brief TASK-025 §5 "Fixed"): host.ts, reserved-hosts.ts and
// tenant-domain.ts must never depend on the SvelteKit runtime, directly or
// through a relative import they reach. A dependency on $env/$app/$lib/
// $service-worker/@sveltejs/* would mean the file can only run inside a
// SvelteKit request — exactly what "kernel-portable" rules out.
//
// Scans the ENTRY files plus every file they reach through a RELATIVE import
// (bare-package imports like 'postgres' or '@gremion/db' are not SvelteKit and
// are allowed; a relative import is followed because it is still "this
// module's own code"). Fails on:
//   - a forbidden specifier (see FORBIDDEN_PATTERNS), including `import type`
//     (a type-only import still couples the file to the SvelteKit module
//     resolution the kernel build does not provide) AND a DYNAMIC
//     `import('<spec>')`/`import(\`<spec>\`)` or `require(...)` call whose
//     argument is a string or no-substitution template literal (TASK-025
//     round-2 fix MED #2 — the static-only grammar originally here let
//     `import('$env/dynamic/private')` pass silently; round-3 fix MEDIUM #2
//     added the no-substitution template-literal form);
//   - a NON-LITERAL dynamic import(...)/require(...) argument (a
//     `${...}`-computed template, a bare identifier, a concatenation, ...),
//     as its OWN violation label "non-literal dynamic import" — round-3 fix
//     MEDIUM #2: a regex-based guard cannot evaluate an arbitrary expression,
//     so failing loud on every non-literal dynamic call is the fail-closed
//     choice (see findNonLiteralDynamicImports for the full rationale);
//   - a relative import target that does not exist on disk.
//
// RED-before-GREEN evidence lives in the commit that adds tenant-domain.ts:
// this test is authored FIRST, while tenant-domain.ts does not exist yet, so
// it fails on a missing file before it ever gets the chance to fail on an
// import.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * TASK-077 G6: L3-17 took the files over — they now live in
 * packages/tenancy-core/src (gremion-ui's host.ts, reserved-hosts.ts,
 * tenant-domain.ts and host-mismatch-log.ts are re-exports of them), so the
 * guard scans the package source the kernel API actually runs. The fourth file
 * joined because the kernel API logs host rejections through it too.
 */
const TENANCY_CORE_SRC = '../../../../../packages/tenancy-core/src'
const ENTRY_FILES = ['host.ts', 'reserved-hosts.ts', 'tenant-domain.ts', 'host-mismatch-log.ts', 'index.ts'].map(
  (f) => `${TENANCY_CORE_SRC}/${f}`,
)

/** Q3 default (brief §5): these specifier shapes make a file SvelteKit-bound. */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /^\$env(\/|$)/, label: '$env/*' },
  { re: /^\$app(\/|$)/, label: '$app/*' },
  { re: /^\$lib(\/|$)/, label: '$lib/*' },
  { re: /^\$service-worker$/, label: '$service-worker' },
  { re: /^@sveltejs\//, label: '@sveltejs/*' },
]

/** Matches `import ... from '<spec>'`, `import '<spec>'` and `export ... from '<spec>'`,
 *  with or without a leading `type` keyword — a type-only import still counts. */
const STATIC_SPECIFIER_RE = /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\bfrom\s+)?['"]([^'"]+)['"]/g

/**
 * TASK-025 round-2 fix (MED #2): `import ... from '<spec>'` requires whitespace
 * between the keyword and the specifier, so it never matches a DYNAMIC
 * `import('<spec>')` call (no `from`, `(` immediately follows the keyword) —
 * that shape passed the guard silently, e.g. `import('$env/dynamic/private')`.
 * `require('<spec>')` is the same gap for anything transpiled to CommonJS.
 *
 * Captures the WHOLE argument text (not just a quoted body) so the caller can
 * classify it — round-3 fix MEDIUM #2 found that a round-2 regex requiring
 * `['"]` delimiters missed a no-substitution template literal
 * (`import(\`$env/dynamic/private\`)`), and a plain string/backtick check
 * alone still lets a COMPUTED specifier (`import(\`$env/${x}\`)`, a bare
 * identifier, a concatenation, ...) through with no violation at all — see
 * findNonLiteralDynamicImports below. `[^)]*` does not balance nested parens;
 * an argument containing its own call (`import(getPath())`) is not matched
 * whole, but the truncated text still fails literalSpecifierOf and is
 * reported as non-literal, which is the correct outcome either way.
 */
const DYNAMIC_CALL_RE = /\b(?:import|require)\s*\(([^)]*)\)/g

/**
 * A single/double-quoted string, or a backtick template with NO `${`
 * substitution, resolves to a literal specifier string a static scanner CAN
 * check against FORBIDDEN_PATTERNS. Anything else returns null.
 */
function literalSpecifierOf(rawArg: string): string | null {
  const arg = rawArg.trim()
  const quoted = /^'([^']*)'$/.exec(arg) ?? /^"([^"]*)"$/.exec(arg)
  if (quoted) return quoted[1]
  const backtick = /^`([^`]*)`$/.exec(arg)
  if (backtick && !backtick[1].includes('${')) return backtick[1]
  return null
}

/**
 * Every dynamic import(...)/require(...) call whose argument is NOT a
 * resolvable literal (literalSpecifierOf returns null): a `${...}`-computed
 * template, a bare identifier, a concatenation, .... DECISION (round-3 fix
 * MEDIUM #2): a regex-based guard cannot evaluate an arbitrary expression, so
 * a computed specifier could resolve to '$env/dynamic/private' just as easily
 * as to something benign — silently passing it (the round-2 behaviour) would
 * let a computed specifier hide a forbidden import from this guard forever.
 * Failing loud on EVERY non-literal dynamic call is the fail-closed choice:
 * it would false-positive if a kernel-portable file ever needed a genuinely
 * dynamic (non-SvelteKit) import, but there is no such use case in
 * host.ts/reserved-hosts.ts/tenant-domain.ts today, and a legitimate one can
 * be special-cased later, in the open, next to FORBIDDEN_PATTERNS.
 */
function findNonLiteralDynamicImports(src: string): string[] {
  const nonLiteral: string[] = []
  DYNAMIC_CALL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DYNAMIC_CALL_RE.exec(src))) {
    const arg = m[1].trim()
    if (literalSpecifierOf(arg) === null) nonLiteral.push(arg)
  }
  return nonLiteral
}

function extractSpecifiers(src: string): string[] {
  const specs: string[] = []
  let m: RegExpExecArray | null
  STATIC_SPECIFIER_RE.lastIndex = 0
  while ((m = STATIC_SPECIFIER_RE.exec(src))) specs.push(m[1])
  DYNAMIC_CALL_RE.lastIndex = 0
  while ((m = DYNAMIC_CALL_RE.exec(src))) {
    const lit = literalSpecifierOf(m[1])
    if (lit !== null) specs.push(lit)
  }
  return specs
}

function isRelative(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../')
}

/** Resolve a relative specifier from `fromFile` to a concrete path on disk,
 *  trying the extensionless, `.ts` and `/index.ts` forms. Returns the `.ts`
 *  guess (which then fails existsSync) when nothing on disk matches, so the
 *  caller can report a clear "missing file" failure. */
function resolveRelativeSpecifier(fromFile: string, spec: string): string {
  const base = resolve(dirname(fromFile), spec)
  for (const candidate of [base, `${base}.ts`, resolve(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate
  }
  return `${base}.ts`
}

interface Violation {
  file: string
  specifier: string
  label: string
}

interface MissingFile {
  file: string
  specifier: string
  resolvedTo: string
}

interface ScanResult {
  visited: string[]
  violations: Violation[]
  missing: MissingFile[]
}

/** BFS over the entry files and everything they reach via a relative import. */
function scanKernelPortability(entryFiles: readonly string[]): ScanResult {
  const violations: Violation[] = []
  const missing: MissingFile[] = []
  const visited: string[] = []
  const seen = new Set<string>()
  const queue = entryFiles.map((f) => resolve(HERE, f))

  while (queue.length > 0) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)

    if (!existsSync(file)) {
      missing.push({ file, specifier: '(entry)', resolvedTo: file })
      continue
    }
    visited.push(file)
    const src = readFileSync(file, 'utf-8')
    // Round-3 fix MEDIUM #2: a non-literal dynamic import/require argument is
    // its OWN violation, independent of FORBIDDEN_PATTERNS (which can only
    // test a resolvable specifier STRING) — see findNonLiteralDynamicImports.
    for (const arg of findNonLiteralDynamicImports(src)) {
      violations.push({ file, specifier: arg, label: 'non-literal dynamic import' })
    }
    for (const spec of extractSpecifiers(src)) {
      if (isRelative(spec)) {
        const target = resolveRelativeSpecifier(file, spec)
        if (!existsSync(target)) {
          missing.push({ file, specifier: spec, resolvedTo: target })
          continue
        }
        if (!seen.has(target)) queue.push(target)
        continue
      }
      const forbidden = FORBIDDEN_PATTERNS.find((p) => p.re.test(spec))
      if (forbidden) {
        violations.push({ file, specifier: spec, label: forbidden.label })
      }
    }
  }

  return { visited, violations, missing }
}

// TASK-025 round-2 fix (verify-round1.md residual "MED #2"): the guard's
// SPECIFIER_RE only matches the STATIC import/export-from grammar, so a
// dynamic `import('$env/dynamic/private')` — no `from`, no whitespace
// requirement satisfied between `import` and `(` — passes it silently. A
// `require('$env/...')` call is the same gap for anything transpiled to
// CommonJS. Both are exercised directly against extractSpecifiers (no disk
// I/O, deterministic) so a regression here fails fast without needing to
// seed a real file.
describe('dynamic import(...) / require(...) detection (round-2 fix MED #2)', () => {
  it('extractSpecifiers finds a dynamic import(...) with a string-literal argument', () => {
    expect(extractSpecifiers(`const m = await import('$env/dynamic/private')`))
      .toContain('$env/dynamic/private')
  })

  it('extractSpecifiers finds a dynamic import(...) with double quotes and inner whitespace', () => {
    expect(extractSpecifiers(`await import ( "$app/environment" )`))
      .toContain('$app/environment')
  })

  it('extractSpecifiers finds a require(...) call', () => {
    expect(extractSpecifiers(`const m = require('$env/dynamic/private')`))
      .toContain('$env/dynamic/private')
  })

  // TASK-025 round-3 fix (house review HIGH): the previous version of this
  // test claimed to "exercise the full scanKernelPortability path ... by
  // seeding the violation into an ISOLATED temp fixture", but it only called
  // extractSpecifiers + FORBIDDEN_PATTERNS on an inline string — it never ran
  // scanKernelPortability, never touched a file on disk, and would have
  // stayed green even if the BFS/violation-recording wiring around
  // extractSpecifiers were broken. This version writes the seeded source to a
  // REAL isolated fixture file (a fresh os.tmpdir() directory, removed in
  // `finally`) and asserts on scanKernelPortability's own return value.
  // `scanKernelPortability` needs no signature change: `resolve(HERE, f)`
  // returns `f` unchanged when `f` is already absolute (node:path.resolve),
  // so an absolute fixture path slots into the same `entryFiles` array the
  // real 3 entry files use.
  it('a seeded dynamic $env import in an ISOLATED temp fixture is reported as a violation by the real scan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kernel-portable-guard-'))
    const fixture = join(dir, 'seeded-dynamic-env.ts')
    try {
      writeFileSync(
        fixture,
        `export async function f() {\n  const { env } = await import('$env/dynamic/private')\n  return env\n}\n`,
        'utf-8',
      )
      const { violations, missing } = scanKernelPortability([fixture])
      expect(missing).toEqual([])
      expect(violations).toEqual([
        { file: fixture, specifier: '$env/dynamic/private', label: '$env/*' },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// TASK-025 round-3 fix (house review MEDIUM #2): DYNAMIC_SPECIFIER_RE only
// matched a single- or double-quoted argument, so a no-substitution template
// literal — `import(`$env/dynamic/private`)` — passed silently (the `['"]`
// character class in the round-2 regex never matches a backtick). Fixed by
// classifying EVERY dynamic import(...)/require(...) call's argument:
//   - a '...'/"..." literal, or a `...` template with NO `${` inside, is a
//     resolvable specifier — checked against FORBIDDEN_PATTERNS exactly like
//     a static specifier;
//   - anything else (a `${...}`-computed template, a bare identifier, a
//     concatenation, ...) is NOT resolvable statically, and is flagged as its
//     OWN violation class, "non-literal dynamic import" — DECISION: a
//     computed specifier could just as easily resolve to '$env/dynamic/private'
//     at runtime as to something benign, and a regex-based guard has no way to
//     evaluate it, so silently ignoring it (the round-2 behaviour) would let a
//     computed specifier hide a forbidden import from this guard forever.
//     Failing loud on ANY non-literal dynamic call is the fail-closed choice;
//     it costs a false positive if a kernel-portable file ever needs a
//     genuinely dynamic (non-SvelteKit) import, but there is no such use case
//     in host.ts/reserved-hosts.ts/tenant-domain.ts today, and a legitimate
//     one can be special-cased in FORBIDDEN_PATTERNS's neighbourhood later.
describe('dynamic import(...) / require(...) literal classification (round-3 fix MEDIUM #2)', () => {
  it('extractSpecifiers finds a no-substitution template-literal import(...)', () => {
    expect(extractSpecifiers('await import(`$env/dynamic/private`)'))
      .toContain('$env/dynamic/private')
  })

  it('extractSpecifiers finds a no-substitution template-literal require(...)', () => {
    expect(extractSpecifiers('const m = require(`$app/environment`)'))
      .toContain('$app/environment')
  })

  it('findNonLiteralDynamicImports flags a ${...}-computed template as non-literal, NOT as a resolved specifier', () => {
    const src = 'const sub = "dynamic/private"\nawait import(`$env/${sub}`)'
    expect(extractSpecifiers(src)).not.toContain('$env/dynamic/private')
    expect(findNonLiteralDynamicImports(src)).toEqual(['`$env/${sub}`'])
  })

  it('findNonLiteralDynamicImports flags a bare-identifier argument', () => {
    const src = 'await import(modulePath)'
    expect(findNonLiteralDynamicImports(src)).toEqual(['modulePath'])
  })

  it('findNonLiteralDynamicImports flags a concatenation argument', () => {
    const src = "require('$env/' + suffix)"
    expect(findNonLiteralDynamicImports(src)).toEqual(["'$env/' + suffix"])
  })

  it('findNonLiteralDynamicImports does NOT flag a plain string or a no-substitution template', () => {
    const src = "import('./relative'); import(`$env/dynamic/private`)"
    expect(findNonLiteralDynamicImports(src)).toEqual([])
  })

  // Full-pipeline proof (not just the classifier in isolation): a computed
  // template that WOULD resolve to a forbidden $env specifier at runtime is
  // reported as a violation via the real scanKernelPortability path, even
  // though its literal text never matches FORBIDDEN_PATTERNS.
  it('a computed dynamic import in an ISOLATED temp fixture is reported as a non-literal violation by the real scan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kernel-portable-guard-'))
    const fixture = join(dir, 'seeded-computed-dynamic.ts')
    try {
      writeFileSync(
        fixture,
        'const sub = "dynamic/private"\nexport const p = import(`$env/${sub}`)\n',
        'utf-8',
      )
      const { violations, missing } = scanKernelPortability([fixture])
      expect(missing).toEqual([])
      expect(violations).toEqual([
        { file: fixture, specifier: '`$env/${sub}`', label: 'non-literal dynamic import' },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('kernel-portable guard (L3-17)', () => {
  it('host.ts, reserved-hosts.ts and tenant-domain.ts exist and are reachable', () => {
    const { visited, missing } = scanKernelPortability(ENTRY_FILES)
    if (missing.length > 0) {
      const detail = missing
        .map((m) => `  ${m.file} -> "${m.specifier}" (looked for ${m.resolvedTo})`)
        .join('\n')
      throw new Error(`kernel-portable guard: missing file(s):\n${detail}`)
    }
    // At minimum the 3 entry files themselves must have been scanned.
    expect(visited.length).toBeGreaterThanOrEqual(ENTRY_FILES.length)
  })

  it('carries no SvelteKit-bound import ($env/$app/$lib/$service-worker/@sveltejs), including import type', () => {
    const { violations, missing } = scanKernelPortability(ENTRY_FILES)
    // A missing file already fails the test above with a clearer message;
    // don't also report a wall of spurious "0 violations" noise here.
    if (missing.length > 0) {
      throw new Error(`kernel-portable guard: cannot check imports — file(s) missing (see previous test)`)
    }
    if (violations.length > 0) {
      const detail = violations
        .map((v) => `  ${v.file} imports "${v.specifier}" (${v.label})`)
        .join('\n')
      throw new Error(`kernel-portable guard: forbidden SvelteKit import(s):\n${detail}`)
    }
    expect(violations).toEqual([])
  })
})
