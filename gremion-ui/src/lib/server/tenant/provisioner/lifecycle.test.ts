// P2.1c (T17+T21, §8.7) — tenant crypto-shred-on-delete lifecycle unit tests over
// fully-mocked subsystems. No DB, no KC, no network, no filesystem. Exercises the
// crypto-shred-FIRST ordering, the resumable mid-sequence ledger state (re-run
// completes; key-already-shredded is terminal-safe), the §7.8 tombstone (a deleted
// slug is never re-provisionable), every-tenant-equal deletion (TASK-042), and the T21
// leaf-shred step (drop newsletter_<slug> + delete catalog row on the leaf PG).
import { describe, it, expect, vi } from 'vitest'
import { deleteTenant, type CalendarLeafShredExecutor, type DeleteDeps, type LeafShredExecutor } from './lifecycle'
import type { Tenant } from '$lib/server/tenant/registry'

function tenant(over: Partial<Tenant> = {}): Tenant {
  return {
    id: 'id-t2',
    slug: 't2',
    status: 'active',
    dbConnRef: 'file:/run/secrets/tenants/tenant_t2_db',
    realmName: 'verein',
    issuer: 'https://t2.council.example/auth/realms/verein',
    kcInternal: 'https://keycloak:8443/auth/realms/verein',
    kcClientId: 'gremion-ui',
    kcClientRef: 'file:/run/secrets/tenants/tenant_t2_client_gremion-admin',
    authClientRef: 'file:/run/secrets/tenants/tenant_t2_client_gremion-ui',
    ncTarget: {},
    matrixSpace: { aliasNamespace: 't2-' },
    domainProfile: { subdomain: 't2', residencyZone: 'eu' },
    brandRef: 'config:t2',
    blueprintRef: 'STURA_BLUEPRINT@1',
    connProfile: { perTenantMax: 4, prepare: true },
    backupKeyRef: 'file:/run/secrets/tenants/tenant_t2_backup_key',
    audiences: ['gremion-ui', 'gremion-mobile'],
    ...over,
  } as Tenant
}

/** A stateful harness that records the call ORDER across every subsystem so the
 *  crypto-shred-first sequence can be asserted, and backs the registry/ledger
 *  with mutable state so a mid-sequence failure + re-run can be exercised. */
function harness(opts: { row?: Tenant | null; shredFailsOnce?: boolean; dbDropFailsOnce?: boolean } = {}) {
  const order: string[] = []
  let row: Tenant | null = opts.row === undefined ? tenant() : opts.row
  const shredded = new Set<string>()
  const resources = new Map<string, { status: string }>([
    ['db', { status: 'ok' }],
    ['realm', { status: 'ok' }],
    ['nextcloud', { status: 'pending' }],
    ['matrix', { status: 'pending' }],
  ])
  let shredCalls = 0
  let dropCalls = 0
  const evict = vi.fn(() => order.push('evict'))

  const deps: DeleteDeps = {
    shredSecretFiles: vi.fn(async (paths: readonly string[]) => {
      shredCalls++
      if (opts.shredFailsOnce && shredCalls === 1) throw new Error('boom: shred failed')
      order.push('shred')
      for (const p of paths) shredded.add(p)
    }),
    db: {
      dropKernelDatabase: vi.fn(async () => {
        dropCalls++
        if (opts.dbDropFailsOnce && dropCalls === 1) throw new Error('boom: DB drop failed')
        order.push('db-drop')
      }),
    },
    kc: {
      deleteRealm: vi.fn(async () => {
        order.push('realm-delete')
      }),
    },
    registry: {
      getTenantBySlug: async (slug) => (row && row.slug === slug ? ({ ...row } as Tenant) : null),
      updateTenantStatus: vi.fn(async (_id: string, status) => {
        order.push(`status:${status}`)
        if (row) row = { ...row, status } as Tenant
        return row
      }),
      markTenantResourceFailed: vi.fn(async (_id, sub) => {
        order.push(`mark-manual:${sub}`)
        resources.set(sub, { status: 'failed' })
      }),
      evictTenantRuntime: evict,
    },
    tenantSecretsDir: './secrets/tenants',
  }
  return {
    deps,
    order,
    get row() {
      return row
    },
    shredded,
    resources,
  }
}

