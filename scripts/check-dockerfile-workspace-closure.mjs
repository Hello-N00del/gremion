#!/usr/bin/env node
// Guard: a Dockerfile that builds a pnpm workspace package must COPY the whole
// @gremion/* dependency closure of what it builds -- manifest before the install,
// source after it.
//
// The defect this exists for (found live on the test host, 2026-10-29): TASK-033-a
// made packages/tenant-store depend on "@gremion/retention@workspace:*". Neither
// services/kernel-api/Dockerfile nor modules/board/Dockerfile COPYed packages/retention,
// so `pnpm --filter @gremion/kernel-api deploy` died with
// ERR_PNPM_WORKSPACE_PKG_NOT_FOUND inside the image build. check-module-dockerfile-copy
// could not see it: it only asks that each COPY source EXISTS, and only under modules/.
//
// Rule, for EVERY Dockerfile in the repository (build context = the repository root):
//   * Seeds are the workspace packages whose package.json a COPY source NAMES (the
//     manifest-first idiom: COPY packages/x/package.json, or a glob ending in
//     /package.json). A wholesale COPY of a parent directory (kernel-api's
//     `COPY modules ./modules/`, which ships module.json registry data) or of `.`
//     makes no package a seed: it brings manifests along, it does not build them. A
//     Dockerfile with no seed is not a workspace build and is left alone.
//   * The closure is the seeds plus every package reachable from them through
//     `workspace:` specs in dependencies, devDependencies, optionalDependencies and
//     peerDependencies.
//   * Each package in the closure needs its manifest covered AND its source covered; a
//     miss is reported naming the Dockerfile, the package and the chain that needs it.
//
// "Covered" is decided on the COPY sources alone, not on the stage they land in:
//   manifest  a source equal to, an ancestor of, or a glob matching <dir>/package.json
//   source    a source equal to, an ancestor of, or a glob matching <dir>, or a path
//             strictly inside <dir> that is not its package.json (COPY packages/x/bin ...)
// `COPY --from=<stage>`, URLs, heredocs and sources built from $VARIABLES are not paths
// in the build context and are skipped. Workspace packages come from pnpm-workspace.yaml.
// The guard refuses to pass when it finds zero workspace packages, zero Dockerfiles, or
// no workspace Dockerfile at all: a blind guard is a green light for nothing.
//
// Run:  node scripts/check-dockerfile-workspace-closure.mjs
// Test: node --test scripts/check-dockerfile-workspace-closure.test.mjs

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractDockerCopySources } from './check-module-source-scan.mjs'

export const KERNEL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const DOCKERFILE_RE = /(^|\/)(([^/]*\.)?Dockerfile(\.[^/]+)?|Containerfile(\.[^/]+)?)$/
const SKIP_DIRS = new Set(['node_modules', 'dist', '.svelte-kit', 'coverage', '.git', '.worktrees', 'build'])
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

/** Every Dockerfile / Containerfile under <root>, as repo-relative posix paths. */
export function findDockerfiles(root) {
  const out = []
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const p = rel ? posix.join(rel, e.name) : e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p)
      } else if (DOCKERFILE_RE.test(p)) out.push(p)
    }
  }
  walk('')
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** The `packages:` globs of pnpm-workspace.yaml. */
function workspaceGlobs(root) {
  const file = join(root, 'pnpm-workspace.yaml')
  if (!existsSync(file)) return []
  const globs = []
  let inPackages = false
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) inPackages = true
    else if (inPackages && /^\S/.test(line)) inPackages = false
    else if (inPackages) {
      const m = /^\s*-\s*['"]?([^'"#\s]+)['"]?/.exec(line)
      if (m) globs.push(m[1].replace(/\/+$/, ''))
    }
  }
  return globs
}

/**
 * Which workspace package a `workspace:` spec points at: the dependency key by default,
 * the aliased name in `workspace:<name>@<range>`, or the package at the directory in
 * `workspace:../<dir>`. Returns { name } or { dir } (an unresolved path).
 */
function workspaceTarget(key, spec, fromDir, byDir) {
  const rest = spec.slice('workspace:'.length)
  if (/^\.{1,2}(\/|$)/.test(rest)) {
    const dir = posix.normalize(posix.join(fromDir, rest)).replace(/\/+$/, '')
    return byDir.has(dir) ? { name: byDir.get(dir) } : { dir }
  }
  const alias = /^(@?[^@]+)@[^@]*$/.exec(rest)
  return { name: alias ? alias[1] : key }
}

/**
 * Workspace packages by name: { name, dir (repo-relative posix), deps: Map<name, spec>,
 * targets: string[] }. Only `workspace:` specs are kept as deps; `targets` are the workspace
 * package names they resolve to. A `workspace:` spec that resolves to no workspace package is
 * pushed onto `problems` (when given) instead of being skipped.
 */
