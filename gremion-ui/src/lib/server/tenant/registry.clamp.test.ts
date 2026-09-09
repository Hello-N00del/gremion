// src/lib/server/tenant/registry.clamp.test.ts
// P2.1b T11 — registerTenant routes conn_profile through the budget clamp
// (write-side contract; the pure clamp behavior lives in conn-profile.test.ts).
//
// Everything below the registry seam is mocked (same pattern as
// registry.cache.test.ts): this file pins that the WRITE applies the clamp —
// the INSERTed conn_profile JSONB can never exceed TENANT_DB_MAX_LIMIT and a
// malformed profile never reaches the control DB at all.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('$env/dynamic/private', () => ({ env: {} }))

const { sqlSpy, jsonSpy } = vi.hoisted(() => {
  const jsonSpy = vi.fn((v: unknown) => v)
  const sqlSpy = Object.assign(vi.fn(), { json: jsonSpy })
  return { sqlSpy, jsonSpy }
})
vi.mock('./control-db', () => ({ getControlDb: () => sqlSpy }))
vi.mock('./secrets', () => ({ resolveSecret: vi.fn(() => 'postgres://resolved') }))
vi.mock('$lib/server/db/pool-registry', async (importOriginal) => ({
  // Real budget constants (TENANT_DB_MAX_LIMIT is the contract under test);
  // mocked pool construction (no postgres-js client in a unit test).
  ...(await importOriginal<typeof import('$lib/server/db/pool-registry')>()),
  getPoolForTenant: vi.fn(() => ({ __pool: true }) as never),
  evictTenantPool: vi.fn(),
}))
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClient: vi.fn(() => ({ __kcAdmin: true }) as never),
  evictKeycloakAdminClient: vi.fn(),
}))
vi.mock('$lib/server/config', () => ({ readConfig: vi.fn(() => ({ __cfg: true }) as never) }))
vi.mock('$lib/server/brand', () => ({ brandFromConfig: vi.fn(() => ({ __brand: true }) as never) }))
vi.mock('$lib/server/jwt-verify', () => ({ evictJwks: vi.fn() }))
vi.mock('$lib/server/identity/display-names', () => ({ evictDisplayNameResolver: vi.fn() }))
vi.mock('$lib/server/messages/matrix-client', () => ({ evictMatrixClient: vi.fn() }))
vi.mock('$lib/server/messages/synapse-admin', () => ({ evictSynapseAdmin: vi.fn() }))
vi.mock('$lib/server/elections/helios-client', () => ({ evictHeliosSession: vi.fn() }))
vi.mock('$lib/server/messages/livekit-client', () => ({ evictLivekitSettings: vi.fn() }))

import { registerTenant, type TenantInput } from './registry'
import { TENANT_DB_MAX_LIMIT } from '$lib/server/db/pool-registry'

const tenantInput = (connProfile: Record<string, unknown>): TenantInput => ({
  slug: 'alpha',
  status: 'active',
  dbConnRef: 'env:DATABASE_URL',
  realmName: 'alpha-realm',
  issuer: 'https://alpha.example.org/auth/realms/alpha',
  kcInternal: 'http://keycloak:8080/auth/realms/alpha',
  kcClientId: 'gremion-admin',
  kcClientRef: 'env:KC_SECRET',
  authClientRef: 'env:AUTH_SECRET',
  ncTarget: {},
  matrixSpace: {},
  domainProfile: {},
  brandRef: 'config:alpha',
  blueprintRef: 'STURA_BLUEPRINT@1',
  connProfile,
  backupKeyRef: 'env:BACKUP_KEY',
  audiences: ['gremion-ui'],
})

// Full row for the post-INSERT getTenantBySlug SELECT (hydrate needs every column).
const tenantRow = (conn_profile: Record<string, unknown>) => ({
  id: 'tid-alpha',
  slug: 'alpha',
  status: 'active',
  db_conn_ref: 'env:DATABASE_URL',
  realm_name: 'alpha-realm',
  issuer: 'https://alpha.example.org/auth/realms/alpha',
  kc_internal: 'http://keycloak:8080/auth/realms/alpha',
  kc_client_id: 'gremion-admin',
  kc_client_ref: 'env:KC_SECRET',
  auth_client_ref: 'env:AUTH_SECRET',
  nc_target: {},
  matrix_space: {},
  domain_profile: {},
  brand_ref: 'config:alpha',
  blueprint_ref: 'STURA_BLUEPRINT@1',
  conn_profile,
  backup_key_ref: 'env:BACKUP_KEY',
  audiences: ['gremion-ui'],
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
})

/** The conn_profile JSONB the INSERT serialized (the only sql.json arg with perTenantMax). */
const insertedConnProfile = () =>
  jsonSpy.mock.calls.map((c) => c[0] as Record<string, unknown>).find((v) => v && 'perTenantMax' in v)

const inserts = () =>
  sqlSpy.mock.calls.filter((c) => (c[0] as readonly string[]).join('?').includes('INSERT INTO tenant')).length

beforeEach(() => {
  vi.clearAllMocks()
  sqlSpy.mockImplementation(async (strings: readonly string[]) => {
    const q = strings.join('?')
    if (q.includes('INSERT INTO tenant')) return []
    // T7 write-time uniqueness guard: the pre-INSERT clash probe filters on
    // `slug <>` — no other tenant exists in these clamp cases, so return none.
    if (q.includes('slug <>')) return []
    return [tenantRow({ perTenantMax: 4, prepare: true })]
  })
})

describe('T11 — registerTenant clamps conn_profile at the write', () => {
  it('an over-budget perTenantMax is CLAMPED in the INSERTed JSONB (and warned about)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await registerTenant(tenantInput({ perTenantMax: 64, prepare: true }))
      expect(inserts()).toBe(1)
      expect(insertedConnProfile()).toEqual({ perTenantMax: TENANT_DB_MAX_LIMIT, prepare: true })
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('an in-budget profile (the default tenant shape) is written UNCHANGED', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await registerTenant(tenantInput({ perTenantMax: 4, prepare: true }))
      expect(inserts()).toBe(1)
      expect(insertedConnProfile()).toEqual({ perTenantMax: 4, prepare: true })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('a MALFORMED perTenantMax rejects BEFORE anything reaches the control DB', async () => {
    await expect(registerTenant(tenantInput({ perTenantMax: 0 }))).rejects.toThrow(/perTenantMax/)
    expect(inserts()).toBe(0)
  })
})
