// build.mjs - joins template.html, a graph and ste-text.json into ONE page, and writes a status file.
//
//   node build.mjs --graph <graph.json> --commit <40 hex | unknown> --out-dir <dir>
//
// Writes <dir>/code-map.html and <dir>/status.json. It never throws for text that no longer matches the
// code: resolve.mjs turns that into stale lists, and the page says so. If leak-scan.mjs finds anything in
// the finished page, the page is NOT written; the status file then holds ok:false and the rule ids only.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findLeaks, ruleIds } from './leak-scan.mjs'
import { resolve } from './resolve.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHA = /^[0-9a-f]{40}$/

export const cleanCommit = (c) => (typeof c === 'string' && SHA.test(c) ? c : 'unknown')

/**
 * @param {{ graph: object, text: object, template: string, commit: string }} input
 * @returns {{ ok: boolean, html: string | null, leaks: Array<{rule:string,sample:string,index:number}>, status: object }}
 * `leaks` is for a caller that prints rule ids; the samples in it are never written to a status file.
 */
export function buildMap({ graph: g, text: t, template, commit: rawCommit }) {
  const commit = cleanCommit(rawCommit)
  const r = resolve(g, t)
  const kinds = [...new Set(g.nodes.map((n) => n.kind))]
  const ek = [...new Set(g.edges.map((e) => e.kind))]
  const ix = new Map(g.nodes.map((n, i) => [n.id, i]))
  const layerNum = (s) => Number(String(s).replace('L', ''))
  const n = g.nodes.map((x) => [kinds.indexOf(x.kind), x.kind === 'file' ? x.file : x.name, x.parent ? ix.get(x.parent) : -1, x.line, layerNum(x.layer)])
  const seen = new Set()
  const e = []
  for (const x of g.edges) {
    const k = `${x.from}|${x.to}|${x.kind}`
    if (seen.has(k)) continue
    seen.add(k)
    e.push([ix.get(x.from), ix.get(x.to), ek.indexOf(x.kind)])
  }
  const layers = [0, 1, 2, 3, 4, 5].map((l) => ix.get('L' + l))
  const areas = {}
  for (const [id, a] of Object.entries(r.areas)) areas[ix.get(id)] = a
  const lay = {}
  for (const [k, v] of Object.entries(t.layers ?? {})) lay[layerNum(k)] = v

  const live = r.walkthroughs.filter((w) => w.steps.length > 0)
  const dropped = r.walkthroughs.filter((w) => w.steps.length === 0).map((w) => w.title)
  const walkthroughs = live.map((w) => ({
    title: w.title,
    steps: w.steps.map((s) => ({ text: s.text, i: ix.get(s.id) })),
    stale: w.stale,
  }))

  const fm = new Map()
  for (const [a, b] of e) {
    const la = n[a][4], lb = n[b][4]
    if (la === lb) continue
    const k = la + '|' + lb
    fm.set(k, (fm.get(k) || 0) + 1)
  }
  const flow = [...fm].map(([k, c]) => [...k.split('|').map(Number), c]).sort((x, y) => y[0] - x[0] || y[1] - x[1])
  const functions = g.nodes.filter((x) => x.kind === 'function').length
  const pct = Math.round(Number(g.meta?.resolvedRatioPercent) || 0)
  const limits = [
    `This map shows ${functions} functions and ${e.length} connections.`,
    `A program made the map from the code. The program found the target of ${pct} percent of the calls inside the project.`,
    'The map does not show the other calls. Some of these calls use a value that the program can only know when the code runs.',
    'The build of this page can have fewer outside packages than a full build. If it has fewer, the map shows fewer connections.',
    'L0 shows files only. The map does not show connections for these files.',
    'The sentences about one function come from the name of the function. A person did not write these sentences.',
    'The other text follows the rules of ASD-STE100 Simplified Technical English. A program did a rule check on this text. The rule check is not a certified STE check.',
  ]
  const stale = { steps: r.staleSteps.length, areas: r.staleAreas.length, dropped }
  const data = {
    kinds, ek, n, e, layers, flow, limits, stale,
    commit: commit === 'unknown' ? 'unknown' : commit.slice(0, 8),
    t: { ...t, areas, layers: lay, walkthroughs },
  }
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  const html = template.replace('__DATA__', () => json)

  const status = {
    ok: true,
    commit,
    generatedFor: `Gremion kernel at ${commit === 'unknown' ? 'an unknown version' : commit}`,
    counts: { functions, connections: e.length },
    staleSteps: r.staleSteps,
    staleAreas: r.staleAreas,
    undescribedAreas: r.undescribedAreas,
    reason: null,
  }
  // The status file is published too, and its stale lists hold text and ids from ste-text.json: scan it as well as
  // the page. On a leak the refused status keeps no list, so the refused text does not leave through status.json.
  const leaks = [...findLeaks(html), ...findLeaks(JSON.stringify(status))]
  if (leaks.length) {
    const refused = { ...status, ok: false, staleSteps: [], staleAreas: [], undescribedAreas: [], reason: `leak-scan: ${ruleIds(leaks).join(', ')}` }
    return { ok: false, html: null, leaks, status: refused }
  }
  return { ok: true, html, leaks: [], status }
}

function main() {
  const argv = process.argv.slice(2)
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
  const graphPath = arg('--graph')
  const outDir = arg('--out-dir')
  if (!graphPath || !outDir) {
    console.error('usage: node build.mjs --graph <graph.json> --commit <sha|unknown> --out-dir <dir>')
    process.exit(2)
  }
  const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8')
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'))
  const r = buildMap({ graph, text: JSON.parse(read('ste-text.json')), template: read('template.html'), commit: arg('--commit') ?? 'unknown' })
  fs.mkdirSync(outDir, { recursive: true })
  const htmlPath = path.join(outDir, 'code-map.html')
  fs.rmSync(htmlPath, { force: true })
  if (r.html !== null) fs.writeFileSync(htmlPath, r.html)
  fs.writeFileSync(path.join(outDir, 'status.json'), JSON.stringify(r.status, null, 2) + '\n')
  console.log(r.ok ? `code map: ${r.html.length} bytes, ${r.status.staleSteps.length} stale steps, ${r.status.staleAreas.length} stale areas` : `code map: not written (${r.status.reason})`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
