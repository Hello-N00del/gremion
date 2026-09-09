import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Role } from '$lib/auth/types'
import type { ModuleManifest } from './types'
import type { NavItem } from '$lib/components/layout/nav-schema'

// ─────────────────────────────────────────────────────────────────────────────
// Pillar-3 (#203) WP4 — PLUG-IN PROOF (the D1+D2+D4 capstone).
//
// This is the executable companion to docs/playbooks/add-a-module.md. It proves
// the contract the playbook documents: a NET-NEW vertical module plugs into every
// composition seam — page-access, route-prefixes, capabilities, nav, realm,
// default config toggle, migration gating, and OFF→ON runtime catch-up — PURELY
// from its manifest, with ZERO edits to the shared composition files. And, when
// deselected, it is excluded from every one of those seams.
//
// `demo_vertical` below is a THROWAWAY manifest. It is DELIBERATELY NOT registered
// in the real barrel (gremion-ui/src/lib/modules/manifests/index.ts). We inject it
// into the seams exactly the way the existing golden tests do:
//
//   * The PURE, manifest-LIST-parameterised seams (composeNavSchema, composeRealm,
//     disabledModuleMigrationFiles, moduleReenableCatchup) — pass the mock list as
//     an argument. This is the registry.test/realm.test/nav-schema.test/
//     module-migrations.test idiom (a manifest array in, a composition out).
//
//   * The seams that read the GLOBAL MODULE_MANIFESTS (composePageAccess,
//     moduleRoutePrefixes, composeCapabilities, defaultModulesConfig, and via
//     moduleRoutePrefixes the module-gate) — vi.doMock the manifests barrel
//     ('$lib/modules/manifests') so the global set INCLUDES the mock. This mirrors
//     the WP3 demo_widget suite in config.test.ts (which doMocks
//     '$lib/modules/registry' to inject a net-new prefix into the
//     moduleRoutePrefixes seam).
//
// NOTE ON SEAM COVERAGE: every seam under test is reachable with the mock without
// any signature change, so there is NO real-manifest-only fallback here. The seams
// that expose only the global set (composePageAccess / composeCapabilities /
// moduleRoutePrefixes take no manifest arg) are covered by mocking the barrel —
// see the "global-seam" describe block.
// ─────────────────────────────────────────────────────────────────────────────

// The throwaway net-new toggleable vertical. Carries one of EVERY manifest field
// the playbook enumerates: pages, routePrefixes, groups, capabilities, migrations,
// a realm fragment, and a nav fragment (a whole section, anchored at its own id).
const demoVerticalManifest: ModuleManifest = {
  id: 'demo_vertical',
  toggleable: true,
  pages: [
    { segment: 'demo-vertical', minRole: Role.Member },
    { segment: 'demo-vertical-admin', minRole: Role.ITAdmin },
  ],
  routePrefixes: ['/demo-vertical', '/api/demo-vertical'],
  groups: { base: 'demo-vertical', admin: 'demo-vertical-admin' },
  capabilities: {
    'demo_vertical.view': ['demo-vertical', 'admin'],
    'demo_vertical.manage': ['demo-vertical-admin', 'admin'],
  },
  migrations: ['900_demo_vertical_schema', '901_demo_vertical_indexes'],
  realm: {
    groups: [
      { name: 'demo-vertical', path: '/demo-vertical' },
      { name: 'demo-vertical-admin', path: '/demo-vertical-admin' },
    ],
    realmRoles: [{ name: 'demo-vertical', description: 'Demo vertical — proof module (#203 WP4)' }],
  },
  // A whole top-level section, woven in at the demo_vertical anchor (added to the
  // base template only inside THIS test's local base, never the real baseNavSchema).
  nav: [
    {
      kind: 'section',
      label: 'Demo-Vertical',
      moduleId: 'demo_vertical',
      children: [
        { kind: 'item', href: '/demo-vertical', label: 'Demo-Vertical', icon: 'beaker', role: Role.Member, moduleId: 'demo_vertical' },
      ],
    } satisfies NavItem,
  ],
}

// The minimal config helper used by the manifest-LIST seams (composeRealm /
// disabledModuleMigrationFiles / moduleReenableCatchup all read config.modules).
const cfg = (demo_vertical: boolean) => ({ modules: { demo_vertical } }) as any

// ════════════════════════════════════════════════════════════════════════════
// SEAMS THAT ACCEPT A MANIFEST LIST (pure functions — pass the mock directly).
// No barrel mock needed; this is the registry/realm/nav/migration test idiom.
// ════════════════════════════════════════════════════════════════════════════