describe('deleteTenant — crypto-shred-first ordering', () => {
  it('shreds the backup key FIRST, then drops DB, then deletes realm, then tombstones', async () => {
    const h = harness()
    await deleteTenant('t2', h.deps)
    // the crypto-shred-first ordering, pinned (evict is incidental — assert the
    // four lifecycle steps are in the contracted order with shred strictly first).
    const lifecycle = h.order.filter(
      (s) => s === 'shred' || s === 'db-drop' || s === 'realm-delete' || s === 'status:deleted',
    )
    expect(lifecycle).toEqual(['shred', 'db-drop', 'realm-delete', 'status:deleted'])
  })

  it('shreds the backup key AND every per-tenant client/db secret file', async () => {
    const h = harness()
    await deleteTenant('t2', h.deps)
    const paths = (h.deps.shredSecretFiles as any).mock.calls[0][0] as string[]
    // the crypto-shred target = the backup key (the §7.9 exactly-one location)…
    expect(paths.some((p) => p.endsWith('tenant_t2_backup_key'))).toBe(true)
    // …plus the per-tenant DB + client secrets so no live credential outlives the tenant.
    expect(paths.some((p) => p.endsWith('tenant_t2_db'))).toBe(true)
    expect(paths.some((p) => p.endsWith('tenant_t2_client_gremion-ui'))).toBe(true)
    expect(paths.some((p) => p.endsWith('tenant_t2_client_gremion-admin'))).toBe(true)
    // TASK-043 Q11: the list of generated secrets shrank; a tenant made before the
    // shrink still has the old client files, and they are still shredded.
    expect(paths.some((p) => p.endsWith('tenant_t2_client_synapse'))).toBe(true)
    for (const legacy of ['nextcloud', 'helios', 'helios-voter']) {
      expect(paths.some((p) => p.endsWith(`tenant_t2_client_${legacy}`))).toBe(true)
    }
  })

  it('TASK-043 Q3: drops the kernel database by the tenant ID, never by the slug', async () => {
    const h = harness()
    await deleteTenant('t2', h.deps)
    expect(h.deps.db.dropKernelDatabase).toHaveBeenCalledWith('id-t2')
  })

  it('marks NC + Matrix for manual teardown (silo satellites the script cannot reach)', async () => {
    const h = harness()
    await deleteTenant('t2', h.deps)
    expect(h.deps.registry.markTenantResourceFailed).toHaveBeenCalledWith(
      'id-t2',
      'nextcloud',
      expect.stringMatching(/manual teardown/i),
    )
    expect(h.deps.registry.markTenantResourceFailed).toHaveBeenCalledWith(
      'id-t2',
      'matrix',
      expect.stringMatching(/manual teardown/i),
    )
  })

  it('tombstones the row with status=deleted and evicts the runtime', async () => {
    const h = harness()
    await deleteTenant('t2', h.deps)
    expect(h.row!.status).toBe('deleted')
    expect(h.deps.registry.evictTenantRuntime).toHaveBeenCalledWith('id-t2')
  })
})

