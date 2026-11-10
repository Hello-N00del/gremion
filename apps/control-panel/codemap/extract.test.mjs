// The real extract.mjs, run the way the image runs it (--tree, --deps), against a tiny tree. The other tests use a
// fake extractor; this one is the only place where the real program meets a tree.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PANEL = path.resolve(HERE, '..')
const SHA = '0123456789abcdef0123456789abcdef01234567'

describe('extract.mjs --tree --deps', () => {
  let root, tree, out
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-extract-'))
    tree = path.join(root, 'tree')
    out = path.join(root, 'out', 'graph.json')
    fs.mkdirSync(tree)
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const run = (...extra) => spawnSync(process.execPath, [path.join(HERE, 'extract.mjs'), '--tree', '--kernel', tree, '--out', out, '--deps', PANEL, ...extra], { encoding: 'utf8', maxBuffer: 1 << 26 })

  it('makes the graph of a tree with one package: its function node, its area, and the commit that was given', () => {
    fs.mkdirSync(path.join(tree, 'packages', 'x', 'src'), { recursive: true })
    fs.writeFileSync(path.join(tree, 'packages', 'x', 'package.json'), JSON.stringify({ name: '@fixture/x', description: 'A tiny package.' }))
    fs.writeFileSync(path.join(tree, 'packages', 'x', 'src', 'a.ts'), 'export function addOne(n: number): number {\n  return n + 1\n}\n')
    const res = run('--commit', SHA)
    expect(res.status, res.stderr).toBe(0)
    const graph = JSON.parse(fs.readFileSync(out, 'utf8'))
    const fn = graph.nodes.find((n) => n.kind === 'function' && n.name === 'addOne')
    expect(fn).toMatchObject({ file: 'packages/x/src/a.ts', line: 1, layer: 'L2', exported: true, parent: 'file:packages/x/src/a.ts' })
    expect(graph.nodes.find((n) => n.id === 'file:packages/x/src/a.ts')).toMatchObject({ kind: 'file', parent: 'area:packages/x@L2' })
    expect(graph.nodes.find((n) => n.id === 'area:packages/x@L2')).toMatchObject({ kind: 'area', name: '@fixture/x', layer: 'L2' })
    expect(JSON.stringify(graph.meta)).toContain(SHA)
  })

  it('reads a commit that is not 40 hex characters as unknown', () => {
    fs.mkdirSync(path.join(tree, 'packages', 'x', 'src'), { recursive: true })
    fs.writeFileSync(path.join(tree, 'packages', 'x', 'src', 'a.ts'), 'export const one = (): number => 1\n')
    const res = run('--commit', 'not-a-sha')
    expect(res.status, res.stderr).toBe(0)
    const graph = JSON.parse(fs.readFileSync(out, 'utf8'))
    expect(JSON.stringify(graph.meta)).not.toContain('not-a-sha')
    expect(JSON.stringify(graph.meta)).toContain('unknown')
  })

  it('an empty tree is the designed failure: exit 3, a message that says why, and no graph file', () => {
    const res = run('--commit', SHA)
    expect(res.status).toBe(3)
    expect(res.stderr).toMatch(/the graph has no nodes/)
    expect(fs.existsSync(out)).toBe(false)
  })
})

