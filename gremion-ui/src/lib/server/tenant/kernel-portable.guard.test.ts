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
//     `import('<spec>')` or `require('<spec>')` call with a string-literal
//     argument (TASK-025 round-2 fix MED #2 — the static-only grammar
//     originally here let `import('$env/dynamic/private')` pass silently);
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

/** The three files L3-17 takes over unchanged. */
const ENTRY_FILES = ['host.ts', 'reserved-hosts.ts', 'tenant-domain.ts']

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
 * Only a STRING-LITERAL argument is in scope — a computed specifier
 * (`import(pathVar)`) cannot be resolved statically and a kernel-portable file
 * must never construct one anyway. Optional inner whitespace (`import ( '…' )`)
 * is allowed so a reformatted call is not a silent bypass either.
 */
const DYNAMIC_SPECIFIER_RE = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function extractSpecifiers(src: string): string[] {
  const specs: string[] = []
  let m: RegExpExecArray | null
  STATIC_SPECIFIER_RE.lastIndex = 0
  while ((m = STATIC_SPECIFIER_RE.exec(src))) specs.push(m[1])
  DYNAMIC_SPECIFIER_RE.lastIndex = 0
  while ((m = DYNAMIC_SPECIFIER_RE.exec(src))) specs.push(m[1])
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
