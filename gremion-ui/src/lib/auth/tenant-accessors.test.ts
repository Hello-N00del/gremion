// P2.2-auth A4 (D-CONST) — per-tenant PAGE_ACCESS/CAPABILITIES accessors.
//
// `pageAccessForTenant(ctx)` / `capabilitiesForTenant(ctx)` are what
// canAccess/nav/guards consume going forward. Pins:
//   • DEFAULT tenant (no `config.roles` override — every existing config)
//     resolves to the SAME golden objects (referential, tenant #1
//     byte-identical, D-CONST);
//   • an override tenant routes through the vocabulary-arg compose seam and
//     gets a DISTINCT object (no shared mutable map across tenants) whose
//     content is identical TODAY (composition is vocabulary-independent until
//     P2.3 supplies per-tenant shaping);
//   • absent-vs-present semantics AGREE with the A1 seam
//     (roleVocabularyForTenant): only an ABSENT override means default;
//     an explicit [] is a narrowing override (single-source guard);
//   • `canAccess` / `makeAuthHelpers` accept the tenant maps as optional
//     args defaulting to the golden constants (existing call sites
//     byte-identical — the golden suites stay green untouched).
//
// Note: the accessors take the ctx EXPLICITLY (parameter-passing, no ALS read),
// so no runWithTenant scope is needed here — these tests never rely on any
// ambient/default tenant.
import { describe, it, expect } from 'vitest'
import { PAGE_ACCESS, canAccess, pageAccessForTenant, Role } from './index'
import { CAPABILITIES, capabilitiesForTenant, type CapabilityId } from './capabilities'
import { makeAuthHelpers } from './group-helpers'
import type { TenantVocabularySource } from './types'
import { composePageAccess, composeCapabilities } from '$lib/modules/registry'
import { roleVocabularyForTenant, type VocabularyTenant } from '$lib/server/tenant/role-vocabulary'
import type { TenantContext } from '$lib/server/tenant/context'

// Satisfies BOTH seam types — the client-safe accessor slice (lib/auth) and the
// server vocabulary seam (A1) — pinning that one ctx literal feeds both.
const ctxWith = (roles?: string[]): TenantVocabularySource & VocabularyTenant =>
  roles === undefined ? { config: {} } : { config: { roles } }

const NARROWED = ['guest', 'member', 'buergermeister']

describe('pageAccessForTenant (D-CONST accessor)', () => {
  it('default tenant (no config.roles) resolves to the SAME golden PAGE_ACCESS object (referential pin)', () => {
    expect(pageAccessForTenant(ctxWith())).toBe(PAGE_ACCESS)
  })

  it('an override tenant composes a DISTINCT map — never the shared golden object', () => {
    const m = pageAccessForTenant(ctxWith(NARROWED))
    expect(m).not.toBe(PAGE_ACCESS)
    // Content identical TODAY: composition is vocabulary-independent until P2.3.
    expect(m).toEqual(PAGE_ACCESS)
  })

  it('an explicit empty override is an OVERRIDE, not the default (?? catches only ABSENT)', () => {
    expect(pageAccessForTenant(ctxWith([]))).not.toBe(PAGE_ACCESS)
  })

  it('agrees with the A1 vocabulary seam for absent/override/empty (single-source guard)', () => {
    for (const ctx of [ctxWith(), ctxWith(NARROWED), ctxWith([])]) {
      expect(pageAccessForTenant(ctx)).toEqual(
        composePageAccess(roleVocabularyForTenant(ctx)),
      )
    }
  })

  it('accepts a full TenantContext (compile-time assignability pin)', () => {
    const accepts: (ctx: TenantContext) => Record<string, Role> = pageAccessForTenant
    expect(accepts).toBe(pageAccessForTenant)
  })
})

