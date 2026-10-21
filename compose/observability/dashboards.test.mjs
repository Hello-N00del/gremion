// The provisioned operator dashboard (compose/observability/grafana/provisioning/
// dashboards/): the file provider is read-only and reads a directory the ops
// project mounts, the JSON parses, every panel queries the provisioned
// Prometheus datasource, and every metric a panel names is one the host
// collector, the footprint job, the recording rules or Alloy's unix collectors
// really produce. A panel on a misspelt or never-emitted metric draws an empty
// graph that looks like a quiet system; this test is what stops that.
//
//   node --test compose/observability/dashboards.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { REPO_ROOT, readText, readYaml } from './checks.mjs'

const DIR = 'compose/observability/grafana/provisioning/dashboards'
const MOUNT = '/etc/grafana/provisioning'
const PROVIDERS = readYaml(`${DIR}/dashboards.yaml`)
const DATASOURCES = readYaml('compose/observability/grafana/provisioning/datasources/datasources.yaml')
const COMPOSE = readYaml('compose/observability/docker-compose.yml')
const files = readdirSync(path.join(REPO_ROOT, DIR)).filter((f) => f.endsWith('.json'))
const load = (f) => JSON.parse(readText(`${DIR}/${f}`))
const copy = () => load('gremion-betrieb.json')

