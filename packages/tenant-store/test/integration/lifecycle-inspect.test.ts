// TASK-021 TDD 10 (TRD-089) on the scratch stack: per server, pg_database
// minus the closed platformDatabases list (@gremion/module-catalogue, read
// from the harness's own compose labels) equals the (customer, enabled
// module) set plus each customer's kernel database; no database holds two
// customers' rows; zero inspected columns fails. RED on each of: an extra
// t_ database, an extra non-t_ database, a foreign customer_id row, zero
// columns, and (Amendment R27) an undeclared platform database.
import type { Sql } from '@gremion/db'
import { platformDatabases } from '@gremion/module-catalogue/runtime'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { enableModule, inspectTenantDatabases, type InspectRegistry, type InspectServer } from '../../src/lifecycle/index.js'
import { tenantModuleDbName } from '../../src/names.js'
import { connect, connectModule } from '../harness/db.js'
import {
  harnessCompose,
  KERNEL_SERVICE,
  lcfixModule,
  lifecycleDeps,
  MODULE_SERVICE,
  moduleServer,
  OPERATOR,
  platformDb,
  resetModuleServer,
  seedCatalogue,
} from '../harness/lifecycle.js'

describe('inspectTenantDatabases (TRD-089) on the scratch stack', () => {
  const { A, B } = inject('tenants')
  let platform: Sql
  let server: ReturnType<typeof moduleServer>
  let kernelAdmin: Sql
  const compose = () => harnessCompose()
  const plain = lcfixModule()
  const withSynapse = lcfixModule({ platformServer: { postgresService: MODULE_SERVICE, databases: ['synapse'] } })

  const servers = (catalogue = [plain]): InspectServer[] => [
    {
      service: KERNEL_SERVICE,
      kind: 'kernel',
      platformDatabases: platformDatabases(KERNEL_SERVICE, { compose: compose(), catalogue }),
      admin: kernelAdmin,
      open: (db) => connect(db, { max: 1 }),
    },
    {
      service: MODULE_SERVICE,
      kind: 'module',
      platformDatabases: platformDatabases(MODULE_SERVICE, { compose: compose(), catalogue }),
      admin: server.admin,
      open: (db) => connectModule(db, { max: 1 }),
    },
  ]
  // 2 customers (A, B); 3 enabled pairs with a database: TASK-020's fixture
  // module on the kernel test server for A and B, and lcfix on pgm for A.
  const registry = (): InspectRegistry => ({
    customers: [A, B],
    enabled: [
      { tenantId: A, moduleId: 'fixture', postgresService: KERNEL_SERVICE },
      { tenantId: B, moduleId: 'fixture', postgresService: KERNEL_SERVICE },
      { tenantId: A, moduleId: 'lcfix', postgresService: MODULE_SERVICE },
    ],
  })

  beforeAll(async () => {
    platform = platformDb()
    server = moduleServer()
    kernelAdmin = connect('t020_test_admin', { max: 1 })
    await seedCatalogue(platform, 'lcfix')
    await resetModuleServer(server.admin, platform)
    await enableModule(A, plain, OPERATOR, lifecycleDeps(platform, server))
    const a = connectModule(tenantModuleDbName(A, 'lcfix'), { max: 1 })
    try {
      await a`INSERT INTO item (customer_id, note) VALUES (${A}, 'a')`
      await a`INSERT INTO audit (tenant_id) VALUES (${A})`
    } finally {
      await a.end()
    }
  })

  afterAll(async () => {
    await resetModuleServer(server.admin, platform)
    await kernelAdmin.end()
    await server.close()
    await platform.end()
  })

  it('the harness compose gives the closed lists: kernel Q6 list + its POSTGRES_DB; module server built-ins + its POSTGRES_USER database', () => {
    expect(platformDatabases(KERNEL_SERVICE, { compose: compose(), catalogue: [plain] })).toEqual(
      ['control', 'gremion', 'gremion_platform', 'keycloak', 'postgres', 't020_test_admin', 'template0', 'template1'],
    )
    expect(platformDatabases(MODULE_SERVICE, { compose: compose(), catalogue: [plain] })).toEqual(['postgres', 't020_test', 'template0', 'template1'])
  })

  it('TDD 10: 2 customers, 3 enabled pairs -> the database lists equal the expected sets and no database holds two customers\' rows', async () => {
    const r = await inspectTenantDatabases(servers(), registry())
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.servers.find((s) => s.service === KERNEL_SERVICE)?.actual).toEqual(
      [tenantModuleDbName(A, 'fixture'), tenantModuleDbName(A, 'kernel'), tenantModuleDbName(B, 'fixture'), tenantModuleDbName(B, 'kernel')].sort(),
    )
    expect(r.servers.find((s) => s.service === MODULE_SERVICE)?.actual).toEqual([tenantModuleDbName(A, 'lcfix')])
    expect(r.inspectedColumns).toBe(2)
  })

  it('TDD 10a: a seeded extra t_ database -> RED', async () => {
    const extra = tenantModuleDbName(B, 'lcfix')
    await server.admin.unsafe(`CREATE DATABASE ${extra}`)
    try {
      const r = await inspectTenantDatabases(servers(), registry())
      expect(r.ok).toBe(false)
      expect(r.problems).toEqual([`${MODULE_SERVICE}: extra database ${extra} — neither in the closed platform list nor a (customer, enabled module) or customer kernel database`])
    } finally {
      await server.admin.unsafe(`DROP DATABASE IF EXISTS ${extra} WITH (FORCE)`)
    }
  })

  it('TDD 10b: a seeded extra non-t_ database (dbNameForSlug-style) -> RED, so the list is closed and not a t_ filter', async () => {
    await server.admin.unsafe('CREATE DATABASE lcfix_t020a')
    try {
      const r = await inspectTenantDatabases(servers(), registry())
      expect(r.problems).toEqual([`${MODULE_SERVICE}: extra database lcfix_t020a — neither in the closed platform list nor a (customer, enabled module) or customer kernel database`])
    } finally {
      await server.admin.unsafe('DROP DATABASE IF EXISTS lcfix_t020a WITH (FORCE)')
    }
  })

  it("TDD 10c: a foreign customer_id row in A's database -> RED", async () => {
    const a = connectModule(tenantModuleDbName(A, 'lcfix'), { max: 1 })
    try {
      await a`INSERT INTO item (customer_id, note) VALUES (${B}, 'b in a')`
      const r = await inspectTenantDatabases(servers(), registry())
      expect(r.problems).toEqual([`${MODULE_SERVICE}/${tenantModuleDbName(A, 'lcfix')}: public.item.customer_id holds 1 row(s) of another customer (owner ${A})`])
    } finally {
      await a`DELETE FROM item WHERE customer_id = ${B}`
      await a.end()
    }
  })

  it('TDD 10d: zero inspected columns -> RED', async () => {
    const r = await inspectTenantDatabases(servers(), {
      customers: [A, B],
      enabled: [
        { tenantId: A, moduleId: 'fixture', postgresService: KERNEL_SERVICE },
        { tenantId: B, moduleId: 'fixture', postgresService: KERNEL_SERVICE },
      ],
    })
    expect(r.inspectedColumns).toBe(0)
    expect(r.problems).toContain(`${MODULE_SERVICE}: extra database ${tenantModuleDbName(A, 'lcfix')} — neither in the closed platform list nor a (customer, enabled module) or customer kernel database`)
    expect(r.problems.some((p) => /zero customer_id\/tenant_id columns inspected/.test(p))).toBe(true)
  })

  it('Amendment R27 test 10e: synapse on the module server is equality when declared as a platform database, RED when not', async () => {
    await server.admin.unsafe('CREATE DATABASE synapse')
    try {
      const declared = await inspectTenantDatabases(servers([withSynapse]), registry())
      expect(declared.problems).toEqual([])
      const undeclared = await inspectTenantDatabases(servers([plain]), registry())
      expect(undeclared.problems).toEqual([`${MODULE_SERVICE}: extra database synapse — neither in the closed platform list nor a (customer, enabled module) or customer kernel database`])
    } finally {
      await server.admin.unsafe('DROP DATABASE IF EXISTS synapse WITH (FORCE)')
    }
  })
})
