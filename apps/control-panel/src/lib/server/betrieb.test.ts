// The "Betrieb" page's server side: a fixed set of instant queries against the
// ops stack's Prometheus, read server-side only. Every query is one the
// provisioned Grafana dashboard already runs, so the dashboard's metric guard
// (compose/observability/dashboards.test.mjs) covers the panel's queries too.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { summarize } from '../betrieb-format'
import { BETRIEB_PANELS, betriebDisabledReason, formatValue, loadBetrieb, queryInstant } from './betrieb'
import type { PanelConfig } from './config'

const DASHBOARD = join(dirname(fileURLToPath(import.meta.url)), '../../../../../compose/observability/grafana/provisioning/dashboards/gremion-betrieb.json')
const BASE = 'http://prometheus:9090'

type Sample = { metric: Record<string, string>; value: [number, string] }
const vector = (result: Sample[]) => ({ status: 'success', data: { resultType: 'vector', result } })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A fetch double answering each expr from `answers`; unknown exprs get an empty vector. Records every URL. */
function fakeFetch(answers: Record<string, Sample[] | Error | number> = {}) {
  const urls: string[] = []
  const impl = async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    urls.push(url.toString())
    const expr = url.searchParams.get('query') ?? ''
    const a = answers[expr]
    if (a instanceof Error) throw a
    if (typeof a === 'number') return json({ status: 'error', error: 'boom' }, a)
    return json(vector(a ?? []))
  }
  return { impl: impl as typeof fetch, urls }
}

const config = (prometheusUrl: string | null) => ({ prometheusUrl }) as PanelConfig

/** The panel definition or result with this id; throws instead of yielding undefined. */
function def(id: string) {
  const p = BETRIEB_PANELS.find((x) => x.id === id)
  if (!p) throw new Error(`no panel ${id}`)
  return p
}
const firstExpr = (id: string) => {
  const q = def(id).queries[0]
  if (!q) throw new Error(`panel ${id} has no query`)
  return q.expr
}
function res(r: { panels: { id: string }[] }, id: string) {
  const p = r.panels.find((x) => x.id === id)
  if (!p) throw new Error(`no result for ${id}`)
  return p as Awaited<ReturnType<typeof loadBetrieb>>['panels'][number]
}

