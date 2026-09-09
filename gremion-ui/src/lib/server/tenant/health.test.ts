// P2.1c (T18+T21, §7.10 half 1) — tenant-health single-pane unit tests over fully
// mocked registry/probes. No DB, no KC, no network. Exercises: a healthy fleet
// (every tenant active + every probe green) → overall ok / exit 0; one failing
// probe on one tenant → that named row unhealthy + overall NOT ok / exit 1; a
// SUSPENDED tenant is reported `suspended` (NOT unhealthy) and its data-plane /
// OIDC probes are NEVER run (a suspended data plane may be quarantined — same
// fail-closed stance as the resolver's non-active path). T21 adds: the `leaf`
// health check (newsletter-service /healthz/tenants probe).
import { describe, it, expect, vi } from 'vitest'
import {
  checkFleetHealth,
  renderHealthTable,
  fleetExitCode,
  type HealthDeps,
  type TenantHealthRow,
  type LeafProbe,
} from './health'
import type { Tenant } from './registry'

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
    domainProfile: {},
    brandRef: 'config:t2',
    blueprintRef: 'STURA_BLUEPRINT@1',
    connProfile: { perTenantMax: 4, prepare: true },
    backupKeyRef: 'file:/run/secrets/tenants/tenant_t2_backup_key',
    audiences: ['gremion-ui'],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  } as Tenant
}

/** A fully-green probe set for one tenant. */
function greenDeps(over: Partial<HealthDeps> = {}): HealthDeps {
  return {
    listTenants: async () => [tenant()],
    probeDataPlane: vi.fn(async () => ({ ok: true })),
    probeMigrations: vi.fn(async () => ({
      ok: true,
      schemaVersion: '039_caucus.sql',
      lastRun: { ok: true, finishedAt: new Date('2026-06-01T00:00:00Z'), error: null },
    })),
    probeRealmOidc: vi.fn(async () => ({ ok: true })),
    probeSatellites: vi.fn(async () => ({
      nextcloud: 'ok',
      matrix: 'ok',
    })),
    probeLeaf: vi.fn(async (): Promise<LeafProbe> => ({ ok: true, subscribers: 42, newsletters: 3 })),
    ...over,
  }
}

describe('checkFleetHealth — healthy fleet', () => {
  it('reports every tenant healthy and overall ok (exit 0)', async () => {
    const report = await checkFleetHealth(greenDeps())
    expect(report.ok).toBe(true)
    expect(fleetExitCode(report)).toBe(0)
    expect(report.tenants).toHaveLength(1)
    const row = report.tenants[0]
    expect(row.slug).toBe('t2')
    expect(row.status).toBe('active')
    expect(row.healthy).toBe(true)
    // every probe ran and passed
    expect(row.checks.every((c) => c.ok)).toBe(true)
    expect(row.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(['data-plane', 'migrations', 'realm-oidc', 'satellites', 'leaf']),
    )
  })

  it('runs the data-plane / migration / OIDC / satellite / leaf probes for an active tenant', async () => {
    const deps = greenDeps()
    await checkFleetHealth(deps)
    expect(deps.probeDataPlane).toHaveBeenCalledOnce()
    expect(deps.probeMigrations).toHaveBeenCalledOnce()
    expect(deps.probeRealmOidc).toHaveBeenCalledOnce()
    expect(deps.probeSatellites).toHaveBeenCalledOnce()
    expect(deps.probeLeaf).toHaveBeenCalledOnce()
  })
})

