#!/usr/bin/env node
/**
 * TASK-205 Q1 — the interim static wiring of the module in-process halves.
 *
 * Each in-tree module keeps the in-process half of its product surface (routes, api routes,
 * lib/server, components, manifest, seeders) under modules/<id>/app/**, in the layout that
 * mirrors gremion-ui/src (modules/<id>/app/<rest> <-> gremion-ui/src/<rest>). SvelteKit only
 * routes what lives under its own src/, so until TASK-125 replaces this with TRD-411
 * composition, this script COPIES every enabled module's app/** onto gremion-ui/src/**. The
 * copies are gitignored build output: there is ONE source file (TRD-411 forbids a second copy
 * under version control), and a clean clone gets the overlay from `precheck`, `pretest:unit`,
 * `prebuild` and the Docker build, before the build-module-*.mjs barrels run.
 *
 *   node scripts/interim-module-overlay.mjs                       # overlay every enabled module
 *   node scripts/interim-module-overlay.mjs --migrations          # + app/migrations/*.sql -> gremion-ui/migrations (prebuild / Docker only)
 *   node scripts/interim-module-overlay.mjs --modules a,b         # an explicit set (a disabled id is refused)
 *   node scripts/interim-module-overlay.mjs --include-disabled --target <dir>
 *                                                                 # TEST-ONLY: also overlay disabled modules, into a
 *                                                                 # scratch dir that is not gremion-ui itself
 *
 * What it refuses (exit 1, nothing half-written is trusted: the manifest of planned outputs is
 * written first, so the next run knows which files are its own):
 *   - zero modules to overlay (an overlay of nothing would let a build pass without any module)
 *   - a disabled module in build mode (modules/disabled.json), and --include-disabled aimed at gremion-ui itself
 *   - a destination that exists and is not this script's own previous output (a tracked kernel file,
 *     or a file somebody wrote by hand) - and any destination git reports as tracked
 *   - two modules that map to the same destination
 *
 * It deliberately never reads svelte.config.js: SvelteKit 3 moves `kit.files`, and a plain file
 * copy keeps the overlay independent of it (R27-I5, K4).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_ROOT = resolve(HERE, '..', '..')
export const MANIFEST_NAME = '.module-overlay.json'
/** Directories directly under modules/<id>/app/ that are NOT overlaid onto src/. */
export const NON_SRC_DIRS = Object.freeze(['migrations', 'scripts'])

export class OverlayError extends Error {
  constructor(problems) {
    super(problems.join('\n'))
    this.name = 'OverlayError'
    this.problems = problems
  }
}

const posix = (p) => p.split(sep).join('/')

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).toSorted((a, b) => a.localeCompare(b))) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) walk(abs, base, out)
    else out.push(posix(relative(base, abs)))
  }
  return out
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new OverlayError([`${what} (${path}) is unreadable: ${err.message}`])
  }
}

/** Module ids that have an in-process half, and the disabled ids, from <root>/modules. */
export function discoverModules(root) {
  const modulesDir = join(root, 'modules')
  if (!existsSync(modulesDir)) throw new OverlayError([`${modulesDir} does not exist`])
  const withApp = readdirSync(modulesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(modulesDir, d.name, 'app')))
    .map((d) => d.name)
    .toSorted((a, b) => a.localeCompare(b))
  const disabledFile = join(modulesDir, 'disabled.json')
  const disabled = existsSync(disabledFile) ? (readJson(disabledFile, 'modules/disabled.json').disabled ?? []).map((e) => e.id) : []
  return { withApp, disabled }
}

/** Tracked paths (repo-relative) under `dirRel`; a Windows command line cannot carry ~800 pathspecs, so list the tree. */
function trackedUnder(root, dirRel) {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', dirRel], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    return new Set(out.split('\0').filter(Boolean))
  } catch {
    return new Set() // not a git checkout (the Docker build context): the manifest check below is the guard there
  }
}

/**
 * @param {object} opts
 * @param {string} [opts.root]            the repository root (default: this script's)
 * @param {string} [opts.target]          the gremion-ui directory to write into (default <root>/gremion-ui)
 * @param {string[]} [opts.modules]       an explicit module set
 * @param {boolean} [opts.includeDisabled] test-only: also overlay disabled modules (target must not be <root>/gremion-ui)
 * @param {boolean} [opts.migrations]     also copy app/migrations/*.sql into <target>/migrations
 */
