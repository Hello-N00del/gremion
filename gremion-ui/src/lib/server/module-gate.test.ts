import { describe, expect, it, vi } from 'vitest'
import type { GremionConfig } from '$lib/server/config'

// #256-1: the module-disable gate extracted from hooks.server.ts so the Bearer
// branch and the cookie-session path enforce the SAME route-prefix 403.
//
// Carve note: the governance-only kernel ships no toggleable feature modules, so
// the real moduleRoutePrefixes() is empty and nothing is gated by construction.
// To exercise the gate MECHANISM we inject a synthetic toggleable module's prefix
// via the registry seam (the WP3 idiom from config.test.ts) — proving the gate
// still 403s a disabled module and passes an enabled one, so a re-attached module
// gates exactly as before.

vi.mock('$env/dynamic/private', () => ({ env: {} }))
const mockReadConfig = vi.fn()
vi.mock('$lib/server/config', () => ({ readConfig: () => mockReadConfig() }))

// Inject a synthetic module prefix set into the gate's only registry dependency.
vi.mock('$lib/modules/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/modules/registry')>()
  return {
    ...actual,
    moduleRoutePrefixes: () => [
      { prefix: '/demo-widget', moduleId: 'demo_widget' },
      { prefix: '/api/demo-widget', moduleId: 'demo_widget' },
      { prefix: '/finance', moduleId: 'finance' },
      { prefix: '/api/finance', moduleId: 'finance' },
    ],
  }
})

import { moduleGateResponse } from './module-gate'

function cfg(modules: Partial<GremionConfig['modules']>): GremionConfig {
  return {
    modules: {
      demo_widget: true,
      finance: true,
      ...modules,
    },
    // WP3-modules-dynamic: GremionConfig.modules widened to Record<string, boolean>,
    // so a bare { modules } object no longer structurally overlaps GremionConfig
    // enough for a direct `as` — go via `unknown` (this is a partial test stub).
  } as unknown as GremionConfig
}

describe('moduleGateResponse (#256-1)', () => {
  it('403s a disabled module PAGE prefix', async () => {
    const res = moduleGateResponse('/demo-widget/things', cfg({ demo_widget: false }))
    expect(res?.status).toBe(403)
    expect(await res?.text()).toBe('Module disabled')
  })

  it('403s a disabled module /api prefix', () => {
    expect(moduleGateResponse('/api/demo-widget/things', cfg({ demo_widget: false }))?.status).toBe(403)
  })

  it('passes (null) when the module is enabled', () => {
    expect(moduleGateResponse('/api/demo-widget/things', cfg({ demo_widget: true }))).toBeNull()
    expect(moduleGateResponse('/demo-widget', cfg({ demo_widget: true }))).toBeNull()
  })

  it('passes (null) for a non-module path regardless of toggles', () => {
    expect(moduleGateResponse('/dashboard', cfg({ demo_widget: false }))).toBeNull()
    expect(moduleGateResponse('/api/governance/committees', cfg({ demo_widget: false }))).toBeNull()
  })

  it('defaults its config to readConfig() — the ALS-resolved CURRENT tenant', () => {
    mockReadConfig.mockReturnValue(cfg({ demo_widget: false }))
    expect(moduleGateResponse('/api/demo-widget/things')?.status).toBe(403)
    expect(mockReadConfig).toHaveBeenCalled()
  })

  // gremion#22 finding 2 (MED, segment-boundary bypass): a naive `startsWith`
  // let a sibling path like '/financex' match the '/finance' gate. The fix
  // requires an exact match OR a '/' boundary right after the prefix.
  describe('segment-boundary prefix matching', () => {
    it("does NOT match '/financex' against the '/finance' gate", () => {
      expect(moduleGateResponse('/financex', cfg({ finance: false }))).toBeNull()
      expect(moduleGateResponse('/api/financexyz', cfg({ finance: false }))).toBeNull()
    })

    it("still 403s '/finance' exactly and its sub-paths when disabled", () => {
      expect(moduleGateResponse('/finance', cfg({ finance: false }))?.status).toBe(403)
      expect(moduleGateResponse('/finance/budgets', cfg({ finance: false }))?.status).toBe(403)
      expect(moduleGateResponse('/api/finance/budgets', cfg({ finance: false }))?.status).toBe(403)
    })

    it('does not gate a sibling path that merely shares a prefix string', () => {
      expect(moduleGateResponse('/demo-widgetxyz', cfg({ demo_widget: false }))).toBeNull()
    })
  })
})