// Alloy's unix exporter: a node_* name is real only when its collector is on.
const NODE_BY_COLLECTOR = {
  cpu: ['node_cpu_seconds_total'],
  loadavg: ['node_load1', 'node_load5', 'node_load15'],
  meminfo: ['node_memory_MemAvailable_bytes', 'node_memory_MemTotal_bytes', 'node_memory_MemFree_bytes'],
}
const FUNCTIONS = new Set(['avg', 'max', 'min', 'sum', 'count', 'rate', 'irate', 'increase', 'changes', 'time', 'clamp_max', 'clamp_min', 'abs'])
const KEYWORDS = new Set(['by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'bool', 'and', 'or', 'unless', 'offset'])

/** The metric names the stack emits today, read from the sources that emit them. */
function knownMetrics() {
  const known = new Set()
  for (const f of ['infra/host/ops/metrics-textfile.sh', 'infra/host/ops/footprint.sh']) {
    for (const m of readText(f).matchAll(/# (?:HELP|TYPE) (gremion_[a-z0-9_]+)/g)) known.add(m[1])
  }
  // The broker families are emitted by name from a loop: 'stream_bytes:$s.state.bytes'.
  for (const m of readText('infra/host/ops/metrics-textfile.sh').matchAll(/'([a-z0-9_]+):\$[sc]\./g)) known.add(`gremion_nats_${m[1]}`)
  const alloy = readText('docker/alloy/config.alloy')
  const on = (alloy.match(/set_collectors\s*=\s*\[([^\]]*)\]/)?.[1] ?? '').match(/"[a-z]+"/g)?.map((s) => s.slice(1, -1)) ?? []
  for (const c of on) for (const n of NODE_BY_COLLECTOR[c] ?? []) known.add(n)
  return known
}

/** Every metric name an expression selects, or the function/keyword it does not know. */
function exprNames(expr) {
  let e = expr.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\{[^}]*\}/g, '').replace(/\[[^\]]*\]/g, '')
  e = e.replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ' ')
  const metrics = []
  const unknown = []
  for (const m of e.matchAll(/[A-Za-z_:][A-Za-z0-9_:]*(\s*\()?/g)) {
    const name = m[0].replace(/\s*\($/, '')
    if (m[1]) { if (!FUNCTIONS.has(name)) unknown.push(name) } else if (!KEYWORDS.has(name)) metrics.push(name)
  }
  return { metrics, unknown }
}

function dashboardViolations(dash, known, datasourceUids) {
  const out = []
  const panels = (dash.panels ?? []).filter((p) => p.type !== 'row')
  if (panels.length < 6 || panels.length > 10) out.push(`${dash.title}: ${panels.length} panels, want 6 to 10`)
  const ids = panels.map((p) => p.id)
  if (new Set(ids).size !== ids.length) out.push(`${dash.title}: duplicate panel ids`)
  if (dash.editable !== false) out.push(`${dash.title}: editable is not false`)
  for (const p of panels) {
    const where = `${dash.title} / ${p.title}`
    if (!p.targets?.length) out.push(`${where}: no query`)
    if (!datasourceUids.has(p.datasource?.uid)) out.push(`${where}: panel datasource ${p.datasource?.uid} is not provisioned`)
    for (const t of p.targets ?? []) {
      if (t.datasource?.uid !== p.datasource?.uid) out.push(`${where} / ${t.refId}: query datasource ${t.datasource?.uid} differs from the panel's`)
      if (typeof t.expr !== 'string' || t.expr.trim() === '') { out.push(`${where} / ${t.refId}: empty expression`); continue }
      const { metrics, unknown } = exprNames(t.expr)
      if (metrics.length === 0) out.push(`${where} / ${t.refId}: names no metric`)
      for (const m of metrics) if (!known.has(m)) out.push(`${where} / ${t.refId}: ${m} is not a metric the stack emits`)
      for (const f of unknown) out.push(`${where} / ${t.refId}: ${f}() is not a function this check knows`)
    }
  }
  const cells = new Set()
  for (const p of panels) {
    const { x, y, w, h } = p.gridPos ?? {}
    if (![x, y, w, h].every(Number.isInteger) || x < 0 || w < 1 || x + w > 24) { out.push(`${dash.title} / ${p.title}: gridPos ${JSON.stringify(p.gridPos)} is off the 24-column grid`); continue }
    for (let i = x; i < x + w; i++) for (let j = y; j < y + h; j++) { if (cells.has(`${i},${j}`)) { out.push(`${dash.title} / ${p.title}: overlaps another panel`); i = x + w; break } cells.add(`${i},${j}`) }
  }
  return out
}

const KNOWN = knownMetrics()
const UIDS = new Set(DATASOURCES.datasources.filter((d) => d.type === 'prometheus').map((d) => d.uid))

test('the provider is a read-only file provider on a directory the ops project mounts', () => {
  assert.equal(PROVIDERS.apiVersion, 1)
  assert.equal(PROVIDERS.providers.length, 1)
  const p = PROVIDERS.providers[0]
  assert.equal(p.type, 'file')
  assert.equal(p.allowUiUpdates, false)
  assert.equal(p.disableDeletion, true)
  assert.match(p.options.path, new RegExp(`^${MOUNT}/dashboards$`))
  assert.ok(existsSync(path.join(REPO_ROOT, DIR)), 'the path maps to a directory of the repository')
  const grafana = COMPOSE.services.grafana.volumes
  assert.ok(grafana.some((v) => v.endsWith('/runtime/ops/grafana-provisioning:/etc/grafana/provisioning:ro')), 'the provisioning tree is mounted read-only')
  assert.match(readText('infra/host/ops/render-ops.sh'), /cp -R "\$PROVISIONING_SRC\/\." "\$tmp\/"/, 'render-ops.sh copies the whole tree')
})

test('the dashboard directory holds the Betrieb dashboard and parses', () => {
  assert.deepEqual(files, ['gremion-betrieb.json'])
  const d = load('gremion-betrieb.json')
  assert.equal(d.title, 'Gremion – Betrieb')
  assert.equal(d.uid, 'gremion-betrieb')
  assert.equal(d.id, undefined, 'a provisioned dashboard carries no database id')
})

test('the Prometheus datasource the panels name is provisioned', () => {
  assert.deepEqual([...UIDS], ['prometheus'])
})

test('every dashboard is clean: panels on the provisioned datasource, only metrics the stack emits', () => {
  for (const f of files) assert.deepEqual(dashboardViolations(load(f), KNOWN, UIDS), [], f)
})

test('RED: a misspelt metric, an unknown datasource, an editable dashboard and an overlap each fail by name', () => {
  const a = copy()
  a.panels[0].targets[0].expr = 'time() - max(gremion_backup_last_ts_second)'
  assert.match(dashboardViolations(a, KNOWN, UIDS).join('\n'), /gremion_backup_last_ts_second is not a metric the stack emits/)
  const b = copy()
  b.panels[1].datasource = { type: 'prometheus', uid: 'mimir' }
  assert.match(dashboardViolations(b, KNOWN, UIDS).join('\n'), /panel datasource mimir is not provisioned/)
  const c = copy()
  c.editable = true
  assert.match(dashboardViolations(c, KNOWN, UIDS).join('\n'), /editable is not false/)
  const d = copy()
  d.panels[1].gridPos = { ...d.panels[0].gridPos }
  assert.match(dashboardViolations(d, KNOWN, UIDS).join('\n'), /overlaps another panel/)
  const e = copy()
  e.panels[2].targets[0].expr = 'predict_linear(node_load1[1h], 3600)'
  assert.match(dashboardViolations(e, KNOWN, UIDS).join('\n'), /predict_linear\(\) is not a function this check knows/)
  const f = copy()
  f.panels = f.panels.slice(0, 3)
  assert.match(dashboardViolations(f, KNOWN, UIDS).join('\n'), /3 panels, want 6 to 10/)
})

test('the metric extractor sees through matchers, ranges, by-clauses and label values', () => {
  assert.deepEqual(exprNames('100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])))'), { metrics: ['node_cpu_seconds_total'], unknown: [] })
  assert.deepEqual(exprNames('max by (a, b) (x_one) / on() group_left() max(x_two{l="gremion_fake"})').metrics, ['x_one', 'x_two'])
})

test('the known set covers the families the panels rely on', () => {
  for (const m of ['gremion_backup_last_ts_seconds', 'gremion_container_up', 'gremion_postgres_connections_used', 'gremion_nats_consumer_num_pending',
    'gremion_job_last_run', 'gremion_storage_component_bytes', 'gremion_footprint_component_bytes', 'node_cpu_seconds_total', 'node_memory_MemTotal_bytes']) {
    assert.ok(KNOWN.has(m), m)
  }
})