describe('checkFleetHealth — one failing tenant', () => {
  it('marks the named tenant unhealthy and the whole fleet NOT ok (exit 1)', async () => {
    const deps = greenDeps({
      listTenants: async () => [tenant({ id: 'id-a', slug: 'aaa' }), tenant({ id: 'id-b', slug: 'bbb' })],
      probeDataPlane: vi.fn(async (t) =>
        t.slug === 'bbb' ? { ok: false, error: 'connection refused' } : { ok: true },
      ),
    })
    const report = await checkFleetHealth(deps)
    expect(report.ok).toBe(false)
    expect(fleetExitCode(report)).toBe(1)
    const aaa = report.tenants.find((r) => r.slug === 'aaa')!
    const bbb = report.tenants.find((r) => r.slug === 'bbb')!
    expect(aaa.healthy).toBe(true)
    expect(bbb.healthy).toBe(false)
    const dp = bbb.checks.find((c) => c.name === 'data-plane')!
    expect(dp.ok).toBe(false)
    expect(dp.detail).toMatch(/connection refused/)
  })

  it('a failing migration ledger row makes the tenant unhealthy', async () => {
    const deps = greenDeps({
      probeMigrations: vi.fn(async () => ({
        ok: false,
        schemaVersion: '038_kind_catalog.sql',
        lastRun: { ok: false, finishedAt: new Date(), error: 'migration 039 failed' },
      })),
    })
    const report = await checkFleetHealth(deps)
    expect(report.ok).toBe(false)
    const row = report.tenants[0]
    expect(row.healthy).toBe(false)
    expect(row.checks.find((c) => c.name === 'migrations')!.detail).toMatch(/039 failed/)
  })

  it('a failing realm OIDC discovery makes the tenant unhealthy', async () => {
    const deps = greenDeps({
      probeRealmOidc: vi.fn(async () => ({ ok: false, error: 'discovery 404' })),
    })
    const report = await checkFleetHealth(deps)
    expect(report.ok).toBe(false)
    expect(report.tenants[0].checks.find((c) => c.name === 'realm-oidc')!.detail).toMatch(/404/)
  })

  it('a failed satellite ledger state makes the tenant unhealthy', async () => {
    const deps = greenDeps({
      probeSatellites: vi.fn(async () => ({ nextcloud: 'failed', matrix: 'ok' })),
    })
    const report = await checkFleetHealth(deps)
    expect(report.ok).toBe(false)
    expect(report.tenants[0].checks.find((c) => c.name === 'satellites')!.detail).toMatch(/nextcloud/)
  })
})

describe('checkFleetHealth — suspended tenant', () => {
  it('reports a suspended tenant as `suspended`, NOT unhealthy, and never probes its data plane', async () => {
    const deps = greenDeps({
      listTenants: async () => [tenant({ status: 'suspended' })],
    })
    const report = await checkFleetHealth(deps)
    // a suspended tenant is an expected lifecycle state — it must not flip the
    // fleet to unhealthy (exit 0).
    expect(report.ok).toBe(true)
    expect(fleetExitCode(report)).toBe(0)
    const row = report.tenants[0]
    expect(row.status).toBe('suspended')
    expect(row.healthy).toBe(true)
    // the data-plane / OIDC / leaf probes are SKIPPED — a suspended data plane may be
    // quarantined; touching it is exactly what the resolver refuses to do.
    expect(deps.probeDataPlane).not.toHaveBeenCalled()
    expect(deps.probeRealmOidc).not.toHaveBeenCalled()
    expect(deps.probeMigrations).not.toHaveBeenCalled()
    expect(deps.probeSatellites).not.toHaveBeenCalled()
    expect(deps.probeLeaf).not.toHaveBeenCalled()
  })

  it('a suspended tenant alongside a healthy active tenant keeps the fleet ok', async () => {
    const deps = greenDeps({
      listTenants: async () => [
        tenant({ id: 'id-s', slug: 'sss', status: 'suspended' }),
        tenant({ id: 'id-a', slug: 'aaa', status: 'active' }),
      ],
    })
    const report = await checkFleetHealth(deps)
    expect(report.ok).toBe(true)
    expect(report.tenants.find((r) => r.slug === 'sss')!.healthy).toBe(true)
    expect(report.tenants.find((r) => r.slug === 'aaa')!.healthy).toBe(true)
    // the active tenant WAS fully probed
    expect(deps.probeDataPlane).toHaveBeenCalledOnce()
  })
})

describe('checkFleetHealth — empty fleet', () => {
  it('an empty registry is vacuously healthy (exit 0)', async () => {
    const report = await checkFleetHealth(greenDeps({ listTenants: async () => [] }))
    expect(report.ok).toBe(true)
    expect(fleetExitCode(report)).toBe(0)
    expect(report.tenants).toEqual([])
  })
})

