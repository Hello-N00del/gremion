import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Tenant } from './registry'
import type { TenantContext } from './context'

// P2.1b T2 (D-FLEET) — unit contract of the fleet-migration runner:
// list ACTIVE tenants → resolveTenantBySlug → runWithTenant(ctx, runMigrations)
// → ledger a tenant_migration_run row; one tenant's failure never blocks the
// fleet. The registry (control-DB SQL) and $lib/server/db (data-plane
// migrations) are mocked; the tenant CONTEXT module is deliberately REAL so
// these tests pin that runMigrations executes inside the EXPLICIT per-tenant
// ALS scope the fleet establishes — never an ambient/harness default
// ([[als-default-tenant-test-harness-masks-fail-closed]]).
vi.mock('./registry', () => ({
  listActiveTenants: vi.fn(),
  resolveTenantBySlug: vi.fn(),
  startTenantMigrationRun: vi.fn(),
  finishTenantMigrationRun: vi.fn(),
}))
vi.mock('$lib/server/db', () => ({
  runMigrations: vi.fn(),
  getDb: vi.fn(),
}))
// P2.1c (T15 / §6-P2.2): the fleet asserts a COMPLETE brand identity per tenant
// (reading THAT tenant's config via readConfig). Mock readConfig so we control
// completeness per tenant; default = a complete brand (every existing test keeps
// passing), overridden per-case for the incomplete-brand readiness test below.
// assertBrandIdentityComplete / brandIdentityComplete (provisioner/materialize)
// stay REAL — these tests pin that the fleet actually consults the guard.
vi.mock('$lib/server/config', () => ({
  readConfig: vi.fn(),
}))

import {
  listActiveTenants,
  resolveTenantBySlug,
  startTenantMigrationRun,
  finishTenantMigrationRun,
} from './registry'
import { runMigrations, getDb } from '$lib/server/db'
import { readConfig } from '$lib/server/config'
import { currentTenantId } from './context'
import { runFleetMigrations } from './fleet'

/** A GremionConfig-shaped double whose brand identity is COMPLETE. */
const completeBrandConfig = () =>
  ({
    brand: { product: 'GovOS', org_short: 'Stadt WR' },
  }) as never
/** A GremionConfig-shaped double whose brand identity is INCOMPLETE (neutral defaults). */
const blankBrandConfig = () => ({ brand: { product: '', org_short: '' } }) as never

const tenantRow = (id: string, slug: string) =>
  ({ id, slug, status: 'active' }) as unknown as Tenant
const ctxFor = (id: string, slug: string) => ({ id, slug }) as unknown as TenantContext

beforeEach(() => {
  vi.clearAllMocks()
  // Two active tenants: the default (#1) AND a second one — D-FLEET iterates
  // BOTH through the same path (§8.1).
  vi.mocked(listActiveTenants).mockResolvedValue([
    tenantRow('tid-default', 'default'),
    tenantRow('tid-alpha', 'alpha'),
  ])
  vi.mocked(resolveTenantBySlug).mockImplementation(async (slug: string) =>
    slug === 'default' ? ctxFor('tid-default', 'default') : ctxFor('tid-alpha', 'alpha'),
  )
  vi.mocked(startTenantMigrationRun).mockImplementation(async (tenantId: string) => `run-${tenantId}`)
  vi.mocked(finishTenantMigrationRun).mockResolvedValue(undefined)
  vi.mocked(runMigrations).mockResolvedValue(undefined)
  // Default: every tenant's config carries a COMPLETE brand identity, so the
  // T15 brand-completeness gate is a no-op for the pre-existing fleet tests.
  vi.mocked(readConfig).mockReturnValue(completeBrandConfig())
  // getDb() is used only for the best-effort schema_migrations high-water-mark
  // probe; mock it as a tagged-template fn resolving one row.
  vi.mocked(getDb).mockReturnValue(
    (async () => [{ filename: '039_x.sql' }]) as unknown as ReturnType<typeof getDb>,
  )
})

