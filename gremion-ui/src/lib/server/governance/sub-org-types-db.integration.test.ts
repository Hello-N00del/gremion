// src/lib/server/governance/sub-org-types-db.integration.test.ts
// Schema-level assertions for the sub_org_type table land here first so
// migration 018 can be TDD'd ahead of the repo (Commit 2 fills out the
// CRUD round-trip tests against the same file).
import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '$lib/server/db'
import {
  listSubOrgTypes,
  getSubOrgType,
  createSubOrgType,
  deleteSubOrgType,
  subOrgTypesDb,
  type SubOrgType
} from './sub-org-types-db'

describe('migration 018_sub_org_type — schema shape', () => {
  it('public.sub_org_type has the expected columns', async () => {
    const rows = await getDb()<Array<{
      column_name: string
      data_type: string
      is_nullable: 'YES' | 'NO'
      column_default: string | null
    }>>`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sub_org_type'
      ORDER BY ordinal_position
    `
    const byName = new Map(rows.map((r) => [r.column_name, r]))

    expect(byName.get('id')).toMatchObject({
      data_type: 'bigint',
      is_nullable: 'NO'
    })
    // BIGSERIAL → defaults to nextval(...) on the implicit sequence.
    expect(byName.get('id')?.column_default).toMatch(/^nextval\(/)

    expect(byName.get('name')).toMatchObject({
      data_type: 'text',
      is_nullable: 'NO'
    })

    expect(byName.get('description')).toMatchObject({
      data_type: 'text',
      is_nullable: 'YES'
    })

    expect(byName.get('created_at')).toMatchObject({
      data_type: 'timestamp with time zone',
      is_nullable: 'NO'
    })
    expect(byName.get('created_at')?.column_default).toMatch(/now\(\)/)
  })

  it('public.sub_org_type has a UNIQUE constraint on name', async () => {
    const rows = await getDb()<Array<{ constraint_type: string }>>`
      SELECT tc.constraint_type
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
       AND tc.table_schema    = ccu.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.table_name   = 'sub_org_type'
        AND ccu.column_name = 'name'
        AND tc.constraint_type = 'UNIQUE'
    `
    expect(rows.length).toBeGreaterThanOrEqual(1)
  })
})

describe('sub-org-types-db — CRUD round-trip', () => {
  beforeEach(async () => {
    // Truncate the catalog before every test so insert IDs are deterministic
    // for the asserts below.
    await getDb()`TRUNCATE sub_org_type RESTART IDENTITY CASCADE`
  })

  it('list returns [] on an empty table', async () => {
    const rows = await listSubOrgTypes()
    expect(rows).toEqual([])
  })

  it('createSubOrgType inserts a row and returns the parsed shape', async () => {
    const t = await createSubOrgType({ name: 'AG', description: 'Arbeitsgruppe' })
    expect(t.id).toBeTypeOf('number')
    expect(t.name).toBe('AG')
    expect(t.description).toBe('Arbeitsgruppe')

    // null description survives the boundary without becoming "null".
    const t2 = await createSubOrgType({ name: 'Referat' })
    expect(t2.description).toBeNull()
  })

  it('getSubOrgType returns the row by id and null on miss', async () => {
    const created = await createSubOrgType({ name: 'Projektgruppe', description: null })
    const got = await getSubOrgType(created.id)
    expect(got).toEqual<SubOrgType>({ id: created.id, name: 'Projektgruppe', description: null })

    expect(await getSubOrgType(9_999_999)).toBeNull()
  })

  it('list returns inserted rows ordered by id', async () => {
    const a = await createSubOrgType({ name: 'AG' })
    const b = await createSubOrgType({ name: 'Referat' })
    const rows = await listSubOrgTypes()
    expect(rows.map((r) => r.id)).toEqual([a.id, b.id])
    expect(rows.map((r) => r.name)).toEqual(['AG', 'Referat'])
  })

  it('deleteSubOrgType removes the row', async () => {
    const t = await createSubOrgType({ name: 'Temp' })
    await deleteSubOrgType(t.id)
    expect(await getSubOrgType(t.id)).toBeNull()
    expect(await listSubOrgTypes()).toEqual([])
  })

  it('subOrgTypesDb namespace exposes list / getById / insert / delete', () => {
    expect(typeof subOrgTypesDb.list).toBe('function')
    expect(typeof subOrgTypesDb.getById).toBe('function')
    expect(typeof subOrgTypesDb.insert).toBe('function')
    expect(typeof subOrgTypesDb.delete).toBe('function')
  })

  it('insert + delete work inside a caller-supplied transaction', async () => {
    // A rollback must leave the table empty, proving the tx? overload routes
    // SQL through the caller's tx handle rather than the global pool.
    await getDb()
      .begin(async (tx) => {
        await subOrgTypesDb.insert(tx, { name: 'InsideTx' })
        const inside = await subOrgTypesDb.list(tx)
        expect(inside.length).toBe(1)
        throw new Error('rollback-marker')
      })
      .catch((e) => {
        if (e.message !== 'rollback-marker') throw e
      })
    expect(await listSubOrgTypes()).toEqual([])
  })
})
