// build.mjs: text that no longer matches the code must never stop the build; a leak must never reach a page.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildMap } from './build.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHA = 'a'.repeat(40)
const template = fs.readFileSync(path.join(HERE, 'template.html'), 'utf8')

const layer = (l) => ({ id: `L${l}`, kind: 'layer', name: `L${l} Layer`, parent: null, file: '', line: 0, layer: `L${l}` })
const fnNode = (file, name, line, parent) => ({ id: `fn:${file}#${name}@${line}`, kind: 'function', name, parent, file, line, layer: 'L3' })
function makeGraph(extra = [], ratio = 85.6) {
  const nodes = [0, 1, 2, 3, 4, 5].map(layer)
  nodes.push({ id: 'area:svc@L3', kind: 'area', name: 'svc server code', parent: 'L3', file: '', line: 0, layer: 'L3' })
  nodes.push({ id: 'file:svc/a.ts', kind: 'file', name: 'svc/a.ts', parent: 'area:svc@L3', file: 'svc/a.ts', line: 0, layer: 'L3' })
  nodes.push(fnNode('svc/a.ts', 'alpha', 5, 'file:svc/a.ts'), fnNode('svc/a.ts', 'beta', 9, 'file:svc/a.ts'))
  nodes.push(...extra)
  const edges = [
    { from: 'fn:svc/a.ts#alpha@5', to: 'fn:svc/a.ts#beta@9', kind: 'calls' },
    { from: 'fn:svc/a.ts#alpha@5', to: 'fn:svc/a.ts#beta@9', kind: 'calls' },
  ]
  return { meta: { commit: SHA, resolvedRatioPercent: ratio, counts: { nodesByKind: { function: 2 } } }, nodes, edges }
}
const layers = Object.fromEntries([0, 1, 2, 3, 4, 5].map((l) => [`L${l}`, { title: `L${l}: Title`, text: 'A sentence. Another.' }]))
const baseText = (over = {}) => ({
  intro: ['One.'],
  howToRead: ['Two.'],
  layers,
  glossary: { server: 'A computer.' },
  areas: { 'area:svc@L3': { title: 'Service', what: 'w', why: 'y', leadsTo: 'l' } },
  walkthroughs: [{ title: 'Example one', steps: [{ text: 'First.', file: 'svc/a.ts', function: 'alpha' }, { text: 'Second.', file: 'svc/a.ts', function: 'beta' }] }],
  ...over,
})
const dataOf = (html) => {
  const m = /const D=(.*);\n/.exec(html)
  return JSON.parse(m[1])
}

