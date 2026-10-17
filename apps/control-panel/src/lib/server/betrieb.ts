// apps/control-panel/src/lib/server/betrieb.ts — the "Betrieb" page's data: a
// fixed set of instant queries against the ops stack's Prometheus, read
// server-side only (the browser never reaches the ops network; Grafana stays
// on the loopback, TRD-111). Every expr is one the provisioned dashboard
// `Gremion – Betrieb` already runs (betrieb.test.ts enforces it), so the
// dashboard's metric guard covers these queries too.
import type { Unit } from '../betrieb-format'
import type { PanelConfig } from './config'

export { formatValue, type Unit } from '../betrieb-format'
export type Level = 'ok' | 'warn' | 'bad'

export interface BetriebQuery {
  expr: string
  /** A fixed row name (single-value queries), or the labels that name each row. */
  name?: string
  labels?: string[]
}

export interface BetriebPanel {
  id: string
  title: string
  unit: Unit
  queries: BetriebQuery[]
  /** Level of one value; absent: every row is `ok`. */
  assess?: (value: number) => Level
  /** Rows shown at most; the rest are counted. */
  limit?: number
}

const above = (warn: number, bad = Infinity) => (v: number): Level => (v > bad ? 'bad' : v > warn ? 'warn' : 'ok')

// Thresholds: the dashboard's where it has them (backup 26 h, footprint 8 d,
// filesystems 70 %, storage components 50/70 %); the rest are the panel's own.
export const BETRIEB_PANELS: BetriebPanel[] = [
  { id: 'backup', title: 'Backup', unit: 'age', queries: [{ expr: 'time() - max(gremion_backup_last_ts_seconds)', name: 'Letztes Backup' }], assess: above(93600 * 0.75, 93600) },
  { id: 'footprint', title: 'Wöchentliche Messung', unit: 'age', queries: [{ expr: 'time() - max(gremion_footprint_timestamp_seconds)', name: 'Letzte Messung' }], assess: above(604800, 691200) },
  { id: 'cpu', title: 'Host: CPU', unit: 'percent', queries: [{ expr: '100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])))', name: 'CPU' }], assess: above(75, 90) },
  { id: 'memory', title: 'Host: Arbeitsspeicher', unit: 'percent', queries: [{ expr: '100 * (1 - max(node_memory_MemAvailable_bytes) / max(node_memory_MemTotal_bytes))', name: 'Arbeitsspeicher' }], assess: above(80, 92) },
  { id: 'filesystems', title: 'Host: Dateisysteme', unit: 'percent', queries: [{ expr: '100 * (1 - max by (mountpoint) (gremion_host_filesystem_avail_bytes) / max by (mountpoint) (gremion_host_filesystem_size_bytes))', labels: ['mountpoint'] }], assess: above(70, 85) },
  { id: 'containers', title: 'Container', unit: 'count', queries: [{ expr: 'max by (name) (gremion_container_up)', labels: ['name'] }], assess: (v) => (v >= 1 ? 'ok' : 'bad'), limit: 60 },
  { id: 'unhealthy', title: 'Container: ungesund', unit: 'count', queries: [{ expr: 'max by (name) (gremion_container_unhealthy)', labels: ['name'] }], assess: (v) => (v > 0 ? 'bad' : 'ok'), limit: 60 },
  {
    id: 'postgres',
    title: 'Postgres: Verbindungen',
    unit: 'count',
    queries: [
      { expr: 'max(gremion_postgres_connections_used)', name: 'Belegt' },
      { expr: 'max(gremion_postgres_connections_max)', name: 'Maximum' },
    ],
  },
  { id: 'nats', title: 'NATS: Rückstand je Consumer', unit: 'count', queries: [{ expr: 'sum by (account, stream, consumer) (gremion_nats_consumer_num_pending + gremion_nats_consumer_num_ack_pending)', labels: ['account', 'stream', 'consumer'] }], assess: above(100, 1000), limit: 15 },
  { id: 'storage', title: 'Speicher-Komponenten', unit: 'percent', queries: [{ expr: '100 * max by (component) (gremion_storage_component_bytes) / on() group_left() max(gremion_host_disk_provisioned_bytes)', labels: ['component'] }], assess: above(50, 70) },
  { id: 'jobs', title: 'Geplante Jobs: letzter Lauf', unit: 'age', queries: [{ expr: 'time() - gremion_job_last_run', labels: ['job_kind', 'customer', 'status'] }], assess: above(8 * 86400, 15 * 86400), limit: 30 },
]

