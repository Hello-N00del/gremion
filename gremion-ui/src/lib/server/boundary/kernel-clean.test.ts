// open-core boundary BACKSTOP (2026-06-30, Session-A capstone).
//
// The per-rule import-scan (boundary/rules.ts + boundary-real-tree.test.ts)
// guards only the specific source dirs someone remembered to add a rule for.
// That is how the carve-boundary map originally MISSED several kernel→feature
// couplings (settings/+layout→finance, setup/health→messages+files, and the
// protocol/dashboard ones). This test is the COMPREHENSIVE catch-all: it walks
// EVERY kernel source file and asserts it imports ZERO feature-module code, so a
// future straggler cannot hide. It is the single artifact that would have caught
// all of them at once.
//
// Principle (architecture §5): dependency direction — the kernel (everything that
// is NOT a feature module) may never import a feature module. Feature-module code
// may import its own/sibling module freely; that is why module-owned dirs are
// EXEMPT as importers. The kernel keeps importing only the SDK seams
// (modules/registry, modules/types, the runtime-registry) + each module's
// register.server.ts is a sanctioned composition root (it imports the module to
// register it — like hooks → server-init.generated).
import { describe, it, expect } from 'vitest'
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const GREMION_UI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const SRC = join(GREMION_UI, 'src')

// A specifier that resolves into one of these = importing a FEATURE MODULE.
//
// Post-carve: the feature-module dirs have been git-rm'd, so a kernel file can no
// longer actually resolve any of these. The list is RETAINED as the catch-all
// target set so that if a feature module is ever re-added in-tree and a kernel
// file imports it, this backstop reds immediately (the test still walks every
// kernel file). The `lib/votes`/`lib/finance`/component targets stay for the same
// reason.
const FEATURE_TARGETS = [
  'lib/server/finance', 'lib/server/elections', 'lib/server/content',
  'lib/server/newsletter', 'lib/server/calendar', 'lib/server/files',
  'lib/server/messages',
  'lib/finance', 'lib/votes',
  'lib/modules/finance',
  'lib/modules/manifests/finance', 'lib/modules/manifests/elections',
  'lib/modules/manifests/content', 'lib/modules/manifests/newsletter',
  'lib/modules/manifests/users',
  'lib/components/finance', 'lib/components/calendar', 'lib/components/messages',
  'lib/components/files', 'lib/components/ballot', 'lib/components/polls',
  'lib/stores/matrix.ts', 'lib/stores/calendar.ts', 'lib/stores/call-store.svelte.ts',
  'lib/components/VideoCallPip.svelte',
]

// Files UNDER these prefixes are module-owned (or sanctioned composition roots):
// they may import feature-module code. Everything else is KERNEL. Post-carve
// these dirs are deleted, so the list is a no-op today; it is retained so a
// re-added feature module's own files are correctly EXEMPT as importers (and the
// kernel-vs-module boundary stays a single source of truth).
const MODULE_OWNER_PREFIXES = [
  // server-lib module roots
  'lib/server/finance', 'lib/server/elections', 'lib/server/content',
  'lib/server/newsletter', 'lib/server/calendar', 'lib/server/files',
  'lib/server/messages',
  // client/lib module roots
  'lib/finance', 'lib/votes', 'lib/files', 'lib/modules/finance',
  'lib/modules/manifests/finance', 'lib/modules/manifests/elections',
  'lib/modules/manifests/content', 'lib/modules/manifests/newsletter',
  'lib/modules/manifests/users',
  'lib/components/finance', 'lib/components/calendar', 'lib/components/messages',
  'lib/components/files', 'lib/components/ballot', 'lib/components/polls',
  'lib/components/news',
  'lib/stores/matrix.ts', 'lib/stores/calendar.ts', 'lib/stores/call-store.svelte.ts',
  'lib/components/VideoCallPip.svelte',
  // route module roots (the module's own UI + API)
  'routes/finance', 'routes/calendar', 'routes/messages', 'routes/files',
  'routes/elections', 'routes/votes', 'routes/polls', 'routes/content',
  'routes/newsletter', 'routes/users', 'routes/element-call', 'routes/livekit',
  'routes/api/finance', 'routes/api/calendar', 'routes/api/messages',
  'routes/api/video', 'routes/api/elections', 'routes/api/polls',
  'routes/api/content', 'routes/api/newsletter', 'routes/api/files',
  'routes/api/users', 'routes/api/internal/newsletter',
  'routes/api/auth/matrix-token', 'routes/api/auth/matrix-device',
]