describe('renderHealthTable', () => {
  it('renders one row per tenant naming the slug, status and an overall verdict', async () => {
    const report = await checkFleetHealth(
      greenDeps({
        listTenants: async () => [tenant({ id: 'id-a', slug: 'aaa' }), tenant({ id: 'id-b', slug: 'bbb' })],
        probeDataPlane: vi.fn(async (t) => (t.slug === 'bbb' ? { ok: false, error: 'down' } : { ok: true })),
      }),
    )
    const table = renderHealthTable(report)
    expect(table).toContain('aaa')
    expect(table).toContain('bbb')
    // the failed tenant's failed check is named in the table
    expect(table).toMatch(/bbb[\s\S]*data-plane|data-plane[\s\S]*bbb/)
    // an overall verdict line
    expect(table).toMatch(/UNHEALTHY|FAIL/i)
  })

  it('names the failing check on an unhealthy row', () => {
    const rows: TenantHealthRow[] = [
      {
        slug: 'bbb',
        id: 'id-b',
        status: 'active',
        healthy: false,
        checks: [
          { name: 'data-plane', ok: false, detail: 'connection refused' },
          { name: 'migrations', ok: true, detail: '' },
        ],
      },
    ]
    const table = renderHealthTable({ ok: false, tenants: rows })
    expect(table).toContain('connection refused')
  })
})

// ── T21 leaf health probe tests ───────────────────────────────────────────────

describe('checkFleetHealth — leaf probe (T21, §8.7)', () => {
  it('includes a leaf check in the active tenant checks', async () => {
    const report = await checkFleetHealth(greenDeps())
    const row = report.tenants[0]
    const leaf = row.checks.find((c) => c.name === 'leaf')
    expect(leaf).toBeDefined()
    expect(leaf!.ok).toBe(true)
  })

  it('a failing leaf probe makes the tenant unhealthy and the fleet NOT ok', async () => {
    const deps = greenDeps({
      probeLeaf: vi.fn(async (): Promise<LeafProbe> => ({ ok: false, error: 'newsletter service unreachable' })),
    })
    const report = await checkFleetHealth(deps)
    expect(report.ok).toBe(false)
    expect(fleetExitCode(report)).toBe(1)
    const row = report.tenants[0]
    expect(row.healthy).toBe(false)
    const leaf = row.checks.find((c) => c.name === 'leaf')
    expect(leaf!.ok).toBe(false)
    expect(leaf!.detail).toMatch(/newsletter service unreachable/)
  })

  it('probeLeaf is NOT called for a suspended tenant', async () => {
    const deps = greenDeps({
      listTenants: async () => [tenant({ status: 'suspended' })],
    })
    const report = await checkFleetHealth(deps)
    expect(report.ok).toBe(true)
    expect(deps.probeLeaf).not.toHaveBeenCalled()
  })

  it('leaf probe failure is still reported as a named check (probe itself throws)', async () => {
    const deps = greenDeps({
      probeLeaf: vi.fn(async (): Promise<LeafProbe> => { throw new Error('probe crashed') }),
    })
    const report = await checkFleetHealth(deps)
    expect(report.ok).toBe(false)
    const row = report.tenants[0]
    const leaf = row.checks.find((c) => c.name === 'leaf')
    expect(leaf).toBeDefined()
    expect(leaf!.ok).toBe(false)
    expect(leaf!.detail).toMatch(/probe crashed/)
  })
})

describe('renderHealthTable — leaf subscribers/newsletters appended (T21)', () => {
  it('appends subscriber and newsletter counts to a passing leaf check row', async () => {
    const report = await checkFleetHealth(
      greenDeps({
        probeLeaf: vi.fn(async (): Promise<LeafProbe> => ({ ok: true, subscribers: 17, newsletters: 5 })),
      }),
    )
    const table = renderHealthTable(report)
    // The leaf counts should appear somewhere in the table for the healthy tenant
    expect(table).toMatch(/17.*sub|sub.*17/i)
    expect(table).toMatch(/5.*nl|nl.*5/i)
  })

  it('does not append counts when leaf check is absent', () => {
    const rows: TenantHealthRow[] = [
      {
        slug: 't2',
        id: 'id-t2',
        status: 'active',
        healthy: true,
        checks: [
          { name: 'data-plane', ok: true, detail: '' },
          { name: 'migrations', ok: true, detail: '' },
          { name: 'realm-oidc', ok: true, detail: '' },
          { name: 'satellites', ok: true, detail: '' },
        ],
      },
    ]
    const table = renderHealthTable({ ok: true, tenants: rows })
    expect(table).not.toMatch(/sub|nl\b/i)
  })
})
