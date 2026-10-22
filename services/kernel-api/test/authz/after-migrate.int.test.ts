// A fresh customer has the catalogue after migrate: the real database, the real sync.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { syncAfterMigrate } from '../../src/authz/after-migrate.ts'
import type { AuthzCliDeps } from '../../src/authz/cli.ts'
import { CAPABILITIES, ROLES } from '../../src/authz/catalogue.ts'
import { buildKernelDb, type KernelDb } from './db.ts'
import { moduleIds } from './world.ts'

let db: KernelDb
beforeAll(async () => {
  db = await buildKernelDb('aftermigrate')
})
afterAll(async () => {
  await db?.close()
})

describe('catalogue after migrate', () => {
  it('a migrated customer has no catalogue rows until the after-migrate sync, and the whole catalogue after it (twice: idempotent)', async () => {
    const n = async (t: 'role' | 'capability') => Number((await db.admin.unsafe(`SELECT count(*)::int AS n FROM idt.${t}`))[0]!.n)
    expect([await n('role'), await n('capability')]).toEqual([0, 0])
    const deps: AuthzCliDeps = {
      listCustomerIds: async () => [db.customerId],
      lookup: async (id) => ({ customerId: id, slug: 's', status: 'active', realm: 'r', issuer: 'i', kcInternal: 'k', dbConnRef: 'x' }),
      db: async () => db.app,
      moduleIds: async () => moduleIds,
      enabledModules: async () => new Set(['publishing', 'votes', 'board', 'calendar', 'finance']),
    }
    for (let i = 0; i < 2; i++) expect(await syncAfterMigrate(['migrate', '--customer', db.customerId], 0, { out: () => undefined, err: () => undefined }, () => deps)).toBe(0)
    expect(await n('role')).toBe(ROLES.length)
    expect(await n('capability')).toBe(CAPABILITIES.length)
  })
})
