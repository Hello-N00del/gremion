// packages/tenant-store/src/lifecycle/inspect.ts
//
// inspectTenantDatabases(servers, registry): TRD-089. Per server, the
// databases in pg_database MINUS that server's closed platformDatabases list
// (never a `t_` prefix filter, Q6) must EQUAL the expected set exactly:
//   kernel server: tenantModuleDbName(customer, 'kernel') per customer
//   every server:  tenantModuleDbName(customer, module) per enabled pair on it
// An extra database (a t_ one or any other) and a missing one both fail. Then
// every customer_id / tenant_id column of every expected database must hold
// only that database's customer; zero inspected columns fails (a scan that
// read nothing proves nothing).
import type { Sql } from '@gremion/db'
import { assertTenantId, tenantModuleDbName } from '../names.js'
import { serverFormat } from './ddl.js'

export interface InspectServer {
  /** The compose service name (for the report). */
  service: string
  kind: 'kernel' | 'module'
  /** The closed list: @gremion/module-catalogue platformDatabases(service). */
  platformDatabases: readonly string[]
  /** A superuser connection to the server's maintenance database. */
  admin: Sql
  /** Opens a read connection to one database on this server; the inspection ends it. */
  open(database: string): Sql | Promise<Sql>
}

export interface InspectRegistry {
  /** Every customer (tenant) of the installation. */
  customers: readonly string[]
  /** Every enabled (customer, module) pair with a database, and the server it lives on. */
  enabled: readonly { tenantId: string; moduleId: string; postgresService: string }[]
}

export interface ServerReport {
  service: string
  expected: string[]
  actual: string[]
  extra: string[]
  missing: string[]
}

export interface InspectionReport {
  ok: boolean
  problems: string[]
  servers: ServerReport[]
  inspectedDatabases: number
  inspectedColumns: number
}

const TENANT_COLUMNS = ['customer_id', 'tenant_id'] as const

export async function inspectTenantDatabases(servers: readonly InspectServer[], registry: InspectRegistry): Promise<InspectionReport> {
  const problems: string[] = []
  const reports: ServerReport[] = []
  let inspectedDatabases = 0
  let inspectedColumns = 0
  if (servers.length === 0) problems.push('no server inspected — the inspection would pass vacuously')
  for (const c of registry.customers) assertTenantId(c)

  const services = new Set(servers.map((s) => s.service))
  for (const p of registry.enabled) {
    if (!services.has(p.postgresService)) problems.push(`enabled (${p.tenantId}, ${p.moduleId}) lives on ${p.postgresService}, which is not among the inspected servers`)
  }

  for (const server of servers) {
    // expected database -> its owning customer
    const owner = new Map<string, string>()
    if (server.kind === 'kernel') for (const c of registry.customers) owner.set(tenantModuleDbName(c, 'kernel'), c)
    for (const p of registry.enabled) if (p.postgresService === server.service) owner.set(tenantModuleDbName(p.tenantId, p.moduleId), p.tenantId)
    const closed = new Set(server.platformDatabases)
    const listed = (await server.admin<{ datname: string }[]>`SELECT datname FROM pg_database ORDER BY datname`).map((r) => r.datname)
    const actual = listed.filter((d) => !closed.has(d))
    const expected = [...owner.keys()].sort()
    const extra = actual.filter((d) => !owner.has(d))
    const missing = expected.filter((d) => !actual.includes(d))
    reports.push({ service: server.service, expected, actual, extra, missing })
    for (const d of extra) problems.push(`${server.service}: extra database ${d} — neither in the closed platform list nor a (customer, enabled module) or customer kernel database`)
    for (const d of missing) problems.push(`${server.service}: missing database ${d}`)

    for (const db of expected) {
      if (!actual.includes(db)) continue
      const customer = owner.get(db) as string
      const sql = await server.open(db)
      try {
        const cols = await sql<{ table_schema: string; table_name: string; column_name: string }[]>`
          SELECT c.table_schema, c.table_name, c.column_name
            FROM information_schema.columns c
            JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
           WHERE c.column_name IN ${sql([...TENANT_COLUMNS])} AND t.table_type = 'BASE TABLE'
             AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
           ORDER BY 1, 2, 3`
        inspectedDatabases++
        for (const col of cols) {
          inspectedColumns++
          const stmt = await serverFormat(sql, 'SELECT count(*)::int AS n FROM %I.%I WHERE %I IS NOT NULL AND %I::text <> $1', [
            col.table_schema,
            col.table_name,
            col.column_name,
            col.column_name,
          ])
          const [r] = await sql.unsafe<{ n: number }[]>(stmt, [customer])
          if ((r?.n ?? 0) > 0) problems.push(`${server.service}/${db}: ${col.table_schema}.${col.table_name}.${col.column_name} holds ${r?.n} row(s) of another customer (owner ${customer})`)
        }
      } finally {
        await sql.end({ timeout: 5 })
      }
    }
  }
  if (inspectedColumns === 0) problems.push(`zero customer_id/tenant_id columns inspected across ${inspectedDatabases} database(s) — "no database holds two customers' rows" would pass vacuously`)
  return { ok: problems.length === 0, problems, servers: reports, inspectedDatabases, inspectedColumns }
}