export function loadWorkspace(root, problems = []) {
  const byName = new Map()
  const dirs = new Set()
  for (const g of workspaceGlobs(root)) {
    if (g.endsWith('/*')) {
      const parent = g.slice(0, -2)
      if (!existsSync(join(root, parent))) continue
      for (const e of readdirSync(join(root, parent), { withFileTypes: true }))
        if (e.isDirectory()) dirs.add(posix.join(parent, e.name))
    } else dirs.add(g)
  }
  for (const dir of [...dirs].sort()) {
    const file = join(root, dir, 'package.json')
    if (!existsSync(file)) continue
    let json
    try {
      json = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (typeof json.name !== 'string') continue
    const deps = new Map()
    for (const f of DEP_FIELDS)
      for (const [n, spec] of Object.entries(json[f] ?? {}))
        if (typeof spec === 'string' && spec.startsWith('workspace:')) deps.set(n, spec)
    byName.set(json.name, { name: json.name, dir, deps, targets: [] })
  }
  const byDir = new Map([...byName.values()].map((p) => [p.dir, p.name]))
  for (const p of byName.values())
    for (const [key, spec] of p.deps) {
      const t = workspaceTarget(key, spec, p.dir, byDir)
      if (t.name !== undefined && byName.has(t.name)) p.targets.push(t.name)
      else
        problems.push(
          `${p.dir}/package.json: ${p.name} depends on "${key}" via "${spec}" but no workspace package ${
            t.name !== undefined ? `is named ${t.name}` : `lives at ${t.dir}`
          } -- a dangling workspace: spec cannot install`,
        )
    }
  return byName
}

const segs = (p) =>
  p
    .replace(/^\.\//, '')
    .split('/')
    .filter((s) => s !== '' && s !== '.')
const segRe = (s) =>
  new RegExp('^' + s.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$')

/**
 * How a COPY source relates to a target path: 'covers' (the source is the target or an
 * ancestor of it), 'inside' (the source is strictly below the target) or null.
 */
export function relation(source, target) {
  const s = segs(source)
  const t = segs(target)
  const go = (i, j) => {
    if (i === s.length) return 'covers'
    if (j === t.length) return 'inside'
    if (s[i] === '**') return go(i + 1, j) ?? go(i, j + 1)
    return segRe(s[i]).test(t[j]) ? go(i + 1, j + 1) : null
  }
  return go(0, 0)
}

/** @returns {{problems: string[], dockerfiles: number, workspaceDockerfiles: number, packages: number}} */
export function checkWorkspaceClosure(root = KERNEL_ROOT) {
  const problems = []
  const ws = loadWorkspace(root, problems)
  const files = findDockerfiles(root)
  if (ws.size === 0) problems.push('no workspace package found via pnpm-workspace.yaml -- the guard has gone blind')
  if (files.length === 0) problems.push('no Dockerfile found in the repository -- the guard has gone blind')
  let workspaceDockerfiles = 0
  for (const f of ws.size === 0 ? [] : files) {
    const sources = extractDockerCopySources(readFileSync(join(root, f), 'utf8'))
      .map((c) => c.source)
      .filter((s) => !s.includes('$'))
    const manifest = (dir) => sources.some((s) => relation(s, `${dir}/package.json`) === 'covers')
    const code = (dir) =>
      sources.some((s) => {
        const r = relation(s, dir)
        return r === 'covers' || (r === 'inside' && posix.basename(s) !== 'package.json')
      })
    const named = (dir) => sources.some((s) => posix.basename(s) === 'package.json' && relation(s, `${dir}/package.json`) === 'covers')
    const seeds = [...ws.values()].filter((p) => named(p.dir))
    if (seeds.length === 0) continue
    workspaceDockerfiles++
    // Breadth-first over workspace: specs; `via` records the package that first reached each one.
    const via = new Map(seeds.map((p) => [p.name, null]))
    const queue = seeds.map((p) => p.name)
    for (let q = 0; q < queue.length; q++) {
      for (const dep of ws.get(queue[q]).targets) {
        if (via.has(dep)) continue
        via.set(dep, queue[q])
        queue.push(dep)
      }
    }
    for (const name of queue) {
      const p = ws.get(name)
      const chain = []
      for (let n = name; n !== null; n = via.get(n)) chain.unshift(n)
      const missing = [!manifest(p.dir) && 'manifest', !code(p.dir) && 'source'].filter(Boolean)
      for (const what of missing)
        problems.push(
          `${f}: ${name} (${p.dir}) is in the @gremion/* workspace closure (${chain.join(' -> ')}) but its ${what} is never COPYed` +
            ` -- add COPY ${what === 'manifest' ? `${p.dir}/package.json before the install` : `${p.dir} after it`}`,
        )
    }
  }
  if (files.length > 0 && ws.size > 0 && workspaceDockerfiles === 0)
    problems.push('no Dockerfile COPYs a workspace package manifest -- the guard has gone blind')
  return { problems, dockerfiles: files.length, workspaceDockerfiles, packages: ws.size }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = checkWorkspaceClosure()
  if (r.problems.length) {
    console.error(`[dockerfile-workspace-closure] ${r.problems.length} problem(s):`)
    for (const p of r.problems) console.error(`  x ${p}`)
    process.exit(1)
  }
  console.log(
    `[dockerfile-workspace-closure] ${r.workspaceDockerfiles} workspace Dockerfile(s) of ${r.dockerfiles}, ${r.packages} workspace package(s): every @gremion/* closure is COPYed`,
  )
}
