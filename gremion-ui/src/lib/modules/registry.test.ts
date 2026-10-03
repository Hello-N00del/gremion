import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composePageAccess, moduleRoutePrefixes, composeCapabilities, MODULE_MANIFESTS } from './registry'
import { MODULE_MANIFESTS as GENERATED_MANIFESTS } from './manifests/index.generated'
import { Role } from '$lib/auth/types'

// gremion-ui/ package root (registry.test.ts lives at src/lib/modules/).
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CODEGEN = join(PKG_ROOT, 'scripts', 'build-module-manifest.mjs')
const GENERATED_BARREL = join(PKG_ROOT, 'src', 'lib', 'modules', 'manifests', 'index.generated.ts')

// The kernel ships two always-on manifests of its own — `core`
// (dashboard/settings/systemstatus) and `governance`
// (members/committees/portal/protokolle/beschluesse) — and the build composes the ENABLED module halves
// on top (TASK-205: gremion-ui/scripts/interim-module-overlay.mjs overlays modules/<id>/app onto src/
// before the manifest barrel is generated). Disabled modules (modules/disabled.json) contribute nothing.
// So every golden below is the composition of the enabled set; each module commit updates it in the same
// commit. TASK-205: elections, votes, calendar, files, messages, board (registration = `order` sequence).
const KERNEL_MANIFEST_IDS = ['core', 'governance'] as const
const MODULE_MANIFEST_IDS = ['elections', 'votes', 'calendar', 'files', 'messages', 'board'] as const
const COMPOSED_MANIFEST_IDS = [...KERNEL_MANIFEST_IDS, ...MODULE_MANIFEST_IDS] as const

describe('WP2-1 codegen — generated barrel is the single registration source', () => {
  // STALENESS GUARD: the committed index.generated.ts MUST byte-equal a fresh
  // codegen run. If a manifest file is added/removed/renamed (or its `order`
  // changes) without re-running `node scripts/build-module-manifest.mjs`, this
  // fails — the generated barrel cannot silently drift from manifests/*.ts.
  it('committed index.generated.ts byte-equals a fresh codegen --stdout run', () => {
    // Compare content, not line endings: the codegen always emits LF, but the
    // committed barrel may be checked out CRLF on Windows (core.autocrlf=true).
    // .gitattributes pins *.generated.ts to eol=lf so the working tree normally
    // matches; this normalization keeps the guard meaningful (it still catches
    // any real content/order drift) regardless of a contributor's checkout EOL.
    const norm = (s: string) => s.replace(/\r\n/g, '\n')
    const fresh = execFileSync('node', [CODEGEN, '--stdout'], { cwd: PKG_ROOT, encoding: 'utf-8' })
    const committed = readFileSync(GENERATED_BARREL, 'utf-8')
    expect(norm(committed)).toBe(norm(fresh))
  })

  // EXACT-ID-SET from the GENERATED barrel (not the hand list): the scan must
  // yield exactly these ids in this registration order. A mis-ordered or absent
  // barrel reds here.
  it('the generated barrel exposes exactly the fixed id set in registration order', () => {
    expect(GENERATED_MANIFESTS.map((m) => m.id)).toEqual([...COMPOSED_MANIFEST_IDS])
  })

  // The re-export seam (registry.ts → manifests/index.ts → index.generated.ts)
  // is the SAME array the generated barrel exposes — no second source of truth.
  it('MODULE_MANIFESTS (via registry) is the generated barrel array', () => {
    expect(MODULE_MANIFESTS).toBe(GENERATED_MANIFESTS)
    expect(MODULE_MANIFESTS.map((m) => m.id)).toEqual([...COMPOSED_MANIFEST_IDS])
  })

  // MODULE_MANIFESTS is a synchronously-available array (not a Promise) — the
  // codegen must not introduce any async/import.meta.glob lazy seam (acceptance c).
  it('MODULE_MANIFESTS is a sync array, not a Promise', () => {
    expect(Array.isArray(MODULE_MANIFESTS)).toBe(true)
    expect(typeof (MODULE_MANIFESTS as unknown as { then?: unknown }).then).toBe('undefined')
  })
})