// TASK-042 TDD 6 (TRD-042 [D R15-2]): there is no bootstrap tenant, so a
// tenant whose slug happens to be `default` is deleted exactly like any other.
describe('deleteTenant — every tenant is equal (no default-tenant guard)', () => {
  function forSlug(slug: string): Tenant {
    return tenant({
      id: `id-${slug}`,
      slug,
      dbConnRef: `file:/run/secrets/tenants/tenant_${slug}_db`,
      kcClientRef: `file:/run/secrets/tenants/tenant_${slug}_client_gremion-admin`,
      authClientRef: `file:/run/secrets/tenants/tenant_${slug}_client_gremion-ui`,
      backupKeyRef: `file:/run/secrets/tenants/tenant_${slug}_backup_key`,
    })
  }

  async function runDelete(slug: string) {
    const h = harness({ row: forSlug(slug) })
    const result = await deleteTenant(slug, h.deps)
    const paths = ((h.deps.shredSecretFiles as any).mock.calls[0][0] as string[]).map((p) =>
      p.split(slug).join('<slug>'),
    )
    return { result: { ...result, slug: '<slug>', shreddedPaths: result.shreddedPaths.map((p) => p.split(slug).join('<slug>')) }, order: h.order, paths, status: h.row!.status }
  }

  it('deletes a tenant whose slug is `default`: shred, drop, realm delete, tombstone', async () => {
    const d = await runDelete('default')
    expect(d.status).toBe('deleted')
    expect(d.result.shredded).toBe(true)
    expect(d.paths.some((p) => p.endsWith('tenant_<slug>_backup_key'))).toBe(true)
  })

  it('`default` and `alpha` go through byte-equal delete sequences', async () => {
    expect(await runDelete('default')).toEqual(await runDelete('alpha'))
  })
})

describe('deleteTenant — §7.8 tombstone is terminal (slug never reusable)', () => {
  it('a re-run on an already-deleted tenant is a terminal-safe no-op (idempotent), nothing re-shredded', async () => {
    const h = harness({ row: tenant({ status: 'deleted' }) })
    await deleteTenant('t2', h.deps)
    expect(h.deps.shredSecretFiles).not.toHaveBeenCalled()
    expect(h.deps.db.dropKernelDatabase).not.toHaveBeenCalled()
    expect(h.deps.kc.deleteRealm).not.toHaveBeenCalled()
  })

  it('refuses an unknown slug (no tombstone to act on)', async () => {
    const h = harness({ row: null })
    await expect(deleteTenant('t2', h.deps)).rejects.toThrow(/unknown tenant/i)
  })

  it('refuses an invalid slug before any subsystem touch', async () => {
    const h = harness()
    await expect(deleteTenant('Bad Slug!', h.deps)).rejects.toThrow(/invalid slug/i)
    expect(h.deps.shredSecretFiles).not.toHaveBeenCalled()
  })
})

describe('deleteTenant — resumable mid-sequence ledger state', () => {
  it('a shred failure leaves status=deleting (resumable); a re-run completes to deleted', async () => {
    const h = harness({ shredFailsOnce: true })
    await expect(deleteTenant('t2', h.deps)).rejects.toThrow(/shred failed/i)
    // status flipped to 'deleting' BEFORE the shred, so the partial state is visible
    expect(h.row!.status).toBe('deleting')
    expect(h.deps.db.dropKernelDatabase).not.toHaveBeenCalled()
    // re-run from the resumable 'deleting' state completes
    await deleteTenant('t2', h.deps)
    expect(h.row!.status).toBe('deleted')
    expect(h.deps.shredSecretFiles).toHaveBeenCalledTimes(2)
    expect(h.deps.db.dropKernelDatabase).toHaveBeenCalledTimes(1)
  })

  it('a DB-drop failure after the shred is resumable; re-run re-shreds (terminal-safe) and completes', async () => {
    const h = harness({ dbDropFailsOnce: true })
    await expect(deleteTenant('t2', h.deps)).rejects.toThrow(/DB drop failed/i)
    expect(h.row!.status).toBe('deleting')
    // re-run: key-already-shredded is terminal-safe (re-shred is harmless), DB drop now succeeds
    await deleteTenant('t2', h.deps)
    expect(h.row!.status).toBe('deleted')
    expect(h.deps.db.dropKernelDatabase).toHaveBeenCalledTimes(2)
  })
})

// ── T21 §8.7 leaf-shred tests ─────────────────────────────────────────────────