describe('WP4 plug-in proof — composeNavSchema (nav fragment at the module anchor)', () => {
  // A LOCAL base template carrying a slot for demo_vertical. The real
  // baseNavSchema is NOT touched — this proves nav composition is purely a
  // manifest+anchor concern (D1: a new module contributes nav with no shared edit).
  it('WHEN ENABLED: weaves the demo_vertical nav section in at its anchor', async () => {
    const { composeNavSchema } = await import('$lib/components/layout/nav-schema')
    // Local base with the demo_vertical anchor. (ModuleNavSlot is intentionally
    // off the NavItem union; cast through the template-entry parameter shape the
    // production baseNavSchema uses.)
    const base = [
      { kind: 'section', label: 'Arbeitsbereich', children: [] },
      { slot: 'module', moduleId: 'demo_vertical' },
    ] as Parameters<typeof composeNavSchema>[0]
    const out = composeNavSchema(base, [demoVerticalManifest])
    const labels = out.map((i) => i.label)
    expect(labels).toContain('Demo-Vertical')
    const section = out.find((i) => i.kind === 'section' && i.label === 'Demo-Vertical')
    expect(section?.kind).toBe('section')
    if (section?.kind === 'section') {
      expect(section.children.map((c) => c.label)).toEqual(['Demo-Vertical'])
    }
  })

  it('WHEN DISABLED (manifest absent from the set): the anchor resolves to nothing — the rail entry vanishes with the module', async () => {
    const { composeNavSchema } = await import('$lib/components/layout/nav-schema')
    const base = [
      { kind: 'section', label: 'Arbeitsbereich', children: [] },
      { slot: 'module', moduleId: 'demo_vertical' },
    ] as Parameters<typeof composeNavSchema>[0]
    // The module is not in the set (a deselected vertical never registers it) →
    // composeNavSchema finds no nav for the anchor and the slot disappears.
    const out = composeNavSchema(base, [])
    expect(out.map((i) => i.label)).not.toContain('Demo-Vertical')
  })
})

describe('WP4 plug-in proof — composeRealm (KC groups + roles only when enabled)', () => {
  const base = {
    groups: [{ name: 'login', path: '/login' }],
    roles: { realm: [{ name: 'member', description: 'Member' }] },
    scopeMappings: [{ client: 'gremion-ui', roles: ['member'] }],
  } as any

  it('WHEN ENABLED: injects the demo_vertical groups + realm-role + scope-mapping', async () => {
    const { composeRealm } = await import('./realm')
    const out = composeRealm(base, [demoVerticalManifest], cfg(true))
    expect(out.groups.map((g: any) => g.name)).toEqual(
      expect.arrayContaining(['demo-vertical', 'demo-vertical-admin']),
    )
    expect(out.roles.realm.map((r: any) => r.name)).toContain('demo-vertical')
    // #254: the role reaches first-party client tokens via the scope mapping.
    const ui = (out.scopeMappings ?? []).find((sm: any) => sm.client === 'gremion-ui')
    expect(ui?.roles).toContain('demo-vertical')
  })

  it('WHEN DISABLED: contributes no groups, no realm-role, no scope-mapping entry', async () => {
    const { composeRealm } = await import('./realm')
    const out = composeRealm(base, [demoVerticalManifest], cfg(false))
    expect(out.groups.map((g: any) => g.name)).not.toContain('demo-vertical')
    expect(out.roles.realm.map((r: any) => r.name)).not.toContain('demo-vertical')
    for (const sm of out.scopeMappings ?? []) {
      expect(sm.roles).not.toContain('demo-vertical')
    }
  })
})