describe('MODULE_MANIFESTS — barrel source order (P3-WP2)', () => {
  // Pin the manifest registration order. The barrel (manifests/index.ts) is the
  // single source of this order now; moduleRoutePrefixes() ordering depends on it.
  it('registers the manifests in the fixed source order', () => {
    expect(MODULE_MANIFESTS.map((m) => m.id)).toEqual([...COMPOSED_MANIFEST_IDS])
  })

  // The kernel's own manifests are always-on (toggleable:false); only module manifests may toggle.
  it('every kernel manifest is always-on (non-toggleable)', () => {
    expect(MODULE_MANIFESTS.filter((m) => (KERNEL_MANIFEST_IDS as readonly string[]).includes(m.id)).every((m) => m.toggleable === false)).toBe(true)
  })
})

// Golden snapshot of the composed PAGE_ACCESS map for the composed manifest set (auth/index.ts
// composePageAccess): the kernel's core + governance segments and the enabled modules' own.
const KERNEL_PAGE_ACCESS: Record<string, Role> = {
  // core
  dashboard: Role.Guest,
  settings: Role.Member,
  systemstatus: Role.ITAdmin,
  // governance
  members: Role.Member,
  committees: Role.Guest,
  portal: Role.CouncilAdmin,
  protokolle: Role.Guest,
  beschluesse: Role.Guest,
  // the composed modules (TASK-205): elections, votes (polls + votes), calendar, files, messages, board (tasks)
  elections: Role.Member,
  polls: Role.Member,
  votes: Role.Member,
  calendar: Role.Guest,
  files: Role.Member,
  messages: Role.Member,
  tasks: Role.Member,
}

describe('registry — composePageAccess (golden)', () => {
  it('reproduces the kernel PAGE_ACCESS map exactly', () => {
    expect(composePageAccess()).toEqual(KERNEL_PAGE_ACCESS)
  })
  it('has the same number of segments (no dup, no drop)', () => {
    expect(Object.keys(composePageAccess()).length).toBe(Object.keys(KERNEL_PAGE_ACCESS).length)
  })
})

describe('registry — moduleRoutePrefixes (golden vs hooks.server.ts)', () => {
  it('exposes exactly the toggleable modules route prefixes, in registration order (the kernel manifests add none)', () => {
    expect(moduleRoutePrefixes()).toEqual([
      { prefix: '/elections', moduleId: 'elections' },
      { prefix: '/api/elections', moduleId: 'elections' },
      { prefix: '/votes', moduleId: 'votes' },
      { prefix: '/polls', moduleId: 'votes' },
      { prefix: '/api/polls', moduleId: 'votes' },
      { prefix: '/calendar', moduleId: 'calendar' },
      { prefix: '/api/calendar', moduleId: 'calendar' },
      { prefix: '/tasks', moduleId: 'board' },
      { prefix: '/api/board', moduleId: 'board' },
    ])
  })
})

describe('registry — composeCapabilities (single composition seam)', () => {
  it('is empty while no composed manifest declares capabilities', () => {
    // core, governance, calendar, files and board declare no capabilities; concrete per-module
    // capability maps (e.g. finance.*) arrive with their modules.
    expect(composeCapabilities()).toEqual({})
  })
})

describe('registry — toggleable manifest ids are real config.modules keys', () => {
  // WP3-modules-dynamic: config.modules is now a dynamic open record, so the
  // invariant is "every toggleable manifest id is enabled-by-default in the
  // DERIVED defaultModulesConfig()". The governance-only kernel has no toggleable
  // manifests, so this iterates an empty set — the contract still holds vacuously
  // and re-asserts itself the moment a toggleable module is re-attached.
  it('every toggleable module id is present AND true in defaultModulesConfig()', async () => {
    const { defaultModulesConfig } = await import('$lib/server/config')
    const defaults = defaultModulesConfig()
    for (const m of MODULE_MANIFESTS.filter((x) => x.toggleable)) {
      expect(defaults[m.id]).toBe(true)
    }
  })
})
