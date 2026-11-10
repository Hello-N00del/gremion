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
