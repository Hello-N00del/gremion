// packages/tenant-store/test/fixtures/service.ts
//
// Q1: the fixture service. A plain node:http server that serves two tenants
// of one module through the package's API only: schemaGate in front of every
// tenant route, openTenantDb behind it, no migration anywhere (no boot
// migration). Each real service re-proves this when it adopts the package
// (TASK-077 / TASK-084).
import { createServer, type Server } from 'node:http'
import type { SchemaGate } from '../../src/schema-gate.js'
import type { TenantStore } from '../../src/store.js'

export function createFixtureService({ store, gate, tenants }: { store: TenantStore; gate: SchemaGate; tenants: ReadonlySet<string> }): Server {
  return createServer((req, res) => {
    void (async () => {
      const m = /^\/t\/([^/]+)\/items$/.exec(req.url ?? '')
      if (req.method !== 'GET' || !m || !tenants.has(m[1]!)) {
        res.writeHead(404).end()
        return
      }
      const tenantId = m[1]!
      if (!(await gate.guard(tenantId, res))) return
      const sql = await store.openTenantDb(tenantId, 'fixture')
      const [row] = await sql<{ db: string; n: number }[]>`SELECT current_database() AS db, count(*)::int AS n FROM item`
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ tenant: tenantId, database: row!.db, items: row!.n }))
    })().catch((err: unknown) => {
      console.error('[fixture-service]', err)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
}
