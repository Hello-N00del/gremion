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
 *
 * The lane is self-contained (TASK-205c): it does not read the real tree's overlay output. It copies the
 * tracked shell, drops whatever the real overlay wrote into the copy (gremion-ui/.module-overlay.json lists it),
 * overlays EVERY module that has an app/ half (the enabled ones a disabled half imports, e.g. publishing's
 * collabora-convert, and the disabled ones), and regenerates the manifest barrel so a disabled module's own
 * "is registered in MODULE_MANIFESTS" golden runs against a barrel that holds it. It runs the same on a clean
 * clone as after `pnpm run test:unit`.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { DEFAULT_ROOT, MANIFEST_NAME, discoverModules, runOverlay } from './interim-module-overlay.mjs'

const UI = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const LANE_DIR = join(UI, '_module-lane')
const COPY_FILES = ['package.json', 'svelte.config.js', 'vite.config.ts', 'tsconfig.json']

/**
 * Files a disabled half imports from a module the kernel does not carry yet. Each is written into the lane's
 * src only when no overlaid module provides the path, so the real file wins the day it lands and the stand-in
 * is then inert (module-lane.test.mjs pins "absent -> written, present -> untouched"). Test infrastructure,
 * never product code: the lane's tests mock these modules with a factory, but vite must still resolve the path.
 */
export const LANE_STAND_INS = Object.freeze({
  // vault's /vault page lists the handover tracks that reference an item; handover's half moves with TASK-205d.
  'src/lib/server/handover/handover-vault-links.ts': [
    '// lane stand-in (gremion-ui/scripts/module-lane.mjs): the handover half is not in the tree yet (TASK-205d)',
    'export async function handoverTracksReferencingVaultItems(_ids: readonly string[]): Promise<Map<string, string[]>> {',
    '  return new Map()',
    '}',
    '',
  ].join('\n'),
})

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

/** Repo-relative (posix) paths of the real tree's overlay output, from gremion-ui/.module-overlay.json. */
function realOverlayOutputs() {
  const manifest = join(UI, MANIFEST_NAME)
  if (!existsSync(manifest)) return new Set()
  try {
    return new Set(JSON.parse(readFileSync(manifest, 'utf8')).files ?? [])
  } catch {
    return new Set()
  }
}

/** Write the stand-ins whose path no overlaid module provided. Returns the paths written. */
export function writeStandIns(laneDir, standIns = LANE_STAND_INS) {
  const written = []
  for (const [rel, body] of Object.entries(standIns)) {
    const abs = join(laneDir, rel)
    if (existsSync(abs)) continue
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body)
    written.push(rel)
  }
  return written
}

/** Regenerate the manifest barrel inside the lane (a copy of the script resolves src/ beside itself). */
function regenerateManifestBarrel(laneDir) {
  mkdirSync(join(laneDir, 'scripts'), { recursive: true })
  cpSync(join(UI, 'scripts', 'build-module-manifest.mjs'), join(laneDir, 'scripts', 'build-module-manifest.mjs'))
  const res = spawnSync(process.execPath, [join(laneDir, 'scripts', 'build-module-manifest.mjs')], { cwd: laneDir, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`the lane's manifest barrel could not be generated: ${res.stderr || res.stdout}`)
}

/**
 * Build the scratch app: the tracked shell (the real tree's overlay output left out), every module's app/ half
 * overlaid (enabled and disabled: the lane is a scratch target), the manifest barrel regenerated over that
 * set, and the stand-ins for halves that are not in the tree yet.
 */
export function buildLane(root, _ids, laneDir = LANE_DIR) {
  rmSync(laneDir, { recursive: true, force: true })
  mkdirSync(laneDir, { recursive: true })
  for (const f of COPY_FILES) cpSync(join(UI, f), join(laneDir, f))
  const outputs = realOverlayOutputs()
  cpSync(join(UI, 'src'), join(laneDir, 'src'), {
    recursive: true,
    filter: (abs) => !outputs.has(relative(UI, abs).split('\\').join('/')),
  })
  if (existsSync(join(UI, 'static'))) cpSync(join(UI, 'static'), join(laneDir, 'static'), { recursive: true })
  mkdirSync(join(laneDir, 'tests', 'unit'), { recursive: true })
  cpSync(join(UI, 'tests', 'unit', 'setup.ts'), join(laneDir, 'tests', 'unit', 'setup.ts'))
  // no `modules`: every module with an app/ half, disabled ones included (the overlay's scratch-only mode).
  const overlaid = runOverlay({ root, target: laneDir, includeDisabled: true })
  regenerateManifestBarrel(laneDir)
  const standIns = writeStandIns(laneDir)
  return { ...overlaid, standIns }
}

/**
 * Build the lane, run vitest inside it, and ALWAYS remove it afterwards (verifier r1 MEDIUM): the lane is a full
 * copy of src (kernel shell + every overlaid module file), and a copy left behind under gremion-ui/ is read by
 * every tree scanner (`make lint`'s lint-tenant-db-access flagged 6 problems in _module-lane/src/lib/server/**)
 * and sent into the Docker build context. The lane must sit inside gremion-ui/ (node_modules resolves upward
 * from it), so it cannot live in an OS temp dir; removal in `finally` is the guarantee, and a lane a killed run
 * left behind is cleared by the next build's rmSync. `build`/`spawn` are injectable for the node test.
 * Returns vitest's exit status (1 when it reported none).
 */
export function runLane({ root = DEFAULT_ROOT, ids, files, extra = [], laneDir = LANE_DIR, build = buildLane, spawn = spawnSync, log = console.info }) {
  try {
    const r = build(root, ids, laneDir)
    log(`[module-lane] ${ids.join(', ')}: ${r.files.length} files of ${r.modules.join(', ')} overlaid into ${relative(UI, laneDir)}, ${files.length} unit test file(s)`)
    // SvelteKit's vite plugin pins the project root to the process cwd, so vitest runs INSIDE the lane (not
    // `--root`); vitest itself resolves from gremion-ui/node_modules.
    const vitest = join(UI, 'node_modules', 'vitest', 'vitest.mjs')
    const res = spawn(process.execPath, [vitest, 'run', '--project', 'unit', ...extra, ...files], { cwd: laneDir, stdio: 'inherit' })
    return res.status ?? 1
  } finally {
    rmSync(laneDir, { recursive: true, force: true })
  }
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
  // Ctrl-C reaches vitest (same process group) and ends the spawnSync; a no-op handler keeps THIS process alive
  // long enough for runLane's finally to remove the lane instead of dying on the default SIGINT/SIGTERM action.
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {})
  process.exit(runLane({ root: DEFAULT_ROOT, ids, files, extra }))
}
