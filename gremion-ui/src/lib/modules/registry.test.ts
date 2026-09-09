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

// Carve note: the governance-only kernel ships exactly two always-on manifests —
// `core` (dashboard/settings/systemstatus) and `governance`
// (members/committees/portal/protokolle/beschluesse). The former toggleable
// feature manifests (finance/elections/content/newsletter/users) are carved out,
// so every golden below is the [core, governance] composition.
const KERNEL_MANIFEST_IDS = ['core', 'governance'] as const

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
    expect(GENERATED_MANIFESTS.map((m) => m.id)).toEqual([...KERNEL_MANIFEST_IDS])
  })

  // The re-export seam (registry.ts → manifests/index.ts → index.generated.ts)
  // is the SAME array the generated barrel exposes — no second source of truth.
  it('MODULE_MANIFESTS (via registry) is the generated barrel array', () => {
    expect(MODULE_MANIFESTS).toBe(GENERATED_MANIFESTS)
    expect(MODULE_MANIFESTS.map((m) => m.id)).toEqual([...KERNEL_MANIFEST_IDS])
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
    expect(MODULE_MANIFESTS.map((m) => m.id)).toEqual([...KERNEL_MANIFEST_IDS])
  })

  // Both kernel manifests are always-on (toggleable:false) — there are no
  // toggleable feature modules in the governance-only kernel.
  it('every kernel manifest is always-on (non-toggleable)', () => {
    expect(MODULE_MANIFESTS.every((m) => m.toggleable === false)).toBe(true)
  })
})

// Golden snapshot of the composed PAGE_ACCESS map for the [core, governance]
// kernel (auth/index.ts composePageAccess). Carved feature segments
// (files/messages/calendar/elections/polls/votes/finance/newsletter/users/tasks/
// news/content) are gone with their modules.
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
  it('exposes no module-disable route prefixes (kernel has no toggleable modules)', () => {
    expect(moduleRoutePrefixes()).toEqual([])
  })
})

describe('registry — composeCapabilities (single composition seam)', () => {
  it('is empty in the governance-only kernel (no manifest declares capabilities)', () => {
    // core + governance declare no capabilities; concrete per-module capability
    // maps (e.g. finance.*) arrive with their modules.
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
