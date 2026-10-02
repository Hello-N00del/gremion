#!/usr/bin/env node
/**
 * TASK-205 TDD 11 (TASK-200 residual (a)): the unit tests of the DISABLED modules' in-process halves.
 *
 * The interim overlay (interim-module-overlay.mjs) never copies a disabled module (modules/disabled.json:
 * content, finance, vault) into the build tree, so gremion-ui's own vitest project never collects their
 * `modules/<id>/app/**` tests, and no verify suite ran them either. This is the test-only lane: it builds a
 * SCRATCH copy of the app (gremion-ui/_module-lane: the tracked src, the config files, the unit setup file),
 * overlays the disabled modules' halves into it (the overlay's --include-disabled mode: a scratch target
 * only, never the real tree), and runs vitest's `unit` project there over exactly those modules' test files.
 * node_modules resolves from gremion-ui/ (the lane sits inside it); nothing of the lane is tracked
 * (gremion-ui/.gitignore) and the real tree is untouched.
 *
 *   node scripts/module-lane.mjs                      # every disabled module that has an app/ half
 *   node scripts/module-lane.mjs --modules content    # an explicit set
 *   node scripts/module-lane.mjs --list               # print the test files and exit (no run)
 *   node scripts/module-lane.mjs [--modules ...] -- <extra vitest args>   (e.g. --reporter=json --outputFile=...)
 *
 * It refuses an empty selection (no disabled module with a test) and exits with vitest's own code, so a lane
 * that collected nothing cannot pass (vitest exits 1 on "No test files found"). Integration and browser
 * tests need a database or Chromium and are not part of this lane.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { DEFAULT_ROOT, discoverModules, runOverlay } from './interim-module-overlay.mjs'

const UI = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const LANE_DIR = join(UI, '_module-lane')
const COPY_FILES = ['package.json', 'svelte.config.js', 'vite.config.ts', 'tsconfig.json']

function walk(dir, out = []) {
  for (const name of readdirSync(dir).toSorted((a, b) => a.localeCompare(b))) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) walk(abs, out)
    else out.push(abs)
  }
  return out
}

/** The disabled modules that have an app/ half, optionally narrowed to `only`. */
export function laneModules(root = DEFAULT_ROOT, only) {
  const { withApp, disabled } = discoverModules(root)
  const ids = withApp.filter((id) => disabled.includes(id))
  return only && only.length > 0 ? ids.filter((id) => only.includes(id)) : ids
}

/** The unit-test files of a module's app/ half, as paths relative to the lane's src/ (vitest filters). */
export function laneTestFiles(root, ids) {
  const files = []
  for (const id of ids) {
    const appDir = join(root, 'modules', id, 'app')
    for (const abs of walk(appDir)) {
      const rel = relative(appDir, abs).split('\\').join('/')
      const top = rel.split('/')[0]
      if (top === 'migrations' || top === 'scripts') continue
      if (!/\.test\.[cm]?[jt]s$/.test(rel)) continue
      if (/\.integration\.test\./.test(rel) || /\.browser\.test\./.test(rel)) continue // need Postgres / Chromium
      files.push(`src/${rel}`)
    }
  }
  return files
}

/** Build the scratch app: tracked src + config files + the unit setup file, then the disabled halves overlaid. */
export function buildLane(root, ids) {
  rmSync(LANE_DIR, { recursive: true, force: true })
  mkdirSync(LANE_DIR, { recursive: true })
  for (const f of COPY_FILES) cpSync(join(UI, f), join(LANE_DIR, f))
  cpSync(join(UI, 'src'), join(LANE_DIR, 'src'), { recursive: true })
  if (existsSync(join(UI, 'static'))) cpSync(join(UI, 'static'), join(LANE_DIR, 'static'), { recursive: true })
  mkdirSync(join(LANE_DIR, 'tests', 'unit'), { recursive: true })
  cpSync(join(UI, 'tests', 'unit', 'setup.ts'), join(LANE_DIR, 'tests', 'unit', 'setup.ts'))
  // the lane's copy of src already holds the ENABLED halves (the overlay ran before); the lane adds the disabled
  // ones. The overlay refuses a destination that exists and is not its own output, so a clash is loud.
  return runOverlay({ root, target: LANE_DIR, modules: ids, includeDisabled: true })
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  const argv = process.argv.slice(2)
  const sep = argv.indexOf('--')
  const own = sep === -1 ? argv : argv.slice(0, sep)
  const extra = sep === -1 ? [] : argv.slice(sep + 1)
  let values
  try {
    ;({ values } = parseArgs({ args: own, options: { modules: { type: 'string' }, list: { type: 'boolean' } }, strict: true, allowPositionals: false }))
  } catch (err) {
    console.error(`[module-lane] bad arguments - ${err.message}`)
    process.exit(2)
  }
  const only = values.modules ? values.modules.split(',').map((s) => s.trim()).filter(Boolean) : undefined
  const ids = laneModules(DEFAULT_ROOT, only)
  const files = laneTestFiles(DEFAULT_ROOT, ids)
  if (ids.length === 0 || files.length === 0) {
    console.error(`[module-lane] refused: no disabled module with an app/ unit test${only ? ` among ${only.join(', ')}` : ''} - a lane over nothing must not pass`)
    process.exit(1)
  }
  if (values.list) {
    console.info(`[module-lane] ${ids.join(', ')}: ${files.length} unit test file(s)\n${files.join('\n')}`)
    process.exit(0)
  }
  const r = buildLane(DEFAULT_ROOT, ids)
  console.info(`[module-lane] ${r.modules.join(', ')}: ${r.files.length} files overlaid into ${relative(UI, LANE_DIR)}, ${files.length} unit test file(s)`)
  // SvelteKit's vite plugin pins the project root to the process cwd, so vitest runs INSIDE the lane (not
  // `--root`); vitest itself resolves from gremion-ui/node_modules.
  const vitest = join(UI, 'node_modules', 'vitest', 'vitest.mjs')
  const res = spawnSync(process.execPath, [vitest, 'run', '--project', 'unit', ...extra, ...files], { cwd: LANE_DIR, stdio: 'inherit' })
  process.exit(res.status ?? 1)
}