describe('buildMap', () => {
  it('a text that matches builds an ok page and a status', () => {
    const r = buildMap({ graph: makeGraph(), text: baseText(), template, commit: SHA })
    expect(r.ok).toBe(true)
    expect(r.html).toContain('<h1>')
    expect(r.status).toMatchObject({ ok: true, commit: SHA, counts: { functions: 2, connections: 1 }, staleSteps: [], staleAreas: [], undescribedAreas: [], reason: null })
    expect(typeof r.status.generatedFor).toBe('string')
    const d = dataOf(r.html)
    expect(d.t.walkthroughs[0].steps).toHaveLength(2)
    expect(d.stale).toEqual({ steps: 0, areas: 0, dropped: [] })
  })

  it('a stale step does not throw: ok:true, the step is out of the sequence and the walkthrough carries it', () => {
    const t = baseText({ walkthroughs: [{ title: 'Example one', steps: [{ text: 'First.', file: 'svc/a.ts', function: 'alpha' }, { text: 'Old.', file: 'svc/a.ts', function: 'renamed' }] }] })
    const r = buildMap({ graph: makeGraph(), text: t, template, commit: SHA })
    expect(r.ok).toBe(true)
    expect(r.status.staleSteps).toEqual([{ walkthrough: 'Example one', step: 2, file: 'svc/a.ts', function: 'renamed', text: 'Old.' }])
    const w = dataOf(r.html).t.walkthroughs[0]
    expect(w.steps).toHaveLength(1)
    expect(w.stale).toEqual([{ step: 2, name: 'renamed', text: 'Old.' }])
    expect(dataOf(r.html).stale.steps).toBe(1)
  })

  it('a walkthrough with no live step is removed from the page data and named on the home data', () => {
    const t = baseText({ walkthroughs: [{ title: 'Gone', steps: [{ text: 'x', file: 'nope.ts', function: 'nope' }] }, ...baseText().walkthroughs] })
    const d = dataOf(buildMap({ graph: makeGraph(), text: t, template, commit: SHA }).html)
    expect(d.t.walkthroughs.map((w) => w.title)).toEqual(['Example one'])
    expect(d.stale.dropped).toEqual(['Gone'])
  })

  it('no walkthrough left: the page is still built', () => {
    const t = baseText({ walkthroughs: [{ title: 'Gone', steps: [{ text: 'x', file: 'nope.ts', function: 'nope' }] }] })
    const r = buildMap({ graph: makeGraph(), text: t, template, commit: SHA })
    expect(r.ok).toBe(true)
    expect(dataOf(r.html).t.walkthroughs).toEqual([])
  })

  it('text for a removed area is not shown and an area without text does not throw', () => {
    const t = baseText({ areas: { 'area:gone@L3': { title: 'Gone', what: 'w', why: 'y', leadsTo: 'l' } } })
    const r = buildMap({ graph: makeGraph(), text: t, template, commit: SHA })
    expect(r.ok).toBe(true)
    expect(r.status.staleAreas).toEqual(['area:gone@L3'])
    expect(r.status.undescribedAreas).toEqual(['area:svc@L3'])
    expect(dataOf(r.html).t.areas).toEqual({})
    expect(dataOf(r.html).stale.areas).toBe(1)
  })

  it('the limits count the jobs of the graph, and say that the other files of L0 show only the connections from jobs', () => {
    const wf = { id: 'file:.github/workflows/ci.yml', kind: 'file', name: 'ci.yml', parent: 'area:svc@L3', file: '.github/workflows/ci.yml', line: 1, layer: 'L0' }
    const job = (id, line) => ({ id: `job:.github/workflows/ci.yml#${id}`, kind: 'job', name: id, parent: wf.id, file: wf.file, line, layer: 'L0' })
    const g = makeGraph([wf, job('lint', 4), job('build', 9)])
    g.edges.push({ from: 'job:.github/workflows/ci.yml#build', to: 'job:.github/workflows/ci.yml#lint', kind: 'needs' })
    const d = dataOf(buildMap({ graph: g, text: baseText(), template, commit: SHA }).html)
    expect(d.limits[0]).toBe('This map shows 2 functions, 2 jobs of GitHub workflows and 2 connections.')
    expect(d.ek).toContain('needs')
    expect(d.kinds).toContain('job')
    const l0 = d.limits.find((l) => l.startsWith('L0 shows'))
    expect(l0).toMatch(/jobs of the GitHub workflows/)
    // The other files of L0 show only the connections that come from jobs. The text must not say that they show none.
    expect(l0).toMatch(/A job shows its own connections\./)
    expect(l0).toMatch(/A workflow file shows the connections of its jobs\./)
    expect(l0).toMatch(/The other files of L0 show only the connections from jobs\./)
    expect(l0).not.toMatch(/for these jobs only|does not show connections/)
    expect(l0).not.toMatch(/files only/)
    expect(dataOf(buildMap({ graph: makeGraph(), text: baseText(), template, commit: SHA }).html).limits[0]).toBe('This map shows 2 functions, 0 jobs of GitHub workflows and 1 connections.')
  })

  it('the share of resolved calls comes from the graph, not from a constant', () => {
    const limits = (ratio) => dataOf(buildMap({ graph: makeGraph([], ratio), text: baseText(), template, commit: SHA }).html).limits.join(' ')
    expect(limits(85.6)).toContain('86 percent')
    expect(limits(72.4)).toContain('72 percent')
    expect(limits(72.4)).not.toContain('86 percent')
  })

  it('the commit comes from the argument; unknown stays unknown and a bad value becomes unknown', () => {
    expect(dataOf(buildMap({ graph: makeGraph(), text: baseText(), template, commit: SHA }).html).commit).toBe(SHA.slice(0, 8))
    const u = buildMap({ graph: makeGraph(), text: baseText(), template, commit: 'unknown' })
    expect(dataOf(u.html).commit).toBe('unknown')
    expect(u.status.commit).toBe('unknown')
    expect(buildMap({ graph: makeGraph(), text: baseText(), template, commit: 'not a sha; rm -rf' }).status.commit).toBe('unknown')
    expect(template).toContain('Made from the code at an unknown version.')
  })

  it('keeps the < escape in the embedded data', () => {
    const t = baseText({ intro: ['</script><b>x</b>'] })
    const html = buildMap({ graph: makeGraph(), text: t, template, commit: SHA }).html
    expect(html.split('const D=')[1].split('\n')[0]).not.toContain('<')
    expect(dataOf(html).t.intro[0]).toBe('</script><b>x</b>')
  })

  it('a leak in the page: no html, ok:false and a reason with the rule id only', () => {
    const secret = ['203', '0', '113', '77'].join('.')
    const t = baseText({ intro: [`Open ${secret} now.`] })
    const r = buildMap({ graph: makeGraph(), text: t, template, commit: SHA })
    expect(r.ok).toBe(false)
    expect(r.html).toBeNull()
    expect(r.status.ok).toBe(false)
    expect(r.status.reason).toBe('leak-scan: ipv4')
    expect(JSON.stringify(r.status)).not.toContain(secret)
  })

  // A host name is built from parts so that this public file holds none.
  const host = ['panel', 'acme-uni', 'de'].join('.')

  it('a leak in the text of a stale step: the refused status does not carry the stale text either', () => {
    const t = baseText({ walkthroughs: [{ title: 'Example one', steps: [{ text: 'First.', file: 'svc/a.ts', function: 'alpha' }, { text: `Open ${host} now.`, file: 'svc/a.ts', function: 'renamed' }] }] })
    const r = buildMap({ graph: makeGraph(), text: t, template, commit: SHA })
    expect(r.ok).toBe(false)
    expect(r.html).toBeNull()
    expect(r.status.reason).toBe('leak-scan: domain')
    expect(JSON.stringify(r.status)).not.toContain('acme-uni')
    expect(r.status).toMatchObject({ staleSteps: [], staleAreas: [], undescribedAreas: [] })
  })

  it('a leak only in the status (a stale area id): the page is refused too, and the status carries no name', () => {
    const t = baseText({ areas: { 'area:svc@L3': { title: 'Service', what: 'w', why: 'y', leadsTo: 'l' }, [`area:${host}@L0`]: { title: 'Old', what: 'w', why: 'y', leadsTo: 'l' } } })
    const r = buildMap({ graph: makeGraph(), text: t, template, commit: SHA })
    expect(r.ok).toBe(false)
    expect(r.html).toBeNull()
    expect(r.status.reason).toBe('leak-scan: domain')
    expect(JSON.stringify(r.status)).not.toContain('acme-uni')
  })
})