describe('BETRIEB_PANELS', () => {
  it('every query is one the provisioned dashboard runs (so its metric guard covers the panel)', () => {
    const dash = JSON.parse(readFileSync(DASHBOARD, 'utf8')) as { panels: { targets?: { expr: string }[] }[] }
    const known = new Set(dash.panels.flatMap((p) => (p.targets ?? []).map((t) => t.expr)))
    const ours = BETRIEB_PANELS.flatMap((p) => p.queries.map((q) => q.expr))
    expect(ours.length).toBeGreaterThan(8)
    expect(ours.filter((e) => !known.has(e))).toEqual([])
  })

  it('every panel names how it is drawn; per-item percentages are bars, single values are stats', () => {
    const by = Object.fromEntries(BETRIEB_PANELS.map((p) => [p.id, p.display]))
    expect(BETRIEB_PANELS.every((p) => ['stat', 'bars', 'status', 'table'].includes(p.display))).toBe(true)
    expect(by.filesystems).toBe('bars')
    expect(by.backup).toBe('stat')
    expect(by.containers).toBe('status')
  })

  it('panel ids are unique', () => {
    const ids = BETRIEB_PANELS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('queryInstant', () => {
  it('GETs /api/v1/query with the expr and returns the samples as numbers', async () => {
    const f = fakeFetch({ 'max(gremion_postgres_connections_used)': [{ metric: {}, value: [1, '17'] }] })
    const r = await queryInstant(BASE, 'max(gremion_postgres_connections_used)', f.impl)
    expect(r).toEqual([{ labels: {}, value: 17 }])
    const u = new URL(f.urls[0] ?? '')
    expect(`${u.origin}${u.pathname}`).toBe(`${BASE}/api/v1/query`)
    expect(u.searchParams.get('query')).toBe('max(gremion_postgres_connections_used)')
  })

  it('a non-2xx answer or a non-success body throws with the status, never the body', async () => {
    const f = fakeFetch({ x: 503 })
    await expect(queryInstant(BASE, 'x', f.impl)).rejects.toThrow(/HTTP 503/)
    const g = (async () => json({ status: 'error', error: 'parse error' })) as unknown as typeof fetch
    await expect(queryInstant(BASE, 'x', g)).rejects.toThrow(/not a success/)
  })

  it('a NaN or non-numeric sample is dropped, not shown as 0', async () => {
    const f = fakeFetch({ x: [{ metric: { a: '1' }, value: [1, 'NaN'] }, { metric: { a: '2' }, value: [1, 'oops'] }, { metric: { a: '3' }, value: [1, '2'] }] })
    expect(await queryInstant(BASE, 'x', f.impl)).toEqual([{ labels: { a: '3' }, value: 2 }])
  })
})

describe('betriebDisabledReason', () => {
  it('names the missing PANEL_PROMETHEUS_URL; null when configured', () => {
    expect(betriebDisabledReason(config(null))).toMatch(/PANEL_PROMETHEUS_URL/)
    expect(betriebDisabledReason(config(BASE))).toBeNull()
  })
})

describe('loadBetrieb', () => {
  it('without a Prometheus URL: disabled with the reason, no request made', async () => {
    const f = fakeFetch()
    const r = await loadBetrieb(config(null), f.impl)
    expect(r.disabled).toMatch(/PANEL_PROMETHEUS_URL/)
    expect(r.panels).toEqual([])
    expect(f.urls).toEqual([])
  })

  it('Prometheus unreachable everywhere: one page-level error, not a page of empty panels', async () => {
    const answers: Record<string, Error> = {}
    for (const p of BETRIEB_PANELS) for (const q of p.queries) answers[q.expr] = new Error('ECONNREFUSED')
    const r = await loadBetrieb(config(BASE), fakeFetch(answers).impl)
    expect(r.disabled).toBeNull()
    expect(r.unreachable).toMatch(/nicht erreichbar/)
    expect(r.unreachable).not.toContain(BASE)
  })

  it('one failing query marks only its panel; an empty result says "keine Daten", never 0', async () => {
    const f = fakeFetch({
      [firstExpr('backup')]: new Error('timeout'),
      [firstExpr('postgres')]: [{ metric: {}, value: [1, '12'] }],
    })
    const r = await loadBetrieb(config(BASE), f.impl)
    expect(r.unreachable).toBeNull()
    expect(res(r, 'backup').error).toMatch(/fehlgeschlagen/)
    expect(res(r, 'postgres').rows).toContainEqual(expect.objectContaining({ name: 'Belegt', value: 12 }))
    expect(res(r, 'cpu').rows).toEqual([])
    expect(res(r, 'cpu').error).toBeNull()
  })

  it('rows carry a level from the thresholds (backup older than 26 h is bad, a stopped container is bad)', async () => {
    const f = fakeFetch({
      [firstExpr('backup')]: [{ metric: {}, value: [1, String(27 * 3600)] }],
      [firstExpr('containers')]: [
        { metric: { name: 'gremion-postgres-1' }, value: [1, '1'] },
        { metric: { name: 'gremion-nats-1' }, value: [1, '0'] },
      ],
    })
    const r = await loadBetrieb(config(BASE), f.impl)
    expect(res(r, 'backup').rows[0]?.level).toBe('bad')
    const rows = res(r, 'containers').rows
    // stopped first, so the problem is at the top of the list
    expect(rows[0]).toEqual(expect.objectContaining({ name: 'gremion-nats-1', level: 'bad' }))
    expect(rows[1]).toEqual(expect.objectContaining({ name: 'gremion-postgres-1', level: 'ok' }))
  })
})

describe('formatValue', () => {
  it('ages read as minutes, hours or days; percent and bytes are humane', () => {
    expect(formatValue(90, 'age')).toBe('vor 2 min')
    expect(formatValue(5 * 3600, 'age')).toBe('vor 5 h')
    expect(formatValue(3 * 86400, 'age')).toBe('vor 3 d')
    expect(formatValue(42.345, 'percent')).toBe('42,3 %')
    expect(formatValue(1536, 'bytes')).toBe('1,5 KiB')
    expect(formatValue(7, 'count')).toBe('7')
  })
})

describe('summarize (review r1: a tile without data is not healthy)', () => {
  it('all tiles with ok rows: no attention', () => {
    expect(summarize([{ rows: [{ level: 'ok' }], error: null }])).toEqual({ attention: false, text: 'Keine Auffälligkeiten.' })
  })
  it('an empty tile is counted and named, never "Keine Auffälligkeiten"', () => {
    const s = summarize([{ rows: [{ level: 'ok' }], error: null }, { rows: [], error: null }])
    expect(s.attention).toBe(true)
    expect(s.text).toBe('1 Kachel ohne Daten.')
  })
  it('flags and empty tiles are both named', () => {
    const s = summarize([{ rows: [{ level: 'bad' }, { level: 'warn' }], error: null }, { rows: [], error: 'x' }, { rows: [], error: null }, { rows: [], error: null }])
    expect(s.text).toBe('3 Auffälligkeiten, oben in den Kacheln; 2 Kacheln ohne Daten.')
  })
})
