// The built page, made from a FIXTURE tree (a small repository written into a temp folder, read by the real extract.mjs
// the way the image reads it) and a fixture text, run in a DOM (jsdom): a job item renders with the lens, and an
// example that crosses two workflows plays in the walk view and in the flow map.
//
// The test does NOT read this repository. The code map never blocks a build: a refactor that renames a function that
// a walkthrough names, or a job that a CI file renames, can only make the map say so (codemap/check.mjs lists it). If
// this test read the real graph, the same rename would turn the merge gate red. The shape of the page is what is
// tested here; whether the real text still matches the real code is the work of check.mjs.
//
// jsdom is not a dependency of the control panel; the test finds it in the pnpm store of a full install and says so
// when it is not there (the DOM part then skips, and the data part still runs).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildMap } from './build.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PANEL = path.resolve(HERE, '..')
const ROOT = path.resolve(PANEL, '..', '..')
const SHA = 'b'.repeat(40)
const EXAMPLE = 'CI: a change is checked and becomes an image'
const FIXTURE_EXAMPLE = 'Fixture: a change is checked and becomes an image'

function findJsdom() {
  try { return createRequire(import.meta.url)('jsdom') } catch { /* look in the pnpm store */ }
  try {
    const store = path.join(ROOT, 'node_modules', '.pnpm')
    const dirs = fs.readdirSync(store).filter((d) => /^jsdom@\d/.test(d)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const d of dirs) {
      try { return createRequire(path.join(store, d, 'node_modules', 'jsdom', 'package.json'))('jsdom') } catch { /* try the next version */ }
    }
  } catch { /* no store */ }
  return null
}
const jsdom = findJsdom()

const CI = [
  'name: CI',
  'on: push',
  'jobs:',
  '  changes:',
  '    name: Changes',
  '    runs-on: ubuntu-latest',
  '  lint:',
  '    name: Lint',
  '    runs-on: ubuntu-latest',
  '  verify-static:',
  '    name: Verify Static',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: node scripts/check.mjs',
  '  docker-build:',
  '    name: Docker Image Builds',
  '    needs: [lint, changes]',
  '    strategy:',
  '      matrix:',
  '        include:',
  '          - { name: panel, dockerfile: apps/control-panel/Dockerfile, context: . }',
  '  verify-gate:',
  '    name: Verify Gate',
  '    needs: [lint, verify-static]',
  '    runs-on: ubuntu-latest',
  '',
].join('\n')
const RELEASE = [
  'name: Release images',
  'on: workflow_dispatch',
  'jobs:',
  '  resolve-ref:',
  '    runs-on: ubuntu-latest',
  '  build-and-push:',
  '    needs: [resolve-ref]',
  '    runs-on: ubuntu-latest',
  '  emit-release-pins:',
  '    needs: [build-and-push]',
  '    runs-on: ubuntu-latest',
  '',
].join('\n')
const ci = (j) => `job:.github/workflows/ci.yml#${j}`
const ri = (j) => `job:.github/workflows/release-images.yml#${j}`
const STEPS = [
  ['A person pushes a change. GitHub starts the workflow in this file.', 'file:.github/workflows/ci.yml'],
  ['On a pull request only, this job reads the list of changed files.', ci('changes')],
  ['This job runs fast checks on the files. Other jobs wait for it.', ci('lint')],
  ['A verify job starts at the same time as lint. It runs one script.', ci('verify-static')],
  ['This job builds each container image. It waits for lint and changes.', ci('docker-build')],
  ['This file is the recipe of the control panel image.', 'file:apps/control-panel/Dockerfile'],
  ['This job waits for lint and for the verify job. It gives the one verdict.', ci('verify-gate')],
  ['A person starts the second workflow by hand. It makes the images.', 'file:.github/workflows/release-images.yml'],
  ['This job finds the commit that the images are made from.', ri('resolve-ref')],
  ['This job builds the images and pushes them to the registry.', ri('build-and-push')],
  ['The last job pins files to the digests of the new images.', ri('emit-release-pins')],
]