describe('WP4 plug-in proof — migration gating + OFF→ON runtime catch-up (WP5)', () => {
  it('WHEN DISABLED on a FRESH init: the module migrations are skipped (disabledModuleMigrationFiles)', async () => {
    const { disabledModuleMigrationFiles } = await import('$lib/server/module-migrations')
    expect(disabledModuleMigrationFiles(cfg(false), [demoVerticalManifest])).toEqual(
      new Set(['900_demo_vertical_schema.sql', '901_demo_vertical_indexes.sql']),
    )
  })

  it('WHEN ENABLED on a FRESH init: nothing is skipped (the forward apply loop handles it)', async () => {
    const { disabledModuleMigrationFiles } = await import('$lib/server/module-migrations')
    expect(disabledModuleMigrationFiles(cfg(true), [demoVerticalManifest])).toEqual(new Set())
  })

  it('WHEN re-enabled OFF→ON (non-fresh DB, none of its migrations applied): plans its catch-up files in filename order', async () => {
    const { moduleReenableCatchup } = await import('$lib/server/module-migrations')
    expect(
      moduleReenableCatchup({
        isFreshDb: false,
        applied: new Set(['001_governance_schema.sql']),
        config: cfg(true),
        manifests: [demoVerticalManifest],
      }),
    ).toEqual([
      { moduleId: 'demo_vertical', files: ['900_demo_vertical_schema.sql', '901_demo_vertical_indexes.sql'] },
    ])
  })

  it('WHEN still DISABLED on a non-fresh DB: plans no catch-up (the ON→OFF / stay-OFF retain policy)', async () => {
    const { moduleReenableCatchup } = await import('$lib/server/module-migrations')
    expect(
      moduleReenableCatchup({
        isFreshDb: false,
        applied: new Set(),
        config: cfg(false),
        manifests: [demoVerticalManifest],
      }),
    ).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// SEAMS THAT READ THE GLOBAL MODULE_MANIFESTS (mock the barrel to include the
// mock manifest). composePageAccess / moduleRoutePrefixes / composeCapabilities
// take no manifest arg, and defaultModulesConfig() sources its ids from the
// global set — so we extend the global set via the barrel mock, the WP3 idiom.
// ════════════════════════════════════════════════════════════════════════════

describe('WP4 plug-in proof — global-seam composition with demo_vertical registered in the barrel', () => {
  // vi.doMock the manifests barrel so registry.ts (and config.ts → registry) see
  // the REAL five manifests PLUS demo_vertical. The factory imports the real
  // manifest files directly (the barrel itself is what we replace), so this is a
  // faithful "as if it were registered" injection without editing index.ts.
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.doUnmock('$lib/modules/manifests')
    vi.resetModules()
  })

  async function registryWithDemo() {
    // Inject demo_vertical alongside the kernel manifests (core, governance).
    // The carved-out feature manifests (finance/elections/content/newsletter/
    // users) are gone, so this is the full "as if registered" set in the
    // governance-only kernel.
    vi.doMock('$lib/modules/manifests', async () => {
      const { coreManifest } = await import('./manifests/core')
      const { governanceManifest } = await import('./manifests/governance')
      return {
        MODULE_MANIFESTS: [
          coreManifest, governanceManifest,
          demoVerticalManifest,
        ],
      }
    })
    return import('./registry')
  }

  it('WHEN ENABLED: composePageAccess includes the demo_vertical page segments', async () => {
    const { composePageAccess } = await registryWithDemo()
    const access = composePageAccess()
    expect(access['demo-vertical']).toBe(Role.Member)
    expect(access['demo-vertical-admin']).toBe(Role.ITAdmin)
    // The kernel segments still compose alongside it (no shared-file edit needed).
    expect(access['committees']).toBe(Role.Guest)
  })

  it('WHEN ENABLED: moduleRoutePrefixes includes the demo_vertical prefixes', async () => {
    const { moduleRoutePrefixes } = await registryWithDemo()
    expect(moduleRoutePrefixes()).toEqual(
      expect.arrayContaining([
        { prefix: '/demo-vertical', moduleId: 'demo_vertical' },
        { prefix: '/api/demo-vertical', moduleId: 'demo_vertical' },
      ]),
    )
  })

  it('WHEN ENABLED: composeCapabilities includes the demo_vertical capabilities', async () => {
    const { composeCapabilities } = await registryWithDemo()
    const caps = composeCapabilities()
    expect(caps['demo_vertical.view']).toEqual(['demo-vertical', 'admin'])
    expect(caps['demo_vertical.manage']).toEqual(['demo-vertical-admin', 'admin'])
  })

  it('WHEN ENABLED: defaultModulesConfig() force-ons demo_vertical with no config.ts edit', async () => {
    await registryWithDemo()
    const { defaultModulesConfig } = await import('$lib/server/config')
    expect(defaultModulesConfig().demo_vertical).toBe(true)
  })

  it('WHEN DISABLED: the module-gate 403s the demo_vertical prefix via moduleRoutePrefixes', async () => {
    await registryWithDemo()
    const { disabledModuleForPath } = await import('$lib/server/module-gate')
    const config = {
      modules: {
        demo_vertical: false,
      },
    } as any
    expect(disabledModuleForPath('/api/demo-vertical/things', config)).toBe('demo_vertical')
    expect(disabledModuleForPath('/demo-vertical/page', config)).toBe('demo_vertical')
    // ENABLED → the gate passes (null).
    const enabled = { modules: { ...config.modules, demo_vertical: true } } as any
    expect(disabledModuleForPath('/api/demo-vertical/things', enabled)).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// DELIVERABLE C — DESELECT PROOF (D4): disabling a toggleable module
// (demo_vertical) removes it from nav + page-access + capabilities + realm +
// route-prefixes, with ZERO shared-file edits — purely via config / the manifest
// set. (In the governance-only kernel there is no real feature module to drop, so
// the throwaway demo_vertical proves the contract; the two always-on kernel
// manifests core/governance are non-toggleable and never deselect.)
// ════════════════════════════════════════════════════════════════════════════

describe('WP4 deselect proof (D4) — a toggleable module dropped with zero shared-file edits', () => {
  afterEach(() => {
    vi.doUnmock('$lib/modules/manifests')
    vi.resetModules()
  })

  it('nav: composeNavSchema over a set WITHOUT demo_vertical resolves its anchor to nothing', async () => {
    const { composeNavSchema } = await import('$lib/components/layout/nav-schema')
    const base = [
      { kind: 'section', label: 'Arbeitsbereich', children: [] },
      { slot: 'module', moduleId: 'demo_vertical' },
    ] as Parameters<typeof composeNavSchema>[0]
    // The deselecting vertical never registers demo_vertical — its anchor
    // resolves to nothing, so its section vanishes.
    const out = composeNavSchema(base, [])
    expect(out.map((i) => i.label)).not.toContain('Demo-Vertical')
  })

  it('nav (runtime gate): filterNavForSession hides the module section when it is in disabledModules', async () => {
    const { composeNavSchema, filterNavForSession } = await import('$lib/components/layout/nav-schema')
    const base = [
      { kind: 'section', label: 'Arbeitsbereich', children: [] },
      { slot: 'module', moduleId: 'demo_vertical' },
    ] as Parameters<typeof composeNavSchema>[0]
    const schema = composeNavSchema(base, [demoVerticalManifest])
    const gateHelpers = { hasAny: () => true, canApproveAny: () => true } as any
    const allRoles = [Role.ITAdmin, Role.CouncilAdmin, Role.Member, Role.Guest]
    const nav = filterNavForSession(schema, gateHelpers, allRoles, new Set(['demo_vertical']))
    const labels = nav.flatMap((s) => (s.kind === 'section' ? [s.label, ...s.children.map((c) => c.label)] : [s.label]))
    expect(labels).not.toContain('Demo-Vertical')
  })

  it('page-access + capabilities + route-prefixes: composing a set WITHOUT demo_vertical drops every demo surface', async () => {
    vi.resetModules()
    vi.doMock('$lib/modules/manifests', async () => {
      const { coreManifest } = await import('./manifests/core')
      const { governanceManifest } = await import('./manifests/governance')
      // demo_vertical OMITTED — the deselect. Only the kernel manifests remain.
      return { MODULE_MANIFESTS: [coreManifest, governanceManifest] }
    })
    const { composePageAccess, composeCapabilities, moduleRoutePrefixes } = await import('./registry')

    // page-access: no demo-vertical segment.
    expect('demo-vertical' in composePageAccess()).toBe(false)
    // capabilities: no toggleable contributor today → empty map.
    expect(composeCapabilities()).toEqual({})
    // route-prefixes: no demo prefixes (the kernel manifests declare none).
    const prefixes = moduleRoutePrefixes()
    expect(prefixes.some((p) => p.moduleId === 'demo_vertical')).toBe(false)
    expect(prefixes).toEqual([])
  })

  it('realm: composeRealm with demo_vertical DISABLED omits its groups + realm-role', async () => {
    const { composeRealm } = await import('./realm')
    const base = {
      groups: [{ name: 'login', path: '/login' }],
      roles: { realm: [{ name: 'member', description: 'Member' }] },
      scopeMappings: [{ client: 'gremion-ui', roles: ['member'] }],
    } as any
    const out = composeRealm(base, [demoVerticalManifest], cfg(false))
    expect(out.groups.map((g: any) => g.name)).not.toContain('demo-vertical')
    expect(out.roles.realm.map((r: any) => r.name)).not.toContain('demo-vertical')
  })
})