describe('runFleetMigrations — D-FLEET (plan T2)', () => {
  it('migrates every ACTIVE tenant (default included), each inside its own explicit tenant scope', async () => {
    const seen: string[] = []
    vi.mocked(runMigrations).mockImplementation(async () => {
      // currentTenantId() THROWS outside an ALS scope — recording it proves the
      // fleet wrapped this tenant's runMigrations() in runWithTenant(ctx, …).
      seen.push(currentTenantId())
    })

    const outcomes = await runFleetMigrations()

    expect(seen).toEqual(['tid-default', 'tid-alpha'])
    expect(outcomes.size).toBe(2)
    expect(outcomes.get('tid-default')).toEqual({ ok: true })
    expect(outcomes.get('tid-alpha')).toEqual({ ok: true })
  })

  it("one tenant's migration failure never blocks the fleet; the outcome carries the original error", async () => {
    const boom = new Error('schema drift: column "foo" missing')
    vi.mocked(runMigrations).mockImplementation(async () => {
      if (currentTenantId() === 'tid-default') throw boom
    })

    const outcomes = await runFleetMigrations()

    const failed = outcomes.get('tid-default')!
    expect(failed.ok).toBe(false)
    expect(failed.error).toContain('schema drift')
    // `cause` preserves the original Error's IDENTITY (not a wrapper/copy) so
    // the migration-run ledger and debugging keep the real stack/fields.
    // (Post-T3 boot does NOT rethrow the default tenant's failure — it logs
    // and serves a tenant-scoped 503; identity here is ledger/debug fidelity.)
    expect(failed.cause).toBe(boom)
    expect(outcomes.get('tid-alpha')).toEqual({ ok: true })
    // The fleet kept going: BOTH tenants were attempted.
    expect(vi.mocked(runMigrations)).toHaveBeenCalledTimes(2)
  })

  it('ledgers a start row per tenant and finishes ok with the schema_migrations high-water mark', async () => {
    await runFleetMigrations()

    expect(startTenantMigrationRun).toHaveBeenCalledWith('tid-default')
    expect(startTenantMigrationRun).toHaveBeenCalledWith('tid-alpha')
    expect(finishTenantMigrationRun).toHaveBeenCalledWith('run-tid-default', {
      ok: true,
      lastApplied: '039_x.sql',
    })
    expect(finishTenantMigrationRun).toHaveBeenCalledWith('run-tid-alpha', {
      ok: true,
      lastApplied: '039_x.sql',
    })
  })

  it('ledgers ok:false + the error message when a tenant migration throws', async () => {
    vi.mocked(runMigrations).mockImplementation(async () => {
      if (currentTenantId() === 'tid-alpha') throw new Error('boom-alpha')
    })

    await runFleetMigrations()

    expect(finishTenantMigrationRun).toHaveBeenCalledWith('run-tid-alpha', {
      ok: false,
      error: expect.stringContaining('boom-alpha'),
    })
    expect(finishTenantMigrationRun).toHaveBeenCalledWith('run-tid-default', {
      ok: true,
      lastApplied: '039_x.sql',
    })
  })

  it('a tenant that no longer resolves records a failure and the fleet continues', async () => {
    // e.g. status flipped to suspended between the LIST and the RESOLVE.
    vi.mocked(resolveTenantBySlug).mockImplementation(async (slug: string) =>
      slug === 'default' ? null : ctxFor('tid-alpha', 'alpha'),
    )

    const outcomes = await runFleetMigrations()

    expect(outcomes.get('tid-default')!.ok).toBe(false)
    expect(outcomes.get('tid-default')!.error).toMatch(/not resolvable/i)
    expect(outcomes.get('tid-alpha')).toEqual({ ok: true })
    // No migration ran for the unresolvable tenant.
    expect(vi.mocked(runMigrations)).toHaveBeenCalledTimes(1)
  })

  it('the last_applied probe is best-effort: its failure never fails a migrated tenant', async () => {
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error('probe down')
    })

    const outcomes = await runFleetMigrations()

    expect(outcomes.get('tid-default')).toEqual({ ok: true })
    expect(outcomes.get('tid-alpha')).toEqual({ ok: true })
    expect(finishTenantMigrationRun).toHaveBeenCalledWith('run-tid-default', {
      ok: true,
      lastApplied: null,
    })
  })

  it('a control-plane listing failure rethrows — process-wide boot failure (D-READY)', async () => {
    vi.mocked(listActiveTenants).mockRejectedValue(new Error('control db down'))
    await expect(runFleetMigrations()).rejects.toThrow('control db down')
  })
})

// P2.1c (T15 / §6-P2.2) — the loud brand-incomplete boot/readiness guard. The
// fleet runs assertBrandIdentityComplete inside each tenant's scope AFTER its
// migrations succeed; an incomplete brand becomes an `ok:false` outcome →
// readiness records the tenant `failed` (readiness.ts) → resolve.ts serves a
// TENANT-SCOPED 503 instead of rendering a silent blank brand. The default
// (materialized) tenant carries a real brand and passes unchanged.
describe('runFleetMigrations — T15 brand-completeness boot/readiness guard (§6-P2.2)', () => {
  it('a tenant whose config lacks a COMPLETE brand block fails readiness (ok:false), the default passes', async () => {
    // readConfig is called with the resolved ctx; route by tenant id: the
    // default tenant is materialized (complete), the second is un-materialized
    // (neutral blank brand).
    vi.mocked(readConfig).mockImplementation((tenant) =>
      (tenant as { id: string }).id === 'tid-default'
        ? completeBrandConfig()
        : blankBrandConfig(),
    )

    const outcomes = await runFleetMigrations()

    // Default (materialized) tenant: brand complete → ready.
    expect(outcomes.get('tid-default')).toEqual({ ok: true })
    // Second (un-materialized) tenant: brand incomplete → failed (loud), with an
    // actionable error naming the slug + the materialize-config remedy.
    const failed = outcomes.get('tid-alpha')!
    expect(failed.ok).toBe(false)
    expect(failed.error).toMatch(/INCOMPLETE brand identity/i)
    expect(failed.error).toContain('alpha')
    expect(failed.error).toMatch(/materialize-config/)
    // Migrations DID run for the incomplete tenant — the guard fails it AFTER a
    // clean migration, never silently rendering blank.
    expect(vi.mocked(runMigrations)).toHaveBeenCalledTimes(2)
    // The failed outcome is ledgered as a finished run with the brand error.
    expect(finishTenantMigrationRun).toHaveBeenCalledWith('run-tid-alpha', {
      ok: false,
      error: expect.stringContaining('INCOMPLETE brand identity'),
    })
  })

  it('the guard runs inside the per-tenant scope (readConfig sees the resolved ctx)', async () => {
    const seenCtxIds: string[] = []
    vi.mocked(readConfig).mockImplementation((tenant) => {
      seenCtxIds.push((tenant as { id: string }).id)
      return completeBrandConfig()
    })

    await runFleetMigrations()

    // The fleet passed each tenant's own ctx to readConfig — so the guard checks
    // THAT tenant's config, not an ambient/default one.
    expect(seenCtxIds).toEqual(['tid-default', 'tid-alpha'])
  })
})
