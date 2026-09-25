import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GremionBlueprint } from '$lib/server/seed/org-blueprint'

// P2.3 (#202) T3 — the seed route must feed the CURRENT tenant ITS OWN blueprint
// (resolved from the registry row's blueprint_ref) instead of the hardcoded
// StuRa blueprint. These tests mock the tenant-resolution + seed seams so the
// selection is asserted without a live DB / KC.
const hoisted = vi.hoisted(() => ({
  orgUnits: [] as unknown[],
  tenantSlug: 'default',
  blueprintRef: 'STURA_BLUEPRINT@1',
  runSeed: vi.fn(async (_bp: GremionBlueprint) => ({ ok: true })),
}))

// TASK-032 (TRD-410 [D R20-D5]): the seed route now reads process.env
// directly (kit 3 dropped $env/dynamic/private's free-form var access;
// process.env itself does not accept an accessor descriptor, unlike a plain
// object, so this sets the real value directly rather than a live getter).
vi.mock('$lib/server/governance/org-units-db', () => ({ listOrgUnits: async () => hoisted.orgUnits }))
vi.mock('$lib/server/seed/seed', () => ({ runSeed: hoisted.runSeed }))
vi.mock('$lib/server/tenant/context', () => ({
  getTenant: () => ({ slug: hoisted.tenantSlug }),
  // #257-4: requireSetupRateLimit (now applied to /seed) keys buckets by tenant.
  currentTenantId: () => hoisted.tenantSlug,
}))
vi.mock('$lib/server/tenant/registry', () => ({
  getTenantBySlug: async (slug: string) =>
    slug === hoisted.tenantSlug ? { slug, blueprintRef: hoisted.blueprintRef } : null,
}))

import { POST } from './+server'
import { STURA_BLUEPRINT } from '$lib/server/seed/org-blueprint'
import { MUNICIPAL_BLUEPRINT } from '$lib/server/seed/municipal-blueprint'
import { __resetRateLimits } from '$lib/server/rate-limit'

function call(token: string | null) {
  const headers = new Headers()
  if (token !== null) headers.set('x-seed-token', token)
  const request = new Request('http://localhost/api/setup/seed', { method: 'POST', headers })
  return POST({ request } as never)
}

beforeEach(() => {
  delete process.env.SEED_TOKEN
  hoisted.orgUnits = []
  hoisted.tenantSlug = 'default'
  hoisted.blueprintRef = 'STURA_BLUEPRINT@1'
  hoisted.runSeed.mockClear()
  // #257-4: clear the per-IP setup rate-limit buckets so the 5/hour cap does not
  // bleed across cases (each test issues fresh requests).
  __resetRateLimits()
})

describe('POST /api/setup/seed — token guard', () => {
  it('rejects a request with no seed token', async () => {
    await expect(call(null)).rejects.toMatchObject({ status: 403 })
  })

  it('rejects a request with a wrong seed token', async () => {
    process.env.SEED_TOKEN = 'right'
    await expect(call('definitely-wrong')).rejects.toMatchObject({ status: 403 })
  })
})

describe('POST /api/setup/seed — blueprint selection (T3)', () => {
  it('seeds the StuRa blueprint for the default tenant', async () => {
    process.env.SEED_TOKEN = 'test-seed-token'
    await call('test-seed-token')
    expect(hoisted.runSeed).toHaveBeenCalledTimes(1)
    expect(hoisted.runSeed.mock.calls[0][0]).toBe(STURA_BLUEPRINT)
  })

  it('seeds the MUNICIPAL blueprint when the resolved tenant carries MUNICIPAL_BLUEPRINT@1', async () => {
    process.env.SEED_TOKEN = 'test-seed-token'
    hoisted.tenantSlug = 'musterstadt'
    hoisted.blueprintRef = 'MUNICIPAL_BLUEPRINT@1'
    await call('test-seed-token')
    expect(hoisted.runSeed).toHaveBeenCalledTimes(1)
    expect(hoisted.runSeed.mock.calls[0][0]).toBe(MUNICIPAL_BLUEPRINT)
  })

  it('refuses on an already-seeded database (org_units not empty)', async () => {
    process.env.SEED_TOKEN = 'test-seed-token'
    hoisted.orgUnits = [{ id: 'x' }]
    await expect(call('test-seed-token')).rejects.toMatchObject({ status: 409 })
    expect(hoisted.runSeed).not.toHaveBeenCalled()
  })
})