// Sanctioned composition roots: a kernel file that imports modules BY DESIGN to
// wire them (mirrors boundary/rules.ts COMPOSITION_ROOTS). Each module's
// register.server.ts self-registers into the runtime-registry; the seed root and
// the generated barrel compose modules.
const COMPOSITION_ROOT_SUFFIXES = ['/register.server.ts', '.generated.ts']
const COMPOSITION_ROOT_PREFIXES = ['lib/server/seed', 'lib/server/boundary']

// DOCUMENTED kernel→feature exceptions (each a deliberate, tracked debt). NO new
// entries without sign-off — every entry must be justified here.
//
// Post-carve this set is EMPTY: the three carve-time couplings it documented
// (routes/news/[id]/edit, storage/index.ts's Nextcloud branch, storage/nextcloud.ts)
// are all resolved — the first two routes/files were git-rm'd with their modules
// and storage/index.ts now defaults to LocalStorageBackend with no files import.
// The stale-ALLOW guard below ENFORCES that this stays empty: any entry whose file
// no longer imports a feature module fails the test.
const ALLOW: Record<string, string> = {}

function rel(abs: string): string {
  return relative(SRC, abs).split('\\').join('/')
}
function underAny(p: string, prefixes: string[]): boolean {
  return prefixes.some((pre) =>
    pre.endsWith('.ts') || pre.endsWith('.svelte')
      ? p === pre
      : p === pre || p.startsWith(pre + '/'),
  )
}
function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}
function importsFeatureModule(content: string, importerRel: string): string | null {
  // $lib/... and relative specifiers, resolved to an src-relative path.
  const re = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  let m: RegExpExecArray | null
  const importerDir = dirname(importerRel)
  while ((m = re.exec(content)) !== null) {
    const spec = m[1] ?? m[2]
    if (!spec) continue
    let target: string | null = null
    if (spec.startsWith('$lib/')) target = 'lib/' + spec.slice('$lib/'.length)
    else if (spec.startsWith('./') || spec.startsWith('../')) {
      target = join(importerDir, spec).split('\\').join('/')
    }
    if (!target) continue
    if (FEATURE_TARGETS.some((t) => target === t || target!.startsWith(t + '/'))) return spec
  }
  return null
}

describe('open-core boundary backstop — no kernel file imports a feature module', () => {
  it('every kernel src file imports zero feature-module code (except documented allows)', () => {
    const violations: { file: string; specifier: string }[] = []
    if (!existsSync(SRC)) throw new Error('src/ not found — path regression')
    let scanned = 0
    for (const abs of walk(SRC)) {
      if (!abs.endsWith('.ts') && !abs.endsWith('.svelte')) continue
      const r = rel(abs)
      if (r.endsWith('.test.ts') || r.endsWith('.spec.ts') || r.endsWith('.d.ts')) continue
      // skip module-owned files + composition roots — they may import modules.
      if (underAny(r, MODULE_OWNER_PREFIXES)) continue
      if (COMPOSITION_ROOT_SUFFIXES.some((s) => r.endsWith(s))) continue
      if (underAny(r, COMPOSITION_ROOT_PREFIXES)) continue
      scanned++
      const spec = importsFeatureModule(readFileSync(abs, 'utf8'), r)
      if (spec) violations.push({ file: r, specifier: spec })
    }
    // Floor lowered post-carve: removing the feature-module dirs dropped the
    // kernel src count from ~430 to ~253. 200 keeps the guard non-vacuous (the
    // test still walks every one of the ~253 kernel files and reds on any real
    // feature import) with headroom so ordinary kernel churn doesn't trip it,
    // while still catching a path regression that wiped out most of the tree.
    expect(scanned, 'scanned suspiciously few kernel files — path regression?').toBeGreaterThan(200)
    const unexpected = violations.filter((v) => !(v.file in ALLOW))
    expect(
      unexpected,
      `Kernel→feature-module import(s) found (dependency-direction violation):\n` +
        unexpected.map((v) => `  ${v.file}  →  ${v.specifier}`).join('\n') +
        `\nEither invert the dependency (registry seam) or, with sign-off, add a documented ALLOW entry.`,
    ).toEqual([])
    // Keep ALLOW honest: every documented exception must still actually import a
    // feature module (else it is stale and should be removed).
    const stale = Object.keys(ALLOW).filter((f) => !violations.some((v) => v.file === f))
    expect(stale, `stale ALLOW entries (no longer import a feature module): ${stale.join(', ')}`).toEqual([])
  })
})
