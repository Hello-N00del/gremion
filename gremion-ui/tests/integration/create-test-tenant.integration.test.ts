// TASK-042 TDD 1: createTestTenant is the only way a kernel suite gets a
// registry tenant; it writes the tenant row and its primary tenant_domain host,
// and two of them are independent.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { getControlDb } from '$lib/server/tenant/control-db'
import { runControlMigrations } from '$lib/server/tenant/control-migrations'
import { resolveTenantByHost, _resetResolutionCacheForTests } from '$lib/server/tenant/registry'
import { createTestTenant } from './create-test-tenant'

describe('createTestTenant (TASK-042: every kernel suite creates its tenant explicitly)', () => {
  beforeAll(async () => {
    await runControlMigrations()
  })
  beforeEach(async () => {
    await getControlDb()`TRUNCATE tenant, tenant_provisioning_resource RESTART IDENTITY CASCADE`
    _resetResolutionCacheForTests()
  })

  it('starts from zero rows in tenant and tenant_domain', async () => {
    const [t] = await getControlDb()<{ n: number }[]>`SELECT count(*)::int AS n FROM tenant`
    const [d] = await getControlDb()<{ n: number }[]>`SELECT count(*)::int AS n FROM tenant_domain`
    expect(t.n).toBe(0)
    expect(d.n).toBe(0)
  })

  it('creates the tenant row plus exactly one PRIMARY tenant_domain host, resolvable by that host', async () => {
    const t = await createTestTenant({ slug: 'fixture-a', host: 'fixture-a.example.test' })
    const [row] = await getControlDb()<{ n: number }[]>`SELECT count(*)::int AS n FROM tenant`
    expect(row.n).toBe(1)
    const doms = await getControlDb()<{ host: string; is_primary: boolean }[]>`
      SELECT host, is_primary FROM tenant_domain WHERE tenant_id = ${t.id}`
    expect(doms).toEqual([{ host: 'fixture-a.example.test', is_primary: true }])
    expect(t.issuer).toBe('https://fixture-a.example.test/auth/realms/fixture-a')
    const ctx = await resolveTenantByHost('fixture-a.example.test')
    expect(ctx?.slug).toBe('fixture-a')
    expect(ctx?.id).toBe(t.id)
    expect(ctx?.issuer).toBe(t.issuer)
  })

  it('two fixture tenants are independent (no shared default identity)', async () => {
    const a = await createTestTenant({ slug: 'fixture-a', host: 'fixture-a.example.test' })
    const b = await createTestTenant({ slug: 'fixture-b', host: 'fixture-b.example.test' })
    expect(a.id).not.toBe(b.id)
    expect(a.issuer).not.toBe(b.issuer)
    expect((await resolveTenantByHost('fixture-a.example.test'))?.slug).toBe('fixture-a')
    expect((await resolveTenantByHost('fixture-b.example.test'))?.slug).toBe('fixture-b')
    expect(await resolveTenantByHost('nobody.example.test')).toBeNull()
  })
})