describe('the template', () => {
  it('makes no request to any outside host', () => {
    expect(template).not.toMatch(/https?:\/\//i)
    expect(template).not.toMatch(/<link\b/i)
    expect(template).not.toMatch(/@import|fonts\.(googleapis|gstatic)/i)
  })

  it('shows the stale notices in the walk view, the flow map and the home view', () => {
    expect(template).toContain('does not match the code now')
    expect(template).toContain('walkNotice')
    expect(template).toContain('D.stale')
  })

  it('knows the job item and the needs and runs edge kinds in every map that lists kinds', () => {
    expect(template).toMatch(/KN=\{[^}]*job:'Job'/)
    for (const name of ['EV', 'K3', 'KC', 'KW']) {
      // One pattern for each name. K3 is an arrow function that returns an object; the others are plain objects.
      const head = name === 'K3' ? 'const K3=k=>\\(' : `const ${name}=`
      const body = new RegExp(`${head}\\{[^}]*\\}`).exec(template)?.[0] ?? ''
      expect(body, name).toMatch(/needs:/)
      expect(body, name).toMatch(/runs:/)
    }
    expect(template).toMatch(/const direct=i=>\[[^\]]*'job'/)
    expect(template).toMatch(/rank=\{[^}]*job:/)
    expect(template).toContain("['--bp-needs'")
    expect(template).toContain("['--bp-runs'")
    expect(template).toMatch(/--job:#[0-9a-f]{6}/)
  })

  it('holds no guard that throws for an empty example list', () => {
    expect(template).toContain('T.walkthroughs.length')
  })
})

describe('the command line', () => {
  let dir
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-build-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
  const run = (graph, args = []) => {
    const g = path.join(dir, 'graph.json')
    fs.writeFileSync(g, JSON.stringify(graph))
    return spawnSync(process.execPath, [path.join(HERE, 'build.mjs'), '--graph', g, '--commit', SHA, '--out-dir', path.join(dir, 'out'), ...args], { encoding: 'utf8' })
  }

  it('writes code-map.html and status.json and exits 0', () => {
    const r = run(makeGraph())
    expect(r.status).toBe(0)
    expect(fs.existsSync(path.join(dir, 'out', 'code-map.html'))).toBe(true)
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'status.json'), 'utf8'))
    expect(s.ok).toBe(true)
    expect(s.commit).toBe(SHA)
    expect(Object.keys(s)).toEqual(['ok', 'commit', 'generatedFor', 'counts', 'staleSteps', 'staleAreas', 'undescribedAreas', 'reason'])
  })

  it('the real text matches no node of this small graph: still exit 0, with stale lists in the status', () => {
    const s = (run(makeGraph()), JSON.parse(fs.readFileSync(path.join(dir, 'out', 'status.json'), 'utf8')))
    expect(s.staleSteps.length).toBeGreaterThan(0)
    expect(s.ok).toBe(true)
  })

  it('a leak writes no html, removes an old one, writes ok:false and still exits 0', () => {
    fs.mkdirSync(path.join(dir, 'out'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'out', 'code-map.html'), 'old')
    const g = makeGraph([{ id: 'page:/x', kind: 'page', name: 'See ' + ['203', '0', '113', '5'].join('.'), parent: 'file:svc/a.ts', file: 'svc/a.ts', line: 1, layer: 'L5' }])
    const r = run(g)
    expect(r.status).toBe(0)
    expect(fs.existsSync(path.join(dir, 'out', 'code-map.html'))).toBe(false)
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'status.json'), 'utf8'))
    expect(s.ok).toBe(false)
    expect(s.reason).toBe('leak-scan: ipv4')
    expect(r.stdout + r.stderr).not.toContain(['203', '0', '113', '5'].join('.'))
  })
})
