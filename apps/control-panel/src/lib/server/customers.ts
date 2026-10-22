// apps/control-panel/src/lib/server/customers.ts — what the panel READS: the
// control registry (tenant, tenant_domain) and, when configured, the
// provisioning ledger (gremion_platform plt.provisioning_step). The panel
// writes neither: every mutation is gremion-tenant's (Q6).
import postgres from 'postgres'
import type { PanelConfig } from './config'

/** The eight kinds in EXECUTION_ORDER (@gremion/provisioning). */
export const EXECUTION_ORDER = [
  'realm_created',
  'database_created',
  'domain_bound',
  'storage_prefix_reserved',
  'first_body_created',
  'broker_account_created',
  'mail_principal_issued',
  'first_accounts_created',
] as const
export type StepKind = (typeof EXECUTION_ORDER)[number]

export interface CustomerRow {
  id: string
  slug: string
  status: string
  host: string | null
  /** Done kinds out of eight, or null when no platform database is configured. */
  stepsDone: number | null
}

export interface CustomerStatus extends CustomerRow {
  steps: { kind: StepKind; status: 'pending' | 'done' | 'failed' | 'absent'; at: string | null }[] | null
}

let control: postgres.Sql | null = null
let platform: postgres.Sql | null = null

export function controlDb(c: PanelConfig): postgres.Sql {
  control ??= postgres(c.controlDatabaseUrl, { max: 2, idle_timeout: 30, connect_timeout: 10, onnotice: () => {} })
  return control
}

export function platformDb(c: PanelConfig): postgres.Sql | null {
  if (c.platformDatabaseUrl === null) return null
  platform ??= postgres(c.platformDatabaseUrl, { max: 2, idle_timeout: 30, connect_timeout: 10, onnotice: () => {} })
  return platform
}

export async function listCustomers(c: PanelConfig): Promise<CustomerRow[]> {
  const rows = await controlDb(c)<{ id: string; slug: string; status: string; host: string | null }[]>`
    SELECT t.id::text AS id, t.slug, t.status, d.host
      FROM tenant t LEFT JOIN tenant_domain d ON d.tenant_id = t.id AND d.is_primary
     ORDER BY t.slug`
  const p = platformDb(c)
  const done = new Map<string, number>()
  if (p && rows.length) {
    const counts = await p<{ customer_id: string; n: number }[]>`
      SELECT customer_id::text, count(DISTINCT step_kind)::int AS n
        FROM plt.provisioning_step WHERE status = 'done' AND customer_id = ANY(${rows.map((r) => r.id)}::uuid[])
       GROUP BY 1`
    for (const r of counts) done.set(r.customer_id, r.n)
  }
  return rows.map((r) => ({ ...r, stepsDone: p ? (done.get(r.id) ?? 0) : null }))
}

export async function customerStatus(c: PanelConfig, slug: string): Promise<CustomerStatus | null> {
  const all = await listCustomers(c)
  const row = all.find((r) => r.slug === slug)
  if (!row) return null
  const p = platformDb(c)
  if (!p) return { ...row, steps: null }
  const rows = await p<{ step_kind: string; status: 'pending' | 'done' | 'failed'; occurred_at: Date }[]>`
    SELECT step_kind, status, occurred_at FROM plt.provisioning_step
     WHERE customer_id = ${row.id} ORDER BY occurred_at, provisioning_step_id`
  const latest = new Map<string, { status: 'pending' | 'done' | 'failed'; at: string }>()
  for (const r of rows) {
    if (latest.get(r.step_kind)?.status === 'done') continue
    latest.set(r.step_kind, { status: r.status, at: r.occurred_at.toISOString() })
  }
  return {
    ...row,
    steps: EXECUTION_ORDER.map((kind) => ({ kind, status: latest.get(kind)?.status ?? 'absent', at: latest.get(kind)?.at ?? null })),
  }
}

/** One request of a customer, as the status page shows it (the view has no evidence token). */
export interface RequestRow {
  id: string
  kind: string
  state: string
  origin: 'panel' | 'host'
  /** Break-glass requests (origin=host) carry the operator's reason and the host login user. */
  reason: string | null
  hostActor: string | null
  outcome: string | null
  createdAt: string
}

export async function customerRequests(c: PanelConfig, slug: string): Promise<RequestRow[]> {
  const p = platformDb(c)
  if (!p) return []
  const rows = await p<
    { request_id: string; kind: string; state: string; origin: 'panel' | 'host'; reason: string | null; host_actor: string | null; outcome: string | null; created_at: Date }[]
  >`SELECT request_id::text, kind, state, origin, reason, host_actor, outcome, created_at
      FROM plt.provisioning_request_status WHERE customer_slug = ${slug} ORDER BY created_at DESC LIMIT 20`
  return rows.map((r) => ({
    id: r.request_id,
    kind: r.kind,
    state: r.state,
    origin: r.origin,
    reason: r.reason,
    hostActor: r.host_actor,
    outcome: r.outcome,
    createdAt: r.created_at.toISOString(),
  }))
}
