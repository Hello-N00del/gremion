// check.mjs: the CI check LISTS what does not match and never blocks on it. Its exit codes are distinct: 0 it ran
// (stale items allowed), 1 a leak was found, 3 the tool itself failed (the extractor, a file it cannot read, a crash).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { analyse, escapeCommand, EXIT_LEAK, EXIT_RAN, EXIT_TOOL_FAILED, markdownSummary } from './check.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const template = fs.readFileSync(path.join(HERE, 'template.html'), 'utf8')
const layer = (l) => ({ id: `L${l}`, kind: 'layer', name: `L${l}`, parent: null, file: '', line: 0, layer: `L${l}` })
const graph = () => ({
  meta: { commit: 'x', resolvedRatioPercent: 80 },
  nodes: [
    ...[0, 1, 2, 3, 4, 5].map(layer),
    { id: 'area:a@L3', kind: 'area', name: 'a', parent: 'L3', file: '', line: 0, layer: 'L3' },
    { id: 'area:b@L3', kind: 'area', name: 'b', parent: 'L3', file: '', line: 0, layer: 'L3' },
    { id: 'fn:x.ts#f@3', kind: 'function', name: 'f', parent: 'L3', file: 'x.ts', line: 3, layer: 'L3' },
    { id: 'fn:x.ts#f@9', kind: 'function', name: 'f', parent: 'L3', file: 'x.ts', line: 9, layer: 'L3' },
  ],
  edges: [],
})
const text = (over = {}) => ({
  intro: ['One.'],
  howToRead: ['Two.'],
  layers: Object.fromEntries([0, 1, 2, 3, 4, 5].map((l) => [`L${l}`, { title: 'T', text: 'A.' }])),
  glossary: {},
  areas: { 'area:a@L3': { title: 'A', what: 'w', why: 'y', leadsTo: 'l' }, 'area:gone@L3': { title: 'G', what: 'w', why: 'y', leadsTo: 'l' } },
  walkthroughs: [{ title: 'W', steps: [{ text: 'dup', file: 'x.ts', function: 'f' }, { text: 'old text', file: 'x.ts', function: 'moved' }] }],
  ...over,
})
const run = (over) => analyse({ graph: graph(), text: text(over), template, textSource: JSON.stringify(text(over)), templateSource: template, commit: 'unknown', steFindings: { count: 5, byRule: { COVER: 5 } } })

describe('analyse', () => {
  it('lists stale steps, stale and undescribed areas and ambiguous steps, and exits 0', () => {
    const r = run()
    expect(r.exitCode).toBe(0)
    expect(r.lists.staleSteps).toEqual([{ walkthrough: 'W', step: 2, file: 'x.ts', function: 'moved', text: 'old text' }])
    expect(r.lists.staleAreas).toEqual(['area:gone@L3'])
    expect(r.lists.undescribedAreas).toEqual(['area:b@L3'])
    expect(r.lists.ambiguousSteps).toHaveLength(1)
    expect(r.report).toContain('moved')
    expect(r.report).toContain('old text')
    expect(r.report).toContain('area:gone@L3')
    expect(r.report).toContain('STE findings: 5')
  })

  it('one warning for each stale item, never an error', () => {
    const r = run()
    expect(r.warnings.length).toBe(1 + 1)
    expect(r.warnings.join('\n')).not.toMatch(/::error/)
  })

  it('a leak in the text file is exit 1, named by rule and place, never by the matched text', () => {
    const secret = ['203', '0', '113', '9'].join('.')
    const r = run({ intro: [`Go to ${secret}`] })
    expect(r.exitCode).toBe(1)
    expect(r.leaks.map((l) => l.rule)).toContain('ipv4')
    expect(r.report).toContain('ipv4')
    expect(r.report).toContain('ste-text.json')
    expect(r.report).not.toContain(secret)
    expect(r.errors.join('\n')).not.toContain(secret)
  })

  it('a leak in the template is exit 1 too', () => {
    const r = analyse({ graph: graph(), text: text(), template: template + ' <!-- ' + ['198', '51', '100', '4'].join('.') + ' -->', textSource: '{}', templateSource: template + ' ' + ['198', '51', '100', '4'].join('.'), commit: 'unknown', steFindings: { count: 0, byRule: {} } })
    expect(r.exitCode).toBe(1)
    expect(r.report).toContain('template.html')
  })

  it('nothing wrong: exit 0 and no warnings', () => {
    const r = analyse({ graph: graph(), text: { ...text(), areas: { 'area:a@L3': text().areas['area:a@L3'], 'area:b@L3': text().areas['area:a@L3'] }, walkthroughs: [] }, template, textSource: '{}', templateSource: template, commit: 'unknown', steFindings: { count: 0, byRule: {} } })
    expect(r.exitCode).toBe(0)
    expect(r.warnings).toEqual([])
  })
})