let tmp, graph, text, built, html
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-page-'))
  const tree = path.join(tmp, 'tree')
  const put = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true })
    fs.writeFileSync(path.join(tree, rel), body)
  }
  put('.github/workflows/ci.yml', CI)
  put('.github/workflows/release-images.yml', RELEASE)
  put('apps/control-panel/Dockerfile', 'FROM scratch\n')
  put('scripts/check.mjs', 'console.log(1)\n')
  put('packages/x/package.json', JSON.stringify({ name: '@fixture/x', description: 'A tiny package.' }))
  put('packages/x/src/a.ts', 'export function addOne(n: number): number {\n  return n + 1\n}\n')
  const out = path.join(tmp, 'graph.json')
  const res = spawnSync(process.execPath, [path.join(HERE, 'extract.mjs'), '--tree', '--commit', SHA, '--kernel', tree, '--out', out, '--deps', PANEL], { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 120_000 })
  if (res.status !== 0) throw new Error(`extract.mjs exited ${res.status}: ${String(res.stderr).slice(-300)}`)
  graph = JSON.parse(fs.readFileSync(out, 'utf8'))
  // The prose that is not about one graph (intro, layers, glossary) comes from the real text file; its walkthroughs
  // and areas are the fixture's own, so no rename in this repository can reach this test.
  const real = JSON.parse(fs.readFileSync(path.join(HERE, 'ste-text.json'), 'utf8'))
  text = {
    intro: real.intro,
    howToRead: real.howToRead,
    layers: real.layers,
    glossary: real.glossary,
    areas: {},
    walkthroughs: [
      { title: FIXTURE_EXAMPLE, steps: STEPS.map(([t, nodeId]) => ({ text: t, nodeId })) },
      { title: 'Fixture: one step names a job that is gone', steps: [{ text: 'This file holds the jobs.', nodeId: 'file:.github/workflows/ci.yml' }, { text: 'This job has a new name now.', nodeId: ci('renamed-away') }] },
    ],
  }
  built = buildMap({ graph, text, template: fs.readFileSync(path.join(HERE, 'template.html'), 'utf8'), commit: SHA })
  html = built.html
}, 150_000)
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const idx = (id) => graph.nodes.findIndex((n) => n.id === id)

describe('the built page: data', () => {
  it('is built from the fixture, and a stale step does not stop it: the map only says so', () => {
    // The rule of the whole map: stale text is listed, never a reason to fail. One step above names a job that is gone.
    expect(built.ok).toBe(true)
    expect(built.status.staleSteps).toHaveLength(1)
    expect(built.status.staleSteps[0]).toMatchObject({ walkthrough: 'Fixture: one step names a job that is gone', step: 2 })
    expect(JSON.parse(/const D=(.*);\n/.exec(html)[1]).stale.steps).toBe(1)
    // and the steps of the good example all resolve
    expect(built.status.staleSteps.some((s) => s.walkthrough === FIXTURE_EXAMPLE)).toBe(false)
  })

  it('holds job items and the needs and runs edge kinds, and the limits say what L0 shows', () => {
    const d = JSON.parse(/const D=(.*);\n/.exec(html)[1])
    expect(d.kinds).toContain('job')
    expect(d.ek).toEqual(expect.arrayContaining(['needs', 'runs']))
    const limits = d.limits.join(' ')
    expect(limits).toMatch(/jobs of GitHub workflows/)
    expect(limits).toMatch(/L0 shows files and the jobs of the GitHub workflows/)
    expect(limits).not.toMatch(/L0 shows files only/)
    expect(d.t.walkthroughs.map((w) => w.title)).toContain(FIXTURE_EXAMPLE)
  })

  it('the real text file holds the example, 8 to 11 steps, by node id (text only: no graph is read)', () => {
    const real = JSON.parse(fs.readFileSync(path.join(HERE, 'ste-text.json'), 'utf8'))
    const w = real.walkthroughs.find((x) => x.title === EXAMPLE)
    expect(w).toBeTruthy()
    expect(w.steps.length).toBeGreaterThanOrEqual(8)
    expect(w.steps.length).toBeLessThanOrEqual(11)
    expect(w.steps.every((s) => /^(job|file):/.test(s.nodeId))).toBe(true)
  })

  it('the fixture graph has the needs the example implies', () => {
    const needs = (a, b) => graph.edges.some((e) => e.kind === 'needs' && e.from === a && e.to === b)
    expect(needs(ci('docker-build'), ci('lint'))).toBe(true)
    expect(needs(ci('docker-build'), ci('changes'))).toBe(true)
    expect(needs(ri('emit-release-pins'), ri('build-and-push'))).toBe(true)
    expect(graph.edges.some((e) => e.kind === 'runs' && e.from === ci('docker-build') && e.to === 'file:apps/control-panel/Dockerfile')).toBe(true)
  })
})