// ---- GitHub Actions workflows: jobs, needs and runs -------------------------------------------------------------
describe('extract.mjs: workflows', () => {
  let root, tree, out
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-wf-'))
    tree = path.join(root, 'tree')
    out = path.join(root, 'out', 'graph.json')
    fs.mkdirSync(tree)
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true })
    fs.writeFileSync(path.join(tree, rel), text)
  }
  const CI = [
    'name: CI',
    'on: push',
    'jobs:',
    '  lint:',
    '    name: Lint',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: node scripts/tool.mjs',
    '  build:',
    '    name: Build the image',
    '    needs: [lint, ghost]',
    '    strategy:',
    '      matrix:',
    '        include:',
    '          - { name: web, dockerfile: apps/web/Dockerfile, context: . }',
    '          - { name: gone, dockerfile: apps/gone/Dockerfile, context: . }',
    '    steps:',
    '      - run: pnpm --filter @fixture/x build',
    '      - run: node scripts/tool.test.mjs',
    '      - run: bash scripts/ghost.sh',
    '      - run: node scripts/gen.mts',
    '  panel:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: pnpm run check',
    '        working-directory: apps/nowhere',
    '',
  ].join('\n')
  const fixture = () => {
    put('.github/workflows/ci.yml', CI)
    put('.github/workflows/broken.yml', '\u0000\u0001 }{ ::: not yaml\n')
    put('packages/x/package.json', JSON.stringify({ name: '@fixture/x', description: 'A tiny package.' }))
    put('packages/x/src/a.ts', 'export function addOne(n: number): number {\n  return n + 1\n}\n')
    put('apps/web/Dockerfile', 'FROM scratch\n')
    put('scripts/tool.mjs', 'console.log(1)\n')
    put('scripts/tool.test.mjs', 'console.log(2)\n')
    put('scripts/gen.mts', 'export function generateIt(): number {\n  return 3\n}\n')
  }
  const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: tree, encoding: 'utf8' })
  const extract = (outFile, ...extra) =>
    spawnSync(process.execPath, [path.join(HERE, 'extract.mjs'), '--kernel', tree, '--out', outFile, '--deps', PANEL, ...extra], { encoding: 'utf8', maxBuffer: 1 << 26 })
  const read = (f = out) => JSON.parse(fs.readFileSync(f, 'utf8'))
  const edge = (g, from, to, kind) => g.edges.find((e) => e.from === from && e.to === to && e.kind === kind)

  it('makes one area for each workflow, with the workflow file in it, and a job node for each job', () => {
    fixture()
    const res = extract(out, '--tree', '--commit', SHA)
    expect(res.status, res.stderr).toBe(0)
    const g = read()
    expect(g.nodes.find((n) => n.id === 'area:github-actions/ci@L0')).toMatchObject({ kind: 'area', parent: 'L0', layer: 'L0' })
    expect(g.nodes.find((n) => n.id === 'file:.github/workflows/ci.yml')).toMatchObject({ kind: 'file', parent: 'area:github-actions/ci@L0', layer: 'L0' })
    expect(g.nodes.find((n) => n.id === 'job:.github/workflows/ci.yml#lint')).toMatchObject({ kind: 'job', name: 'lint: Lint', parent: 'file:.github/workflows/ci.yml', file: '.github/workflows/ci.yml', layer: 'L0', line: 4 })
    expect(g.nodes.find((n) => n.id === 'job:.github/workflows/ci.yml#panel')).toMatchObject({ kind: 'job', name: 'panel' })
    expect(g.nodes.filter((n) => n.kind === 'job').map((n) => n.id)).toEqual(['job:.github/workflows/ci.yml#build', 'job:.github/workflows/ci.yml#lint', 'job:.github/workflows/ci.yml#panel'])
  })

  it('a workflow file that holds no job (here: garbage) still has its file node and area, and the run logs its path', () => {
    fixture()
    const res = extract(out, '--tree', '--commit', SHA)
    expect(res.status).toBe(0)
    expect(res.stdout).toMatch(/workflow with no job .*\.github\/workflows\/broken\.yml/)
    expect(res.stdout).not.toMatch(/workflow with no job .*\.github\/workflows\/ci\.yml/)
    const g = read()
    expect(g.nodes.find((n) => n.id === 'file:.github/workflows/broken.yml')).toMatchObject({ kind: 'file', parent: 'area:github-actions/broken@L0' })
    expect(g.nodes.some((n) => n.kind === 'job' && n.file.endsWith('broken.yml'))).toBe(false)
  })

  it('a needs edge goes from a job to each job it waits for, and only to a job that exists', () => {
    fixture()
    expect(extract(out, '--tree', '--commit', SHA).status).toBe(0)
    const g = read()
    expect(edge(g, 'job:.github/workflows/ci.yml#build', 'job:.github/workflows/ci.yml#lint', 'needs')).toBeTruthy()
    expect(g.edges.filter((e) => e.kind === 'needs')).toHaveLength(1)
  })

  it('a runs edge goes to the Dockerfile it builds, the script it runs, and the area of the package or app it works on', () => {
    fixture()
    expect(extract(out, '--tree', '--commit', SHA).status).toBe(0)
    const g = read()
    const build = 'job:.github/workflows/ci.yml#build'
    expect(edge(g, build, 'file:apps/web/Dockerfile', 'runs')).toBeTruthy()
    expect(edge(g, build, 'file:scripts/gen.mts', 'runs')).toBeTruthy()
    expect(edge(g, build, 'area:packages/x@L2', 'runs')).toBeTruthy()
    expect(edge(g, 'job:.github/workflows/ci.yml#lint', 'file:scripts/tool.mjs', 'runs')).toBeTruthy()
    // a working directory that holds no known area gives no edge
    expect(g.edges.some((e) => e.from === 'job:.github/workflows/ci.yml#panel')).toBe(false)
  })

  it('runs edges exist only for a target that exists, and a test file is not a target', () => {
    fixture()
    expect(extract(out, '--tree', '--commit', SHA).status).toBe(0)
    const g = read()
    const ids = new Set(g.nodes.map((n) => n.id))
    expect(g.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true)
    expect(g.edges.some((e) => e.kind === 'runs' && /ghost|gone|tool\.test/.test(e.to))).toBe(false)
    expect(ids.has('file:scripts/tool.test.mjs')).toBe(false)
  })

  it('a script that is not otherwise classified gets a file node in the scripts area, and is not read as TypeScript', () => {
    fixture()
    expect(extract(out, '--tree', '--commit', SHA).status).toBe(0)
    const g = read()
    expect(g.nodes.find((n) => n.id === 'area:github-actions/scripts@L0')).toMatchObject({ kind: 'area', parent: 'L0' })
    expect(g.nodes.find((n) => n.id === 'file:scripts/tool.mjs')).toMatchObject({ kind: 'file', parent: 'area:github-actions/scripts@L0', layer: 'L0' })
    expect(g.nodes.find((n) => n.id === 'file:scripts/gen.mts')).toMatchObject({ parent: 'area:github-actions/scripts@L0' })
    expect(g.nodes.some((n) => n.kind === 'function' && n.name === 'generateIt')).toBe(false)
  })

  it('a script that another layer already holds gets no second node and no scripts area of its own', () => {
    put('.github/workflows/w.yml', 'jobs:\n  j:\n    steps:\n      - run: node gremion-ui/scripts/own.ts\n')
    put('gremion-ui/scripts/own.ts', 'export function own(): number {\n  return 1\n}\n')
    expect(extract(out, '--tree', '--commit', SHA).status).toBe(0)
    const g = read()
    expect(g.nodes.filter((n) => n.id === 'file:gremion-ui/scripts/own.ts')).toHaveLength(1)
    expect(edge(g, 'job:.github/workflows/w.yml#j', 'file:gremion-ui/scripts/own.ts', 'runs')).toBeTruthy()
    expect(g.nodes.some((n) => n.id === 'area:github-actions/scripts@L0')).toBe(false)
  })

  it('a relative script is looked up in the working directory of its own step first, then at the repo root', () => {
    put('.github/workflows/w.yml', [
      'jobs:',
      '  j:',
      '    steps:',
      '      - run: node src/gen.js',
      '        working-directory: gremion-ui',
      '      - run: node src/gen.js',
      '        working-directory: gremion-public',
      '      - run: node scripts/both.mjs',
      '        working-directory: gremion-ui',
      '      - run: node scripts/rootonly.mjs',
      '        working-directory: gremion-ui',
      '      - run: node src/other.js',
      '        working-directory: gremion-ui',
      '',
    ].join('\n'))
    put('gremion-ui/src/gen.js', 'console.log(1)\n')
    put('gremion-public/src/gen.js', 'console.log(2)\n')
    put('gremion-ui/scripts/both.mjs', 'console.log(3)\n')
    put('scripts/both.mjs', 'console.log(4)\n')
    put('scripts/rootonly.mjs', 'console.log(5)\n')
    // exists in the directory of a different step only
    put('gremion-public/src/other.js', 'console.log(6)\n')
    expect(extract(out, '--tree', '--commit', SHA).status).toBe(0)
    const g = read()
    const j = 'job:.github/workflows/w.yml#j'
    expect(edge(g, j, 'file:gremion-ui/src/gen.js', 'runs')).toBeTruthy()
    expect(edge(g, j, 'file:gremion-public/src/gen.js', 'runs')).toBeTruthy()
    // the directory of the step wins over the repo root
    expect(edge(g, j, 'file:gremion-ui/scripts/both.mjs', 'runs')).toBeTruthy()
    expect(edge(g, j, 'file:scripts/both.mjs', 'runs')).toBeFalsy()
    // no such file in the directory of the step: the repo root
    expect(edge(g, j, 'file:scripts/rootonly.mjs', 'runs')).toBeTruthy()
    // a directory of another step of the job is not tried
    expect(edge(g, j, 'file:gremion-public/src/other.js', 'runs')).toBeFalsy()
  })

  it('works on the app area by working-directory: L4 before L5; and by a package name', () => {
    put('.github/workflows/w.yml', 'jobs:\n  j:\n    steps:\n      - run: pnpm run check\n        working-directory: apps/control-panel\n  k:\n    steps:\n      - run: pnpm --filter @fixture/public test\n')
    put('apps/control-panel/src/lib/server/s.ts', 'export function serve(): number {\n  return 1\n}\n')
    put('apps/control-panel/src/lib/c.ts', 'export function client(): number {\n  return 2\n}\n')
    put('gremion-public/package.json', JSON.stringify({ name: '@fixture/public' }))
    put('gremion-public/src/lib/c.ts', 'export function publicClient(): number {\n  return 2\n}\n')
    expect(extract(out, '--tree', '--commit', SHA).status).toBe(0)
    const g = read()
    expect(edge(g, 'job:.github/workflows/w.yml#j', 'area:apps/control-panel@L4', 'runs')).toBeTruthy()
    expect(edge(g, 'job:.github/workflows/w.yml#j', 'area:apps/control-panel@L5', 'runs')).toBeFalsy()
    // gremion-public has only an L5 area: the package name finds it
    expect(edge(g, 'job:.github/workflows/w.yml#k', 'area:gremion-public@L5', 'runs')).toBeTruthy()
  })

  it('tree mode and git mode give the same job nodes, edges and workflow areas', () => {
    fixture()
    expect(git('init', '-q').status).toBe(0)
    expect(git('add', '-A').status).toBe(0)
    expect(git('commit', '-q', '-m', 'fixture').status).toBe(0)
    const outGit = path.join(root, 'out-git', 'graph.json')
    const outTree = path.join(root, 'out-tree', 'graph.json')
    const rg = extract(outGit)
    expect(rg.status, rg.stderr).toBe(0)
    const rt = extract(outTree, '--tree', '--commit', SHA)
    expect(rt.status, rt.stderr).toBe(0)
    const pick = (g) => ({
      nodes: g.nodes.filter((n) => n.kind === 'job' || n.id.startsWith('area:github-actions/') || n.file?.startsWith('.github/workflows/') || n.id.startsWith('file:scripts/')),
      edges: g.edges.filter((e) => e.kind === 'needs' || e.kind === 'runs'),
    })
    const a = pick(read(outGit)), b = pick(read(outTree))
    expect(a.nodes.length).toBeGreaterThan(5)
    expect(a.edges.length).toBeGreaterThan(3)
    expect(b).toEqual(a)
  })
})
