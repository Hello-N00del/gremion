// Hygiene section (j) — j2, j3, j4 each watched RED on a seeded plant (TDD 8).
//
// The REAL scripts/kernel-hygiene-check.mjs runs against a throwaway copy of
// the tracked tree (working-tree bytes, `git add`ed into a fresh repository
// so the script's git calls see the same index), once unplanted and once per
// plant. The script is never given a switch to scan somewhere else: a guard
// with a "look elsewhere" knob is a guard that can be pointed at nothing.
//
// Every planted name is assembled from parts, so neither this file nor the
// repository ever contains the literal the guard hunts for, and the planted
// credential is an obvious fake with no token shape at all.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from './helpers.ts'

const CDN_TOKEN_VAR = ['CF', 'API', 'TOKEN'].join('_')
const EDGE_PLAN = ['edge', 'plan'].join('-')

const trees: string[] = []

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

function copyTree(): string {
  const dst = mkdtempSync(join(tmpdir(), 'hygiene-j-'))
  trees.push(dst)
  for (const rel of git(REPO_ROOT, ['ls-files', '-z']).split('\0').filter(Boolean)) {
    const src = join(REPO_ROOT, rel)
    if (!existsSync(src)) continue // deleted in the working tree
    mkdirSync(dirname(join(dst, rel)), { recursive: true })
    copyFileSync(src, join(dst, rel))
  }
  git(dst, ['init', '-q'])
  return dst
}

function runHygiene(tree: string): string[] {
  git(tree, ['add', '-A'])
  const r = spawnSync(process.execPath, ['scripts/kernel-hygiene-check.mjs'], { cwd: tree, encoding: 'utf8' })
  return `${r.stdout}\n${r.stderr}`.split('\n').filter((l) => /✗ j\d/.test(l))
}

function edit(tree: string, rel: string, from: string | RegExp, to: string): void {
  const p = join(tree, rel)
  const before = readFileSync(p, 'utf8')
  const after = before.replace(from, to)
  expect(after, `plant landed in ${rel}`).not.toBe(before)
  writeFileSync(p, after)
}

const ids = (lines: string[]) => [...new Set(lines.map((l) => /✗ (j\d)/.exec(l)![1]))].sort()

let clean: string[]
beforeAll(() => {
  clean = runHygiene(copyTree())
}, 120_000)
afterAll(() => {
  for (const t of trees) rmSync(t, { recursive: true, force: true })
})

describe('kernel hygiene (j) — TDD 8', () => {
  it('declares j2, j3 and j4, and no check bans Vaultwarden (B18 j1 is dropped: R8-4, TRD-263)', () => {
    const src = readFileSync(join(REPO_ROOT, 'scripts', 'kernel-hygiene-check.mjs'), 'utf8')
    for (const id of ['j2', 'j3', 'j4']) expect(src.split(`check('${id} `)).toHaveLength(2)
    // the kernel's own pre-existing j1 is the k8s sentinel check, not B18's j1
    expect(src).toMatch(/check\('j1 the k8s apex/)
    expect(src).not.toMatch(/check\('[a-z]\d+[^']*vaultwarden/i)
  })

  it('is GREEN on the unplanted tree (zero hits today)', () => {
    expect(clean).toEqual([])
  })

  it('j2 goes RED on a planted CDN API token variable in the kernel', () => {
    const t = copyTree()
    edit(t, 'infra/host/templates/env/app.env.tmpl', /$/, `\n${CDN_TOKEN_VAR}=obviously-fake-not-a-token\n`)
    const out = runHygiene(t)
    expect(ids(out)).toEqual(['j2'])
    expect(out.join('\n')).toContain('infra/host/templates/env/app.env.tmpl')
  }, 120_000)

  it('j3 goes RED on a planted planner carrier (a file of that name, and a reference to it)', () => {
    const t = copyTree()
    const dir = join(t, 'gremion-ui', 'src', 'lib', 'server', 'tenant', 'provisioner')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${EDGE_PLAN}.ts`), 'export const plan = 1\n')
    edit(t, 'packages/edge-routers/src/index.ts', /$/, `\n// see ../${EDGE_PLAN}\n`)
    const out = runHygiene(t)
    expect(ids(out)).toEqual(['j3'])
    expect(out.join('\n')).toContain(`${EDGE_PLAN}.ts`)
    expect(out.join('\n')).toContain('packages/edge-routers/src/index.ts')
  }, 120_000)

  it('j4 goes RED on a SECOND etc/edge mount', () => {
    const t = copyTree()
    edit(t, 'docker-compose.yml', '      - traefik-acme:/letsencrypt\n', '      - traefik-acme:/letsencrypt\n      - ${GREMION_ROOT}/etc/edge:/srv/edge-copy:ro\n')
    const out = runHygiene(t)
    expect(ids(out)).toEqual(['j4'])
    expect(out.join('\n')).toMatch(/2 mounts/)
  }, 120_000)

  it('j4 goes RED on a WRITABLE etc/edge mount', () => {
    const t = copyTree()
    edit(t, 'docker-compose.yml', /(source: \$\{GREMION_ROOT\}\/etc\/edge\n(?:.*\n){0,2}?\s*)read_only: true/, '$1read_only: false')
    const out = runHygiene(t)
    expect(ids(out)).toEqual(['j4'])
    expect(out.join('\n')).toMatch(/not read-only/)
  }, 120_000)

  it('j4 goes RED on an etc/edge mount held by a service other than traefik', () => {
    const t = copyTree()
    edit(t, 'docker-compose.yml', /(\n {2}gremion-public:\n)/, '$1    volumes:\n      - ${GREMION_ROOT}/etc/edge:/etc/traefik/dynamic:ro\n')
    const out = runHygiene(t)
    expect(ids(out)).toEqual(['j4'])
    expect(out.join('\n')).toMatch(/gremion-public/)
  }, 120_000)
})
