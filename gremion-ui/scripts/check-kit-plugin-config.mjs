// No shebang: invoked via `node ...` (matches the sibling check-*.mjs convention).
/**
 * TASK-032 (TRD-410 [D R20-D5]): kit-3 plugin-config guard.
 *
 * Kit 3 requires the Svelte(Kit) config to be passed through the Vite plugin
 * (upstream CHANGELOG.md, "breaking: require Svelte config options to be
 * passed through the Vite plugin"). A Vite/vitest config that calls
 * `sveltekit()` with no argument therefore runs without the app's kit config:
 * the `$lib` alias is gone (vite:import-analysis "`$lib` has been removed"),
 * the adapter is unset and the build stamp is missing. Every such config must
 * pass `createKitConfig()` (from the app's kit.config.js) instead.
 *
 * Scans: the top-level vite*.config.* / vitest*.config.* files of gremion-ui
 * and gremion-public, and every vitest*.config.* under test/ (recursively).
 * It fails when it finds zero config files, so it can never pass vacuously.
 *
 * Exit: 0 = OK; 1 = one or more bare sveltekit() calls (each printed).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const APPS = ['gremion-ui', 'gremion-public']
const CONFIG_RE = /^vite(st)?(\.[\w-]+)*\.config\.(ts|js|mjs|mts)$/
const SKIP_DIRS = new Set(['node_modules', '.svelte-kit', 'build', '.proto-root'])
const BARE_CALL = /\bsveltekit\(\s*\)/g
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/

/**
 * Every bare `sveltekit()` call in one config file's text (comment lines skipped).
 *
 * @param {string} relPath
 * @param {string} text
 * @returns {string[]}
 */
export function checkConfigText(relPath, text) {
  /** @type {string[]} */
  const problems = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    if (COMMENT_LINE.test(line)) return
    BARE_CALL.lastIndex = 0
    while (BARE_CALL.exec(line) !== null) {
      problems.push(
        `${relPath}:${i + 1}: bare sveltekit() — kit 3 no longer auto-discovers the kit config, so $lib, the adapter and the build stamp are missing; pass createKitConfig() from the app's kit.config.js`
      )
    }
  })
  return problems
}

/**
 * @param {string} dir absolute
 * @param {string} rel repo-relative prefix
 * @param {string[]} out
 */
function walkTestDir(dir, rel, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walkTestDir(join(dir, entry.name), `${rel}/${entry.name}`, out)
    } else if (CONFIG_RE.test(entry.name)) {
      out.push(`${rel}/${entry.name}`)
    }
  }
}

/**
 * Repo-relative paths of every config file this guard owns.
 *
 * @param {string} [root]
 * @returns {string[]}
 */
export function collectConfigFiles(root = REPO_ROOT) {
  /** @type {string[]} */
  const out = []
  for (const app of APPS) {
    const dir = join(root, app)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && CONFIG_RE.test(entry.name)) out.push(`${app}/${entry.name}`)
    }
  }
  const testDir = join(root, 'test')
  if (existsSync(testDir)) walkTestDir(testDir, 'test', out)
  return out.sort()
}

/**
 * @param {{ files?: string[], root?: string }} [options]
 * @returns {{ ok: boolean, problems: string[], files: string[] }}
 */
export function runCheck({ files, root = REPO_ROOT } = {}) {
  const list = files ?? collectConfigFiles(root)
  if (list.length === 0) {
    return { ok: false, problems: ['found zero vite/vitest config files — refusing to pass vacuously'], files: list }
  }
  /** @type {string[]} */
  const problems = []
  for (const rel of list) problems.push(...checkConfigText(rel, readFileSync(join(root, rel), 'utf8')))
  return { ok: problems.length === 0, problems, files: list }
}

// -- CLI ---------------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const result = runCheck()
  if (!result.ok) {
    console.error(`[kit-plugin-config] ${result.problems.length} problem(s):`)
    for (const p of result.problems) console.error(`  x ${p}`)
    process.exit(1)
  }
  console.log(`[kit-plugin-config] OK — ${result.files.length} config file(s) pass their kit config into sveltekit()`)
}