describe('the CI helpers', () => {
  it('escapes a workflow command message', () => {
    expect(escapeCommand('a%b\nc\rd')).toBe('a%25b%0Ac%0Dd')
  })

  it('the markdown summary is a table with one row for each stale item', () => {
    const md = markdownSummary(run())
    expect(md).toContain('| ')
    expect(md).toContain('moved')
    expect(md).toContain('area:gone@L3')
  })
})

describe('the exit codes: 0 it ran, 1 a leak, 3 the tool itself failed', () => {
  it('the three codes are distinct and fixed (the merge-gate arm in scripts/ci-local reads them)', () => {
    expect([EXIT_RAN, EXIT_LEAK, EXIT_TOOL_FAILED]).toEqual([0, 1, 3])
  })
})

// A copy of this folder in a temp folder, with an extractor of the test's own, and a temp folder of its own to look into.
function runCopy(extractSource, mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-check-test-'))
  try {
    const tool = path.join(root, 'codemap')
    const scratch = path.join(root, 'tmp')
    fs.mkdirSync(tool)
    fs.mkdirSync(scratch)
    for (const f of fs.readdirSync(HERE)) if (!f.endsWith('.test.mjs') && fs.statSync(path.join(HERE, f)).isFile()) fs.copyFileSync(path.join(HERE, f), path.join(tool, f))
    fs.writeFileSync(path.join(tool, 'extract.mjs'), extractSource)
    mutate(tool)
    const res = spawnSync(process.execPath, [path.join(tool, 'check.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch, GITHUB_STEP_SUMMARY: '' },
    })
    return { res, leftInTemp: fs.readdirSync(scratch) }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}
// An extractor that writes a graph with the six layers and nothing else, to the --out path it is given.
const GRAPH_WRITER = [
  "import fs from 'node:fs'",
  "import path from 'node:path'",
  "const out = process.argv[process.argv.indexOf('--out') + 1]",
  'fs.mkdirSync(path.dirname(out), { recursive: true })',
  "const nodes = [0, 1, 2, 3, 4, 5].map((l) => ({ id: 'L' + l, kind: 'layer', name: 'L' + l, parent: null, file: '', line: 0, layer: 'L' + l }))",
  "fs.writeFileSync(out, JSON.stringify({ meta: { commit: 'x', resolvedRatioPercent: 80 }, nodes, edges: [] }))",
  '',
].join('\n')

describe('the run, when the extractor fails', () => {
  it('exits 3 (the tool failed, not a leak) and still removes its temp folder (a process.exit inside the try would skip the finally)', () => {
    const { res, leftInTemp } = runCopy('console.error("boom"); process.exit(3)\n')
    expect(res.status).toBe(3)
    expect(res.stderr).toMatch(/the extractor failed \(exit 3\)/)
    expect(leftInTemp).toEqual([])
  })

  it('exits 3 when the extractor is killed or exits with any other code', () => {
    const { res } = runCopy('process.exit(2)\n')
    expect(res.status).toBe(3)
    expect(res.stderr).toMatch(/the extractor failed \(exit 2\)/)
  })
})

describe('the run, when the check itself crashes after the extractor ran', () => {
  it('exits 3, says so, and removes its temp folder (here the text file is not JSON)', () => {
    const { res, leftInTemp } = runCopy(GRAPH_WRITER, (tool) => fs.writeFileSync(path.join(tool, 'ste-text.json'), '{ not json'))
    expect(res.status).toBe(3)
    expect(res.stderr).toMatch(/the check crashed/)
    expect(leftInTemp).toEqual([])
  })
})

describe('the run, when a leak is found', () => {
  it('exits 1, names the rule and the place and never the matched text, and prints the lines the merge-gate arm reads', () => {
    const secret = ['203', '0', '113', '9'].join('.')
    const { res, leftInTemp } = runCopy(GRAPH_WRITER, (tool) => {
      const t = JSON.parse(fs.readFileSync(path.join(tool, 'ste-text.json'), 'utf8'))
      t.intro = [`Go to ${secret}`]
      fs.writeFileSync(path.join(tool, 'ste-text.json'), JSON.stringify(t))
    })
    expect(res.status).toBe(1)
    expect(res.stdout).toMatch(/^leaks: [1-9]/m)
    expect(res.stdout).toMatch(/::error title=Code map leak::ipv4 in ste-text\.json/)
    expect(res.stdout + res.stderr).not.toContain(secret)
    expect(leftInTemp).toEqual([])
  })
})

describe('the run, when the check ran and found only stale text', () => {
  it('exits 0 and prints the three lists that the merge-gate arm reads', () => {
    const { res } = runCopy(GRAPH_WRITER)
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/^stale steps: \d+/m)
    expect(res.stdout).toMatch(/^stale areas: \d+/m)
    expect(res.stdout).toMatch(/^undescribed areas: \d+/m)
    expect(res.stdout).toMatch(/^ambiguous steps: \d+/m)
  })
})
