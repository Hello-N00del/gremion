// P2.1c (T17+T21, §8.7) — tenant crypto-shred-on-delete lifecycle unit tests over
// fully-mocked subsystems. No DB, no KC, no network, no filesystem. Exercises the
// crypto-shred-FIRST ordering, the resumable mid-sequence ledger state (re-run
// completes; key-already-shredded is terminal-safe), the §7.8 tombstone (a deleted
// slug is never re-provisionable), the `default`-tenant hard guard, and the T21
// leaf-shred step (drop newsletter_<slug> + delete catalog row on the leaf PG).
import { describe, it, expect, vi } from 'vitest'
import { deleteTenant, type DeleteDeps, type LeafShredExecutor } from './lifecycle'
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
      dropDatabaseAndRole: vi.fn(async () => {
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

describe('deleteTenant — default-tenant hard guard', () => {
  it('REFUSES to delete the default tenant (no shred, no drop, no realm delete)', async () => {
    const h = harness({ row: tenant({ id: 'default', slug: 'default' }) })
    await expect(deleteTenant('default', h.deps)).rejects.toThrow(/default tenant/i)
    expect(h.deps.shredSecretFiles).not.toHaveBeenCalled()
    expect(h.deps.db.dropDatabaseAndRole).not.toHaveBeenCalled()
    expect(h.deps.kc.deleteRealm).not.toHaveBeenCalled()
  })

  // Belt-and-braces (depth): if the registry ever returns the default ROW for a
  // non-`default` input slug, the resolved-row slug guard still refuses. (The
  // (0a) input-slug guard cannot catch this — the input slug is not 'default'.)
  it('REFUSES when the registry returns a row whose SLUG is default for a non-default input', async () => {
    const h = harness()
    // Force the registry to hand back the DEFAULT row for a non-default lookup.
    h.deps.registry.getTenantBySlug = async () =>
      tenant({ slug: 'default', id: 'id-default-uuid' })
    await expect(deleteTenant('t2', h.deps)).rejects.toThrow(/default tenant/i)
    expect(h.deps.shredSecretFiles).not.toHaveBeenCalled()
    expect(h.deps.db.dropDatabaseAndRole).not.toHaveBeenCalled()
    expect(h.deps.kc.deleteRealm).not.toHaveBeenCalled()
  })
})

describe('deleteTenant — §7.8 tombstone is terminal (slug never reusable)', () => {
  it('a re-run on an already-deleted tenant is a terminal-safe no-op (idempotent), nothing re-shredded', async () => {
    const h = harness({ row: tenant({ status: 'deleted' }) })
    await deleteTenant('t2', h.deps)
    expect(h.deps.shredSecretFiles).not.toHaveBeenCalled()
    expect(h.deps.db.dropDatabaseAndRole).not.toHaveBeenCalled()
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
    expect(h.deps.db.dropDatabaseAndRole).not.toHaveBeenCalled()
    // re-run from the resumable 'deleting' state completes
    await deleteTenant('t2', h.deps)
    expect(h.row!.status).toBe('deleted')
    expect(h.deps.shredSecretFiles).toHaveBeenCalledTimes(2)
    expect(h.deps.db.dropDatabaseAndRole).toHaveBeenCalledTimes(1)
  })

  it('a DB-drop failure after the shred is resumable; re-run re-shreds (terminal-safe) and completes', async () => {
    const h = harness({ dbDropFailsOnce: true })
    await expect(deleteTenant('t2', h.deps)).rejects.toThrow(/DB drop failed/i)
    expect(h.row!.status).toBe('deleting')
    // re-run: key-already-shredded is terminal-safe (re-shred is harmless), DB drop now succeeds
    await deleteTenant('t2', h.deps)
    expect(h.row!.status).toBe('deleted')
    expect(h.deps.db.dropDatabaseAndRole).toHaveBeenCalledTimes(2)
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
