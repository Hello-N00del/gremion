// services/kernel-api/src/tenancy/store.ts — the control registry, read-only
// (Q1: control tenant / tenant_domain are the registry of record; the tnt.*
// move is TASK-192's). Connected as the kernel API's SELECT-only reader role
// (ensureKernelApiReader, C13). No cache (Q9): every request reads afresh.
//
// TRD-082: lookupHost is pinned exemption 1 (tenant_domain WHERE host = $1:
// the host IS the selector, no customer id exists yet); lookupId carries the
// customer id. The query recorder test holds both to that.
import type { Sql } from '@gremion/db'
import type { TenancyStore, TenantRow, TenantStatus } from '../app/deps.ts'

interface Row {
  id: string
  slug: string
  status: TenantStatus
  realm_name: string
  issuer: string
  kc_internal: string
  db_conn_ref: string
}

const hydrate = (r: Row): TenantRow => ({
  customerId: r.id,
  slug: r.slug,
  status: r.status,
  realm: r.realm_name,
  issuer: r.issuer,
  kcInternal: r.kc_internal,
  dbConnRef: r.db_conn_ref,
})

export function controlTenancyStore(control: Sql): TenancyStore {
  return {
    async lookupHost(host) {
      const rows = await control<Row[]>`
        SELECT t.id::text AS id, t.slug, t.status, t.realm_name, t.issuer, t.kc_internal, t.db_conn_ref
          FROM public.tenant_domain d JOIN public.tenant t ON t.id = d.tenant_id
         WHERE d.host = ${host}`
      if (rows.length > 1) throw new Error('tenant_domain answered more than one row for one host (its primary key is broken)')
      return rows[0] ? hydrate(rows[0]) : null
    },
    async listActive() {
      const rows = await control<Row[]>`
        SELECT t.id::text AS id, t.slug, t.status, t.realm_name, t.issuer, t.kc_internal, t.db_conn_ref
          FROM public.tenant t WHERE t.status = 'active' ORDER BY t.id`
      return rows.map(hydrate)
    },
    async lookupId(customerId) {
      const rows = await control<Row[]>`
        SELECT t.id::text AS id, t.slug, t.status, t.realm_name, t.issuer, t.kc_internal, t.db_conn_ref
          FROM public.tenant t
         WHERE t.id = ${customerId}::uuid`
      return rows[0] ? hydrate(rows[0]) : null
    },
  }
}