export function runOverlay(opts = {}) {
  const root = resolve(opts.root ?? DEFAULT_ROOT)
  const realTarget = resolve(root, 'gremion-ui')
  const target = resolve(opts.target ?? realTarget)
  const problems = []
  const { withApp, disabled } = discoverModules(root)

  if (opts.includeDisabled && target === realTarget)
    throw new OverlayError(['--include-disabled is test-only: it needs a --target other than gremion-ui itself, so a disabled module never lands in the build tree'])

  let ids
  if (opts.modules && opts.modules.length > 0) {
    ids = [...new Set(opts.modules)].toSorted((a, b) => a.localeCompare(b))
    for (const id of ids) {
      if (!withApp.includes(id)) problems.push(`module ${id} has no modules/${id}/app/`)
      else if (disabled.includes(id) && !opts.includeDisabled) problems.push(`module ${id} is disabled (modules/disabled.json): build mode refuses it`)
    }
  } else {
    ids = withApp.filter((id) => opts.includeDisabled || !disabled.includes(id))
  }
  if (problems.length) throw new OverlayError(problems)
  if (ids.length === 0) throw new OverlayError(['no module to overlay: every modules/*/app is disabled or there is none - an overlay of nothing must not let a build pass'])

  // plan: destination (relative to target) -> { module, source (absolute) }
  const plan = new Map()
  for (const id of ids) {
    const appDir = join(root, 'modules', id, 'app')
    for (const rel of walk(appDir)) {
      const top = rel.split('/')[0]
      const isSql = opts.migrations && top === 'migrations' && rel.split('/').length === 2 && rel.endsWith('.sql')
      if (NON_SRC_DIRS.includes(top) && !isSql) continue
      const dest = isSql ? `migrations/${rel.slice('migrations/'.length)}` : `src/${rel}`
      const prior = plan.get(dest)
      if (prior) problems.push(`${dest}: both modules/${prior.module}/app and modules/${id}/app map to it`)
      else plan.set(dest, { module: id, source: join(appDir, rel) })
    }
  }

  const manifestPath = join(target, MANIFEST_NAME)
  const previous = new Set(existsSync(manifestPath) ? (readJson(manifestPath, MANIFEST_NAME).files ?? []) : [])

  // collisions: a destination that exists and is not our own previous output, or that git tracks
  const tracked = trackedUnder(root, posix(relative(root, target)) || '.')
  for (const dest of plan.keys()) {
    const abs = join(target, dest)
    const relRoot = posix(relative(root, abs))
    if (tracked.has(relRoot)) problems.push(`${relRoot}: a tracked file already sits at the overlay destination (modules/${plan.get(dest).module}/app owns it) - there must be one copy`)
    else if (existsSync(abs) && !previous.has(dest)) problems.push(`${relRoot}: exists and is not this overlay's own previous output (modules/${plan.get(dest).module}/app owns it) - remove it or the module file`)
  }
  if (problems.length) throw new OverlayError(problems)

  // the manifest first: a run interrupted mid-copy leaves files the next run recognises as its own
  mkdirSync(target, { recursive: true })
  writeFileSync(manifestPath, JSON.stringify({ modules: ids, files: [...plan.keys()].toSorted((a, b) => a.localeCompare(b)) }, null, 2) + '\n')

  // stale outputs (a module disabled or a file removed since the last run)
  const removed = []
  for (const old of previous) {
    if (plan.has(old)) continue
    const abs = join(target, old)
    if (existsSync(abs)) {
      rmSync(abs)
      removed.push(old)
      for (let d = dirname(abs); d.startsWith(target) && d !== target; d = dirname(d)) {
        try {
          rmdirSync(d) // only succeeds on an empty directory
        } catch {
          break
        }
      }
    }
  }

  let written = 0
  for (const [dest, { source }] of plan) {
    const abs = join(target, dest)
    const next = readFileSync(source)
    if (existsSync(abs) && readFileSync(abs).equals(next)) continue // keep mtimes: vite/vitest watchers see only real changes
    mkdirSync(dirname(abs), { recursive: true })
    copyFileSync(source, abs)
    written++
  }
  return { modules: ids, files: [...plan.keys()].toSorted((a, b) => a.localeCompare(b)), written, removed }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  let values
  try {
    ;({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        root: { type: 'string' },
        target: { type: 'string' },
        modules: { type: 'string' },
        migrations: { type: 'boolean' },
        'include-disabled': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }))
  } catch (err) {
    console.error(`[module-overlay] bad arguments - ${err.message}`)
    process.exit(2)
  }
  try {
    const r = runOverlay({
      root: values.root,
      target: values.target,
      modules: values.modules ? values.modules.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      includeDisabled: values['include-disabled'] === true,
      migrations: values.migrations === true,
    })
    console.info(`[module-overlay] ${r.modules.join(', ')}: ${r.files.length} files (${r.written} written, ${r.removed.length} stale removed)`)
  } catch (err) {
    if (!(err instanceof OverlayError)) throw err
    console.error(`[module-overlay] refused:\n  ${err.problems.join('\n  ')}`)
    process.exit(1)
  }
}
