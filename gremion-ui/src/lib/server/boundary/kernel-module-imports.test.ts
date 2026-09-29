// TASK-206-A boundary scan (brief §6.15): no TRACKED kernel source file under
// gremion-ui/src imports module code. kernel-clean.test.ts walks the in-tree
// feature targets; this one covers what it cannot see:
//   - a relative specifier that climbs out of gremion-ui into the repo-root
//     `modules/**` tree (the carved feature modules live there);
//   - `$lib/server/finance/**` (the finance module's server lib, which the
//     kernel must reach only through the runtime-registry seams);
//   - a `$lib/...` path that exists ONLY under some `modules/*/app/` overlay:
//     it resolves while that module is overlaid and breaks the kernel alone.
// Direction (open-core): modules may import the kernel, never the reverse.
// Only `git ls-files` counts, so an untracked overlay copy is not the kernel.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const GREMION_UI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const REPO = resolve(GREMION_UI, '..')
const SRC = join(GREMION_UI, 'src')
const MODULES = join(REPO, 'modules')

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g
const EXTS = ['', '.ts', '.js', '.svelte', '/index.ts', '/index.js']

type Exists = (p: string) => boolean

function specifiersOf(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((m) => m[1]!)
}

function resolvesUnder(base: string, rest: string, exists: Exists): boolean {
  return EXTS.some((ext) => exists(join(base, rest + ext)))
}

/** Module overlay app roots: modules/<id>/app. */
function overlayRoots(): string[] {
  if (!existsSync(MODULES)) return []
  return readdirSync(MODULES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(MODULES, d.name, 'app'))
    .filter((p) => existsSync(p))
}

/** Violations for one kernel file: `<file>: <specifier> (<why>)`. */
function scanKernelFile(
  absFile: string,
  source: string,
  exists: Exists,
  overlays: readonly string[],
): string[] {
  const rel = relative(REPO, absFile).split(sep).join('/')
  const out: string[] = []
  for (const spec of specifiersOf(source)) {
    if (spec === '$lib/server/finance' || spec.startsWith('$lib/server/finance/')) {
      out.push(`${rel}: ${spec} (finance module server lib)`)
      continue
    }
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const target = resolve(dirname(absFile), spec)
      if (target === MODULES || target.startsWith(MODULES + sep)) {
        out.push(`${rel}: ${spec} (repo-root modules/**)`)
      }
      continue
    }
    if (spec.startsWith('$lib/')) {
      const rest = spec.slice('$lib/'.length)
      if (resolvesUnder(join(SRC, 'lib'), rest, exists)) continue
      if (overlays.some((root) => resolvesUnder(join(root, 'lib'), rest, exists))) {
        out.push(`${rel}: ${spec} (exists only in a modules/*/app overlay)`)
      }
    }
  }
  return out
}

// The boundary suite's own tests quote forbidden specifiers as string fixtures
// (that is how they prove their rules fire); they import none of them.
const EXEMPT_DIR = 'src/lib/server/boundary/'

function trackedKernelSources(): string[] {
  const listed = execFileSync('git', ['ls-files', '-z', '--', 'src'], { cwd: GREMION_UI, encoding: 'utf8' })
  return listed
    .split('\0')
    .filter((p) => /\.(ts|js|svelte)$/.test(p))
    .filter((p) => !p.startsWith(EXEMPT_DIR))
    .map((p) => join(GREMION_UI, p))
}

describe('kernel -> module imports (TASK-206-A §6.15)', () => {
  it('scans a non-empty set of tracked kernel files', () => {
    expect(trackedKernelSources().length).toBeGreaterThan(500)
  })

  it('no tracked gremion-ui/src file imports modules/**, $lib/server/finance/** or an overlay-only $lib path', () => {
    const overlays = overlayRoots()
    const violations = trackedKernelSources().flatMap((f) =>
      scanKernelFile(f, readFileSync(f, 'utf8'), existsSync, overlays),
    )
    expect(violations).toEqual([])
  })

  // Seeded RED: each rule must fire on a planted import, or the scan above is
  // green for the wrong reason.
  it.each([
    ["import { x } from '$lib/server/finance/officer-groups'", 'finance module server lib'],
    ["import { x } from '../../../../../modules/finance/app/lib/x'", 'repo-root modules/**'],
    ["const m = await import('$lib/server/overlay-only/thing')", 'exists only in a modules/*/app overlay'],
  ])('fires on a planted import: %s', (line, why) => {
    const file = join(SRC, 'lib', 'server', 'governance', 'planted.ts')
    const overlay = join(MODULES, 'planted', 'app')
    const exists: Exists = (p) => p === join(overlay, 'lib', 'server', 'overlay-only', 'thing.ts')
    const hits = scanKernelFile(file, line, exists, [overlay])
    expect(hits).toHaveLength(1)
    expect(hits[0]).toContain(why)
  })

  it('does not fire on kernel $lib paths, relative kernel paths or packages', () => {
    const file = join(SRC, 'lib', 'server', 'governance', 'planted.ts')
    const src = [
      "import { getDb } from '$lib/server/db'",
      "import { x } from './second-locus'",
      "import type { BrokerPort } from '@gremion/ports/broker'",
    ].join('\n')
    expect(scanKernelFile(file, src, existsSync, overlayRoots())).toEqual([])
  })
})