describe('deleteTenant — leaf shred step (T21, §8.7)', () => {
  function leafShredHarness(opts: { leafFailsOnce?: boolean } = {}) {
    const h = harness()
    let leafDropCalls = 0
    const leaf: LeafShredExecutor = {
      dropNewsletterDb: vi.fn(async (slug: string) => {
        leafDropCalls++
        if (opts.leafFailsOnce && leafDropCalls === 1) throw new Error('boom: leaf drop failed')
        h.order.push(`leaf-drop:newsletter_${slug}`)
      }),
      deleteCatalogRow: vi.fn(async (tenantId: string) => {
        h.order.push(`leaf-catalog-delete:${tenantId}`)
      }),
    }
    h.deps.leaf = leaf
    // Return h directly (not spread) so h.row getter stays live across the async call.
    return Object.assign(h, { leaf })
  }

  it('calls dropNewsletterDb then deleteCatalogRow when leaf dep is present', async () => {
    const h = leafShredHarness()
    await deleteTenant('t2', h.deps)
    expect(h.leaf.dropNewsletterDb).toHaveBeenCalledWith('t2')
    expect(h.leaf.deleteCatalogRow).toHaveBeenCalledWith('id-t2')
  })

  it('leaf-shred happens AFTER data-plane DB drop (step 3b = after step 3)', async () => {
    const h = leafShredHarness()
    await deleteTenant('t2', h.deps)
    const dbDropIdx = h.order.indexOf('db-drop')
    const leafDropIdx = h.order.findIndex((s) => s.startsWith('leaf-drop:'))
    expect(dbDropIdx).toBeGreaterThanOrEqual(0)
    expect(leafDropIdx).toBeGreaterThan(dbDropIdx)
  })

  it('leaf-shred happens BEFORE realm delete (step 3b = before step 4)', async () => {
    const h = leafShredHarness()
    await deleteTenant('t2', h.deps)
    const leafDropIdx = h.order.findIndex((s) => s.startsWith('leaf-drop:'))
    const realmDeleteIdx = h.order.indexOf('realm-delete')
    expect(leafDropIdx).toBeGreaterThanOrEqual(0)
    expect(leafDropIdx).toBeLessThan(realmDeleteIdx)
  })

  it('configured-leaf shred failure ABORTS deleteTenant — no tombstone written (F-1 data-remanence fix)', async () => {
    const h = leafShredHarness({ leafFailsOnce: true })
    // The delete MUST throw when the configured leaf drop fails
    await expect(deleteTenant('t2', h.deps)).rejects.toThrow(/leaf drop failed/i)
    // The tombstone must NOT have been written — status remains 'deleting' (resumable)
    expect(h.row!.status).toBe('deleting')
    // The realm delete + tombstone must NOT have run
    expect(h.order).not.toContain('realm-delete')
    expect(h.order).not.toContain('status:deleted')
    // A re-run re-attempts the leaf shred and completes (idempotent up to the tombstone)
    await deleteTenant('t2', h.deps)
    expect(h.row!.status).toBe('deleted')
    expect(h.leaf.dropNewsletterDb).toHaveBeenCalledTimes(2)
  })

  it('unconfigured leaf (deps.leaf absent) is skipped cleanly — delete still completes (F-1)', async () => {
    const h = harness()
    // Explicitly ensure no `leaf` property
    expect('leaf' in h.deps).toBe(false)
    await expect(deleteTenant('t2', h.deps)).resolves.toMatchObject({ slug: 't2', shredded: true })
    expect(h.row!.status).toBe('deleted')
  })
})

// ── calendar leaf shred (step 4b) ─────────────────────────────────────────────

