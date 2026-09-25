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
//     resolution the kernel build does not provide);
//   - a relative import target that does not exist on disk.
//
// RED-before-GREEN evidence lives in the commit that adds tenant-domain.ts:
// this test is authored FIRST, while tenant-domain.ts does not exist yet, so
// it fails on a missing file before it ever gets the chance to fail on an
// import.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const SPECIFIER_RE = /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\bfrom\s+)?['"]([^'"]+)['"]/g

function extractSpecifiers(src: string): string[] {
  const specs: string[] = []
  let m: RegExpExecArray | null
  SPECIFIER_RE.lastIndex = 0
  while ((m = SPECIFIER_RE.exec(src))) specs.push(m[1])
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
