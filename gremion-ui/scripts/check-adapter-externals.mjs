// No shebang: invoked via `node ...` (matches the sibling check-*.mjs convention).
/**
 * TASK-032 (TRD-410 [D R20-D5]): adapter-node 6 externals guard.
 *
 * @sveltejs/adapter-node 6 (the kit-3 line) sets the SSR build's
 * `rolldownOptions.external` to every name in the app's `dependencies`
 * ("only production dependencies (and their deep imports) stay external",
 * adapter-node index.js). That overrides `ssr.noExternal`, so a package listed
 * there is left as a bare import in the server output and loaded by Node at
 * runtime (and by kit's "Analysing routes" step at build time). Two kinds of
 * package cannot survive that and must be devDependencies (bundled):
 *
 *  1. workspace packages (`workspace:` specifier): they ship TypeScript source
 *     with `.js` specifiers, so Node fails with ERR_MODULE_NOT_FOUND
 *     (`packages/db/src/types.js` imported from `packages/db/src/index.ts`).
 *  2. packages that peer on @sveltejs/kit (other than kit's own @sveltejs/*
 *     tooling): they import the `$app` / `$env` virtual modules, which exist
 *     only inside the Vite build (`Cannot find package '$env'`).
 *
 * Fails when it finds zero manifests, so it can never pass vacuously.
 * Exit: 0 = OK; 1 = one or more such packages in `dependencies`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const APPS = ['gremion-ui', 'gremion-public']

/**
 * @param {string} app
 * @param {Record<string, any>} manifest the app's package.json
 * @param {(name: string) => Record<string, any> | null} readDepManifest
 * @returns {string[]}
 */
export function checkManifest(app, manifest, readDepManifest) {
  /** @type {string[]} */
  const problems = []
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (String(spec).startsWith('workspace:')) {
      problems.push(
        `${app}: '${name}' (${spec}) is a workspace package in dependencies — adapter-node 6 leaves it external, and Node cannot load its TypeScript source; move it to devDependencies so it is bundled`
      )
      continue
    }
    if (name.startsWith('@sveltejs/')) continue
    const dep = readDepManifest(name)
    if (dep?.peerDependencies?.['@sveltejs/kit']) {
      problems.push(
        `${app}: '${name}' peers on @sveltejs/kit (imports $app/$env) but is in dependencies — adapter-node 6 leaves it external, where those virtual modules do not exist; move it to devDependencies so it is bundled`
      )
    }
  }
  return problems
}

/**
 * @param {string} root
 * @param {string} app
 * @returns {(name: string) => Record<string, any> | null}
 */
function depReader(root, app) {
  return (name) => {
    const file = join(root, app, 'node_modules', ...name.split('/'), 'package.json')
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  }
}

/**
 * @param {{ root?: string, apps?: string[] }} [options]
 * @returns {{ ok: boolean, problems: string[], checked: string[] }}
 */
export function runCheck({ root = REPO_ROOT, apps = APPS } = {}) {
  /** @type {string[]} */
  const problems = []
  /** @type {string[]} */
  const checked = []
  for (const app of apps) {
    const file = join(root, app, 'package.json')
    if (!existsSync(file)) {
      problems.push(`${app}: package.json not found`)
      continue
    }
    checked.push(app)
    problems.push(...checkManifest(app, JSON.parse(readFileSync(file, 'utf8')), depReader(root, app)))
  }
  if (checked.length === 0) problems.push('found zero app manifests — refusing to pass vacuously')
  return { ok: problems.length === 0, problems, checked }
}

// -- CLI ---------------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const result = runCheck()
  if (!result.ok) {
    console.error(`[adapter-externals] ${result.problems.length} problem(s):`)
    for (const p of result.problems) console.error(`  x ${p}`)
    process.exit(1)
  }
  console.log(`[adapter-externals] OK — no workspace or kit-coupled package in dependencies (${result.checked.join(', ')})`)
}
