import { describe, it, expect, beforeAll } from 'vitest'
import { getControlDb } from './control-db'
import { runControlMigrations } from './control-migrations'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyMigrationIntegrity } from '$lib/server/db'

describe('runControlMigrations', () => {
  beforeAll(async () => { await runControlMigrations() })

  it('creates the tenant and tenant_provisioning_resource tables', async () => {
    const rows = await getControlDb()<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('tenant','tenant_provisioning_resource')
      ORDER BY table_name`
    expect(rows.map((r) => r.table_name)).toEqual(['tenant', 'tenant_provisioning_resource'])
  })

  // P2.1b T1 — fleet-run ledger (D-FLEET): one row per (tenant, fleet run),
  // written by the T2 fleet-migration runner.
  it('creates the tenant_migration_run ledger with its columns, FK cascade and index', async () => {
    const cols = await getControlDb()<Array<{ column_name: string; is_nullable: string }>>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenant_migration_run'
      ORDER BY column_name`
    expect(cols.map((c) => c.column_name)).toEqual([
      'error', 'finished_at', 'id', 'last_applied', 'ok', 'started_at', 'tenant_id',
    ])
    const notNull = cols.filter((c) => c.is_nullable === 'NO').map((c) => c.column_name)
    expect(notNull).toEqual(['id', 'started_at', 'tenant_id'])

    const fk = await getControlDb()<Array<{ confdeltype: string }>>`
      SELECT confdeltype FROM pg_constraint
      WHERE conrelid = 'tenant_migration_run'::regclass AND contype = 'f'`
    expect(fk).toEqual([{ confdeltype: 'c' }]) // ON DELETE CASCADE

    const idx = await getControlDb()<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'tenant_migration_run'
        AND indexname = 'tenant_migration_run_tenant_started_idx'`
    expect(idx).toHaveLength(1)
    expect(idx[0].indexdef).toMatch(/\(tenant_id, started_at DESC\)/)
  })

  it('records the migration in schema_migrations and is idempotent on re-run', async () => {
    const before = await getControlDb()<Array<{ filename: string }>>`
      SELECT filename FROM schema_migrations ORDER BY filename`
    expect(before.map((r) => r.filename)).toContain('001_tenant_registry.sql')
    expect(before.map((r) => r.filename)).toContain('002_tenant_migration_runs.sql')
    await runControlMigrations()
    const after = await getControlDb()<Array<{ c: number }>>`
      SELECT count(*)::int AS c FROM schema_migrations`
    expect(after[0].c).toBe(before.length)
  })

  it('enforces the slug CHECK at the store level', async () => {
    await expect(
      getControlDb()`
        INSERT INTO tenant
          (slug, status, db_conn_ref, realm_name, issuer, kc_internal,
           kc_client_id, kc_client_ref, auth_client_ref, nc_target, matrix_space, domain_profile,
           brand_ref, blueprint_ref, conn_profile, backup_key_ref, audiences)
        VALUES
          ('Bad_Slug', 'active', 'r', 'r', 'r', 'r', 'r', 'r', 'r',
           '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'r', 'r', '{}'::jsonb, 'r',
           ARRAY['a'])`,
    ).rejects.toThrow(/violates check constraint/i)
  })
})

// §T.1 — control migration 004 is a TWO-FILE change OWNED BY B4: the DDL and
// the SHA-256 entry in migrations-control/manifest.json, which
// control-migrations.ts:21,26 loads and verifies before applying anything.
// B8 does not create either file; this block verifies B4's bytes are the shape
// B8's tenant_domain accessors and host-keyed cache depend on.
describe('004_tenant_domain', () => {
  beforeAll(async () => { await runControlMigrations() })

  it('creates tenant_domain with the lower(host) + no-whitespace-no-comma CHECK', async () => {
    const cols = await getControlDb()<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenant_domain'
      ORDER BY column_name`
    expect(cols.map((c) => c.column_name)).toEqual([
      'created_at', 'host', 'is_primary', 'tenant_id', 'verified_at',
    ])
    const check = await getControlDb()<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'tenant_domain'::regclass AND contype = 'c'`
    expect(check.map((r) => r.def).join(' ')).toMatch(/lower\(host\)/)
    expect(check.map((r) => r.def).join(' ')).toMatch(/\[\[:space:\],\]/)
  })

  it('creates the one-primary partial unique index and the tenant index', async () => {
    const idx = await getControlDb()<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'tenant_domain'
      ORDER BY indexname`
    const byName = Object.fromEntries(idx.map((r) => [r.indexname, r.indexdef]))
    expect(byName['tenant_domain_one_primary']).toMatch(/UNIQUE.*\(tenant_id\).*WHERE is_primary/)
    expect(byName['tenant_domain_tenant']).toMatch(/\(tenant_id\)/)
  })

  it('records 004 in schema_migrations', async () => {
    const rows = await getControlDb()<Array<{ filename: string }>>`
      SELECT filename FROM schema_migrations WHERE filename = '004_tenant_domain.sql'`
    expect(rows).toHaveLength(1)
  })

  it('fails the run when the manifest has no 004 entry', () => {
    const text = readFileSync(
      join(process.cwd(), 'migrations-control', '004_tenant_domain.sql'), 'utf-8')
    expect(() =>
      verifyMigrationIntegrity('004_tenant_domain.sql', text, {
        '001_tenant_registry.sql': 'c0faf73b5256839986a839bc68a9a81385b6b07da6cbe93aa4993363ac076b43',
      }),
    ).toThrow('Migration 004_tenant_domain.sql missing from manifest')
  })
})
