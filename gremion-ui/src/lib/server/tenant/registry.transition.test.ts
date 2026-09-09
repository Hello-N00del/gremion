// src/lib/server/tenant/registry.transition.test.ts
// FIX2-LIFECYCLE (§7.8) — the PURE suspend/resume state-machine guard.
//
// resume is legal ONLY from `suspended`; suspend ONLY from `active`. Every other
// current status (the deleted/deleting tombstone, the half-built provisioning row,
// and a no-op same-state flip) is REFUSED with a loud, named error. This pins the
// tombstone-is-terminal / subdomain-takeover defence (§7.8): a crypto-shredded
// `deleted` row can NEVER be flipped back to `active`. No DB, no I/O — the async
// resumeTenant/suspendTenant wrappers (which read the row + apply it) are covered
// in registry.integration.test.ts.
import { describe, it, expect } from 'vitest'
import {
  assertTenantStatusTransition,
  TenantStatusTransitionError,
  type TenantStatus,
} from './registry'

const ALL: TenantStatus[] = ['provisioning', 'active', 'suspended', 'deleting', 'deleted']

describe('assertTenantStatusTransition — resume (-> active)', () => {
  it('ALLOWS suspended -> active (the ONLY legal resume source)', () => {
    expect(() => assertTenantStatusTransition('t2', 'suspended', 'active')).not.toThrow()
  })

  it('REFUSES resurrecting a deleted tombstone (-> active), naming the §7.8 reason', () => {
    expect(() => assertTenantStatusTransition('t2', 'deleted', 'active')).toThrow(
      TenantStatusTransitionError,
    )
    expect(() => assertTenantStatusTransition('t2', 'deleted', 'active')).toThrow(/§7\.8|terminal tombstone/i)
  })

  it('REFUSES resuming a deleting tombstone (-> active)', () => {
    expect(() => assertTenantStatusTransition('t2', 'deleting', 'active')).toThrow(/terminal tombstone/i)
  })

  it('REFUSES promoting a half-provisioned provisioning row straight to active', () => {
    expect(() => assertTenantStatusTransition('t2', 'provisioning', 'active')).toThrow(
      /half-provisioned|provision pipeline/i,
    )
  })

  it('REFUSES the no-op active -> active', () => {
    expect(() => assertTenantStatusTransition('t2', 'active', 'active')).toThrow(
      TenantStatusTransitionError,
    )
  })

  it('refuses EVERY non-suspended source for -> active', () => {
    for (const current of ALL.filter((s) => s !== 'suspended')) {
      expect(() => assertTenantStatusTransition('t2', current, 'active')).toThrow(
        TenantStatusTransitionError,
      )
    }
  })
})

describe('assertTenantStatusTransition — suspend (-> suspended)', () => {
  it('ALLOWS active -> suspended (the ONLY legal suspend source)', () => {
    expect(() => assertTenantStatusTransition('t2', 'active', 'suspended')).not.toThrow()
  })

  it('REFUSES suspending a non-active tenant', () => {
    for (const current of ALL.filter((s) => s !== 'active')) {
      expect(() => assertTenantStatusTransition('t2', current, 'suspended')).toThrow(
        TenantStatusTransitionError,
      )
    }
    expect(() => assertTenantStatusTransition('t2', 'suspended', 'suspended')).toThrow(
      /suspend is legal ONLY from "active"/i,
    )
  })
})

describe('TenantStatusTransitionError — loud + named', () => {
  it('carries the slug, current, target and a named error', () => {
    try {
      assertTenantStatusTransition('verein', 'deleted', 'active')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TenantStatusTransitionError)
      const e = err as TenantStatusTransitionError
      expect(e.name).toBe('TenantStatusTransitionError')
      expect(e.slug).toBe('verein')
      expect(e.current).toBe('deleted')
      expect(e.target).toBe('active')
      expect(e.message).toMatch(/verein/)
      expect(e.message).toMatch(/deleted -> active/)
    }
  })
})