describe.skipIf(!jsdom)('the built page: a DOM run', () => {
  let win, errors
  const $ = (s) => win.document.querySelector(s)
  const $$ = (s) => [...win.document.querySelectorAll(s)]
  const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))

  beforeAll(() => {
    errors = []
    const virtualConsole = new jsdom.VirtualConsole()
    virtualConsole.on('jsdomError', (e) => errors.push(String(e.message ?? e)))
    virtualConsole.on('error', (e) => errors.push(String(e)))
    const dom = new jsdom.JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://map.invalid/', virtualConsole, beforeParse: (w) => { w.scrollTo = () => {} } })
    win = dom.window
  }, 60_000)
  afterAll(() => win?.close())

  it('runs without a script error', () => {
    expect(errors).toEqual([])
    expect($('h1').textContent).toBe('Gremion Code Map')
  })

  it('a job renders with the Job label, its generated text from the graph, and the lens with both sides', () => {
    win.__cmView(idx('job:.github/workflows/ci.yml#docker-build'))
    const main = $('#main')
    expect(main.querySelector('.chip').textContent).toBe('Job')
    expect(main.querySelector('h2').textContent).toBe('docker-build: Docker Image Builds')
    expect(main.textContent).toContain('This job is part of the workflow ci.yml.')
    expect(main.textContent).toContain('It starts after these jobs: changes, lint.')
    expect(main.textContent).toMatch(/It runs or builds these items: .*apps\/control-panel\/Dockerfile/)
    expect($('#lens')).toBeTruthy()
    const right = $$('#cr .item').map((b) => b.textContent)
    expect(right.some((t) => t.includes('lint') && t.includes('a job that this job waits for'))).toBe(true)
    expect(right.some((t) => t.includes('Dockerfile') && t.includes('a file or an area that this job runs or works on'))).toBe(true)
    // the job that waits for nothing has a left side that says who waits for it
    win.__cmView(idx('job:.github/workflows/ci.yml#lint'))
    const left = $$('#cl .item').map((b) => b.textContent)
    expect(left.some((t) => t.includes('docker-build') && t.includes('waits for this job'))).toBe(true)
    expect($('#main').textContent).toContain('It does not wait for a different job.')
  })

  it('a job is found by the search, and the workflow file lists its jobs', () => {
    const q = $('#q')
    q.value = 'verify-gate'
    q.dispatchEvent(new win.Event('input', { bubbles: true }))
    const hits = $$('#res .link').map((b) => b.textContent)
    expect(hits[0]).toMatch(/^Job verify-gate/)
    win.__cmView(idx('file:.github/workflows/ci.yml'))
    const cards = $$('.card').map((c) => c.textContent)
    expect(cards.some((t) => t.startsWith('lint: Lint') && t.includes('Job, line'))).toBe(true)
  })

  it('the new example is listed, and it plays step by step in the walk view', () => {
    $('#t0').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
    const links = $$('#pane [data-ex]')
    const n = links.findIndex((l) => l.textContent === FIXTURE_EXAMPLE)
    expect(n).toBeGreaterThanOrEqual(0)
    click(links[n])
    const total = text.walkthroughs.find((w) => w.title === FIXTURE_EXAMPLE).steps.length
    for (let s = 0; s < total; s++) {
      const walk = $('#main .walk')
      expect(walk.querySelector('h3').textContent).toBe(`Example ${n + 1}: step ${s + 1} of ${total}`)
      expect(walk.querySelector('h2').textContent).toBe(FIXTURE_EXAMPLE)
      expect(walk.querySelector('.txt').textContent.length).toBeGreaterThan(20)
      if (s < total - 1) click(walk.querySelector('[data-w="1"]'))
    }
    expect($('#main .walk .txt').textContent).toContain('pins files')
    expect($('#main .walk [data-w="1"]').disabled).toBe(true)
    expect($('#main .walk .stale')).toBeNull()
    click($('#main .walk [data-w="0"]'))
    expect($('#main .walk')).toBeNull()
  })

  it('the new example plays in the flow map: one node for each step, the wire order, the new legend and row colours', () => {
    click($('#m1'))
    const sel = $('#fm-ex')
    const n = [...sel.options].findIndex((o) => o.textContent === FIXTURE_EXAMPLE)
    expect(n).toBeGreaterThanOrEqual(0)
    sel.value = String(n)
    sel.dispatchEvent(new win.Event('change'))
    const total = text.walkthroughs.find((w) => w.title === FIXTURE_EXAMPLE).steps.length
    expect($$('#fm-world .bn')).toHaveLength(total)
    expect($('#fm-count').textContent).toBe(`Step 1 of ${total}`)
    expect($$('#fm-wires path.exec')).toHaveLength(total - 1)
    const kinds = $$('#fm-world .bn header span:first-child').map((s) => s.textContent)
    expect(kinds).toContain('Job')
    expect(kinds).toContain('File')
    for (let s = 1; s < total; s++) click($('#fm-next'))
    expect($('#fm-count').textContent).toBe(`Step ${total} of ${total}`)
    expect($('#fm-next').disabled).toBe(true)
    expect($('#fm-info').textContent).toContain('pins files')
    const rows = $$('#fm-world .bn .rw').map((r) => r.textContent)
    expect(rows.some((t) => /^Waits for \d+/.test(t))).toBe(true)
    expect(rows.some((t) => /^Runs \d+/.test(t))).toBe(true)
    const colours = $$('#fm-world .bn .rw').map((r) => r.getAttribute('style'))
    expect(colours.some((c) => c.includes('--bp-needs'))).toBe(true)
    expect(colours.some((c) => c.includes('--bp-runs'))).toBe(true)
    const legend = $('#fm-legend').textContent
    expect(legend).toContain('A job waits for a job')
    expect(legend).toContain('A job runs a file or works on an area')
    // a row opens the items that the job waits for or runs, with a wire to each
    const before = $$('#fm-world .bn').length
    click($$('#fm-world .bn .rw').find((r) => /^Runs \d+/.test(r.textContent)))
    expect($$('#fm-world .bn').length).toBeGreaterThan(before)
    expect(errors).toEqual([])
  })
})