export interface Sample {
  labels: Record<string, string>
  value: number
}

const TIMEOUT_MS = 4000

/** One instant query. Throws on a transport error, a non-2xx status or a non-success body (never echoing the body). */
export async function queryInstant(base: string, expr: string, fetchImpl: typeof fetch = fetch): Promise<Sample[]> {
  const url = `${base}/api/v1/query?query=${encodeURIComponent(expr)}`
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as { status?: string; data?: { resultType?: string; result?: { metric?: Record<string, string>; value?: [number, string] }[] } }
  if (body.status !== 'success' || body.data?.resultType !== 'vector') throw new Error('answer is not a success vector')
  const out: Sample[] = []
  for (const r of body.data.result ?? []) {
    const v = Number(r.value?.[1])
    // NaN (a division by an absent series) and garbage are dropped: "keine Daten" beats a false 0
    if (Number.isFinite(v)) out.push({ labels: r.metric ?? {}, value: v })
  }
  return out
}

export interface BetriebRow {
  name: string
  value: number
  level: Level
}

export interface BetriebPanelResult {
  id: string
  title: string
  unit: Unit
  rows: BetriebRow[]
  /** Rows beyond the panel's limit. */
  hidden: number
  error: string | null
}

export interface BetriebResult {
  /** Why the page cannot show anything (not configured), or null. */
  disabled: string | null
  /** Every query failed: Prometheus itself is not reachable. */
  unreachable: string | null
  panels: BetriebPanelResult[]
}

export function betriebDisabledReason(c: PanelConfig): string | null {
  if (c.prometheusUrl === null) {
    return 'Kein Prometheus konfiguriert (PANEL_PROMETHEUS_URL): der Ops-Stack läuft auf diesem Host nicht, oder das Panel ist nicht mit compose/control-panel/ops-link.yml gestartet.'
  }
  return null
}

const ORDER: Record<Level, number> = { bad: 0, warn: 1, ok: 2 }

function rowName(q: BetriebQuery, s: Sample): string {
  if (q.name) return q.name
  const parts = (q.labels ?? []).map((l) => s.labels[l]).filter((v): v is string => Boolean(v))
  return parts.length ? parts.join(' / ') : '(ohne Namen)'
}

export async function loadBetrieb(c: PanelConfig, fetchImpl: typeof fetch = fetch): Promise<BetriebResult> {
  const disabled = betriebDisabledReason(c)
  if (disabled !== null || c.prometheusUrl === null) return { disabled, unreachable: null, panels: [] }
  const base = c.prometheusUrl
  let calls = 0
  let failures = 0
  const panels = await Promise.all(
    BETRIEB_PANELS.map(async (p): Promise<BetriebPanelResult> => {
      const rows: BetriebRow[] = []
      let error: string | null = null
      for (const q of p.queries) {
        calls++
        try {
          for (const s of await queryInstant(base, q.expr, fetchImpl)) {
            rows.push({ name: rowName(q, s), value: s.value, level: p.assess ? p.assess(s.value) : 'ok' })
          }
        } catch (err) {
          failures++
          // the reason goes to the log; the page names only the failed panel
          console.error(`[control-panel] betrieb query ${p.id} failed: ${(err as Error)?.message ?? String(err)}`)
          error = 'Abfrage fehlgeschlagen (Details im Panel-Log).'
        }
      }
      rows.sort((a, b) => ORDER[a.level] - ORDER[b.level] || (p.queries.length > 1 ? 0 : a.name.localeCompare(b.name, 'de')))
      const limit = p.limit ?? rows.length
      return { id: p.id, title: p.title, unit: p.unit, rows: rows.slice(0, limit), hidden: Math.max(0, rows.length - limit), error }
    }),
  )
  if (calls > 0 && failures === calls) {
    return { disabled: null, unreachable: `Prometheus ist nicht erreichbar (${base}; Details im Panel-Log).`, panels: [] }
  }
  return { disabled: null, unreachable: null, panels }
}
