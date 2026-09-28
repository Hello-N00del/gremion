#!/usr/bin/env node
// Module migration basenames — TASK-200 (L5-27), Q8.
//
// The kernel's data-plane chain (gremion-ui/migrations/*.sql) wins: no module
// may carry a migration whose BASENAME equals a kernel one, in any
// modules/**/migrations/ directory — the leaf chains and the app chains
// (modules/<id>/app/migrations/) alike. The runner records applied migrations
// by filename, so a module file named like a kernel file is either skipped as
// "already applied" or applied under the kernel's name — silently either way.
// (The runner skipping a recorded filename before re-checking its hash is its
// own defect, routed to TASK-020/021; this guard only keeps names apart.)
//
// Numbers too: no number twice in one chain, and an app chain — which runs in
// the kernel database — never reuses a kernel number (leaf chains have their
// own databases).
//
// Refuses zero kernel files and zero module files: an empty side proves nothing.
//
// Run:  node scripts/check-module-migration-names.mjs
// Test: node --test scripts/check-module-migration-names.test.mjs

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const KERNEL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const KERNEL_MIGRATIONS = 'gremion-ui/migrations'
const SKIP_DIRS = new Set(['node_modules', 'dist', '.svelte-kit', 'coverage'])

function walkMigrationDirs(root, rel, out) {
  const abs = join(root, rel)
  for (const name of readdirSync(abs).sort()) {
    const r = `${rel}/${name}`
    if (!statSync(join(root, r)).isDirectory() || SKIP_DIRS.has(name)) continue
    if (name === 'migrations') out.push(r)
    walkMigrationDirs(root, r, out)
  }
  return out
}

/** @returns {{ kernel: string[], modules: {path: string, base: string}[] }} */
export function collectMigrationNames(root) {
  const kdir = join(root, KERNEL_MIGRATIONS)
  const kernel = existsSync(kdir) ? readdirSync(kdir).filter((f) => f.endsWith('.sql')) : []
  const modules = []
  if (existsSync(join(root, 'modules')))
    for (const dir of walkMigrationDirs(root, 'modules', []))
      for (const f of readdirSync(join(root, dir)).sort())
        if (f.endsWith('.sql') && statSync(join(root, dir, f)).isFile()) modules.push({ path: `${dir}/${f}`, base: f })
  return { kernel, modules }
}

export function checkMigrationNames(root) {
  const { kernel, modules } = collectMigrationNames(root)
  const problems = []
  if (kernel.length === 0) problems.push(`zero kernel migrations under ${KERNEL_MIGRATIONS}/ — the name check would pass vacuously`)
  if (modules.length === 0) problems.push('zero module migrations under modules/**/migrations/ — the name check would pass vacuously')
  const k = new Set(kernel)
  for (const m of modules)
    if (k.has(m.base))
      problems.push(`${m.path} has the basename of kernel ${KERNEL_MIGRATIONS}/${m.base} — the kernel file wins; rename the module migration into its own block`)
  // Numbers. Every chain: no number twice. App chains (modules/<id>/app/migrations)
  // run in the KERNEL database, so their numbers must also stay clear of the
  // kernel's; leaf chains run against their own databases and may reuse 001...
  const num = (f) => {
    const m = /^(\d+)_/.exec(f)
    return m ? Number(m[1]) : null
  }
  const kernelNums = new Map(kernel.filter((f) => num(f) !== null).map((f) => [num(f), f]))
  const byDir = new Map()
  const appNums = new Map()
  for (const m of modules) {
    const dir = m.path.slice(0, -m.base.length - 1)
    if (!byDir.has(dir)) byDir.set(dir, new Map())
    const n = num(m.base)
    if (n === null) {
      problems.push(`${m.path} carries no numeric prefix — the runner orders by filename, so its place in the chain is undefined`)
      continue
    }
    const seen = byDir.get(dir)
    if (seen.has(n)) problems.push(`${m.path} uses number ${n} twice in ${dir}/ (also ${seen.get(n)}) — the same number in one chain orders by the rest of the name, silently`)
    else seen.set(n, m.base)
    if (dir.endsWith('/app/migrations')) {
      if (kernelNums.has(n))
        problems.push(`${m.path} is an app chain (kernel database) file numbered ${n}, like kernel ${KERNEL_MIGRATIONS}/${kernelNums.get(n)} — take the next free number in the module's own block`)
      // every app chain lands in the same kernel database: numbers are shared across them
      if (appNums.has(n) && appNums.get(n).dir !== dir)
        problems.push(`${m.path} is an app chain file numbered ${n}, like ${appNums.get(n).path} in another app chain — both apply to the kernel database`)
      else if (!appNums.has(n)) appNums.set(n, { dir, path: m.path })
    }
  }
  return { problems, kernel: kernel.length, modules: modules.length, dirs: new Set(modules.map((m) => m.path.replace(/\/[^/]+$/, ''))).size }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const r = checkMigrationNames(KERNEL_ROOT)
  if (r.problems.length) {
    console.error(`[module-migration-names] ${r.problems.length} problem(s):`)
    for (const p of r.problems) console.error(`  x ${p}`)
    process.exit(1)
  }
  console.log(`[module-migration-names] OK — ${r.modules} module migration(s) in ${r.dirs} chain(s); none shares a basename with the ${r.kernel} kernel migrations, no chain reuses a number, and no app chain reuses a kernel or another app chain's number`)
}
