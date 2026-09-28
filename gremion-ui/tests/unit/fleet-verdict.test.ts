// tests/unit/fleet-verdict.test.ts
//
// TASK-042 R28 (MEDIUM 2): `pnpm migrate` (scripts/run-migrations-verified.mjs)
// registers no tenant since the zero-tenant boot. On an empty registry it
// migrates the control plane only; that must be SAID, never read as "all
// tenants migrated", and a caller that needs a migrated data plane
// (--require-tenant / MIGRATE_REQUIRE_TENANT=1) must fail there.
import { describe, it, expect } from 'vitest'
import { fleetVerdict, requireTenantFrom } from '../../scripts/fleet-verdict.mjs'

type Outcome = { ok: boolean; error?: string; cause?: unknown }
const TAG = '[run-migrations-verified]'

describe('fleetVerdict (run-migrations-verified exit code and report)', () => {
  it('zero tenants, not required: exit 0 and the report says NO data plane was migrated', () => {
    const v = fleetVerdict(new Map<string, Outcome>(), { requireTenant: false, tag: TAG })
    expect(v.code).toBe(0)
    expect(v.errors).toEqual([])
    expect(v.info.join('\n')).toMatch(/ZERO tenants/)
    expect(v.info.join('\n')).toMatch(/NO data plane was migrated/)
    expect(v.info.join('\n')).not.toMatch(/all tenants migrated/)
  })

  it('zero tenants, required: exit 1 naming the empty registry and the fix', () => {
    const v = fleetVerdict(new Map<string, Outcome>(), { requireTenant: true, tag: TAG })
    expect(v.code).toBe(1)
    expect(v.info).toEqual([])
    const msg = v.errors.map((e: unknown[]) => String(e[0])).join('\n')
    expect(msg).toMatch(/ZERO active tenants/)
    expect(msg).toMatch(/--require-tenant/)
    expect(msg).toMatch(/migrate:test-fixture/)
  })

  it('one migrated tenant satisfies --require-tenant and reports the count', () => {
    const v = fleetVerdict(new Map<string, Outcome>([['t1', { ok: true }]]), { requireTenant: true, tag: TAG })
    expect(v.code).toBe(0)
    expect(v.info.join('\n')).toMatch(/1 tenant data plane\(s\) migrated \+ verified/)
  })

  it('a failed tenant is exit 1 with its id, error and cause, whatever the flag', () => {
    for (const requireTenant of [false, true]) {
      const cause = new Error('boom')
      const v = fleetVerdict(new Map<string, Outcome>([['t1', { ok: true }], ['t2', { ok: false, error: 'bad hash', cause }]]), { requireTenant, tag: TAG })
      expect(v.code).toBe(1)
      expect(v.errors).toEqual([[`${TAG} tenant t2 FAILED: bad hash`, cause]])
    }
  })
})

describe('requireTenantFrom (the caller opt-in)', () => {
  it('reads --require-tenant or MIGRATE_REQUIRE_TENANT=1, nothing else', () => {
    expect(requireTenantFrom([], {})).toBe(false)
    expect(requireTenantFrom(['--require-tenant'], {})).toBe(true)
    expect(requireTenantFrom([], { MIGRATE_REQUIRE_TENANT: '1' })).toBe(true)
    expect(requireTenantFrom([], { MIGRATE_REQUIRE_TENANT: '0' })).toBe(false)
    expect(requireTenantFrom(['--require-tenants'], {})).toBe(false)
  })
})