describe('deleteTenant — calendar leaf shred step (4b)', () => {
  function calendarHarness(opts: { dropFailsOnce?: boolean; catalogFailsOnce?: boolean } = {}) {
    const h = harness()
    let dropCalls = 0
    let catalogCalls = 0
    const calendar: CalendarLeafShredExecutor = {
      dropCalendarDb: vi.fn(async (slug: string) => {
        dropCalls++
        if (opts.dropFailsOnce && dropCalls === 1) throw new Error('boom: calendar drop failed')
        h.order.push(`calendar-drop:calendar_${slug}`)
      }),
      deleteCatalogRow: vi.fn(async (tenantId: string) => {
        catalogCalls++
        if (opts.catalogFailsOnce && catalogCalls === 1) throw new Error('boom: calendar catalog failed')
        h.order.push(`calendar-catalog-delete:${tenantId}`)
      }),
    }
    h.deps.calendar = calendar
    return Object.assign(h, { calendar })
  }

  it('drops the calendar database, then deletes its catalog row, with the slug and tenant id', async () => {
    const h = calendarHarness()
    await deleteTenant('t2', h.deps)
    expect(h.calendar.dropCalendarDb).toHaveBeenCalledWith('t2')
    expect(h.calendar.deleteCatalogRow).toHaveBeenCalledWith('id-t2')
    expect(h.order.indexOf('calendar-drop:calendar_t2')).toBeLessThan(h.order.indexOf('calendar-catalog-delete:id-t2'))
  })

  it('runs AFTER the realm delete and BEFORE the tombstone', async () => {
    const h = calendarHarness()
    await deleteTenant('t2', h.deps)
    const realm = h.order.indexOf('realm-delete')
    const drop = h.order.indexOf('calendar-drop:calendar_t2')
    const catalog = h.order.indexOf('calendar-catalog-delete:id-t2')
    const tombstone = h.order.indexOf('status:deleted')
    expect(realm).toBeGreaterThanOrEqual(0)
    expect(drop).toBeGreaterThan(realm)
    expect(catalog).toBeLessThan(tombstone)
  })

  it('runs after the newsletter leaf step when both are configured', async () => {
    const h = calendarHarness()
    h.deps.leaf = {
      dropNewsletterDb: vi.fn(async (slug: string) => void h.order.push(`leaf-drop:newsletter_${slug}`)),
      deleteCatalogRow: vi.fn(async (tenantId: string) => void h.order.push(`leaf-catalog-delete:${tenantId}`)),
    }
    await deleteTenant('t2', h.deps)
    expect(h.order.indexOf('leaf-catalog-delete:id-t2')).toBeLessThan(h.order.indexOf('calendar-drop:calendar_t2'))
  })

  it('a calendar drop failure ABORTS the delete: no tombstone, and a re-run completes', async () => {
    const h = calendarHarness({ dropFailsOnce: true })
    await expect(deleteTenant('t2', h.deps)).rejects.toThrow(/calendar drop failed/)
    expect(h.row!.status).toBe('deleting')
    expect(h.order).not.toContain('status:deleted')
    expect(h.order.filter((s) => s.startsWith('mark-manual:'))).toEqual([])
    await deleteTenant('t2', h.deps)
    expect(h.row!.status).toBe('deleted')
    expect(h.calendar.dropCalendarDb).toHaveBeenCalledTimes(2)
  })

  it('a calendar catalog failure ABORTS the delete: no tombstone, and a re-run completes', async () => {
    const h = calendarHarness({ catalogFailsOnce: true })
    await expect(deleteTenant('t2', h.deps)).rejects.toThrow(/calendar catalog failed/)
    expect(h.row!.status).toBe('deleting')
    expect(h.order).not.toContain('status:deleted')
    await deleteTenant('t2', h.deps)
    expect(h.row!.status).toBe('deleted')
    expect(h.calendar.deleteCatalogRow).toHaveBeenCalledTimes(2)
  })

  it('an unconfigured calendar leaf (deps.calendar absent) is skipped cleanly', async () => {
    const h = harness()
    expect('calendar' in h.deps).toBe(false)
    await expect(deleteTenant('t2', h.deps)).resolves.toMatchObject({ slug: 't2', shredded: true })
    expect(h.row!.status).toBe('deleted')
  })
})