describe('capabilitiesForTenant (D-CONST accessor)', () => {
  it('default tenant resolves to the SAME golden CAPABILITIES object (referential pin)', () => {
    expect(capabilitiesForTenant(ctxWith())).toBe(CAPABILITIES)
  })

  it('an override tenant composes a DISTINCT map — never the shared golden object', () => {
    const caps = capabilitiesForTenant(ctxWith(NARROWED))
    expect(caps).not.toBe(CAPABILITIES)
    // Content identical TODAY (capabilities are GROUP-keyed; P2.3 owns shaping).
    expect(caps).toEqual(CAPABILITIES)
  })

  it('agrees with the A1 vocabulary seam for absent/override/empty (single-source guard)', () => {
    for (const ctx of [ctxWith(), ctxWith(NARROWED), ctxWith([])]) {
      expect(capabilitiesForTenant(ctx)).toEqual(
        composeCapabilities(roleVocabularyForTenant(ctx)),
      )
    }
  })

  it('accepts a full TenantContext (compile-time assignability pin)', () => {
    const accepts: (ctx: TenantContext) => Record<CapabilityId, readonly string[]> =
      capabilitiesForTenant
    expect(accepts).toBe(capabilitiesForTenant)
  })
})

describe('canAccess routes through a tenant page-access map (optional 3rd arg)', () => {
  it('without the arg behaves exactly as before (golden default — existing call sites byte-identical)', () => {
    expect(canAccess([Role.Member], 'settings')).toBe(true)
    expect(canAccess([Role.Guest], 'settings')).toBe(false)
  })

  it('consults the PROVIDED map instead of the golden one', () => {
    const tenantMap: Record<string, Role> = { ...PAGE_ACCESS, settings: Role.ITAdmin }
    expect(canAccess([Role.Member], 'settings', tenantMap)).toBe(false)
    expect(canAccess([Role.ITAdmin], 'settings', tenantMap)).toBe(true)
  })

  it('default-tenant accessor output gives the same decisions as the no-arg path', () => {
    const m = pageAccessForTenant(ctxWith())
    expect(canAccess([Role.Member], 'settings', m)).toBe(canAccess([Role.Member], 'settings'))
    expect(canAccess([Role.Guest], 'dashboard', m)).toBe(canAccess([Role.Guest], 'dashboard'))
  })
})

describe('makeAuthHelpers routes through a tenant capability map (optional 2nd arg — the nav-filter seam)', () => {
  it('without the arg uses the golden CAPABILITIES (empty in the governance-only kernel)', () => {
    // The finance capability ids are contributed by the finance FEATURE MODULE,
    // which is carved out — so the golden kernel CAPABILITIES is empty and the
    // finance helper resolves to false for every group (graceful degradation).
    expect(makeAuthHelpers({ user: { groups: ['ref-finanzen-hv'] } }).canApproveAny()).toBe(false)
    expect(makeAuthHelpers({ user: { groups: [] } }).canApproveAny()).toBe(false)
  })

  it('consults the PROVIDED capability map instead of the golden one', () => {
    const tenantCaps: Record<CapabilityId, readonly string[]> = {
      ...CAPABILITIES,
      'finance.approve.any': ['x-tenant-group'],
    }
    expect(
      makeAuthHelpers({ user: { groups: ['ref-finanzen-hv'] } }, tenantCaps).canApproveAny(),
    ).toBe(false)
    expect(
      makeAuthHelpers({ user: { groups: ['x-tenant-group'] } }, tenantCaps).canApproveAny(),
    ).toBe(true)
  })

  it('default-tenant accessor output IS the golden map (empty in the kernel), so finance helpers are all false for tenant #1', () => {
    const helpers = makeAuthHelpers(
      { user: { groups: ['ref-finanzen-hv'] } },
      capabilitiesForTenant(ctxWith()),
    )
    // capabilitiesForTenant(default) === the golden CAPABILITIES, which is empty
    // in the governance-only kernel → every finance helper degrades to false.
    expect(helpers.canApproveAny()).toBe(false)
    expect(helpers.canConfigureFints()).toBe(false)
  })
})
