// test/f1-defect/vitest.config.ts
//
// Ported from TASK-008's StuRaOS integration worktree
// (t009-int:test/f1-defect/vitest.config.ts) — TASK-009 k2, item 2. No path
// adaptation was needed: this repo's own layout puts test/f1-defect/ at the
// same relative depth from gremion-ui/ (both are direct siblings at repo
// root), so `gremionUiDir = path.resolve(here, '../../gremion-ui')` resolves
// correctly unchanged.
//
// A standalone vitest config for the fast in-repo TASK-009/F1 guards under
// test/f1-defect/guards/. gremion-ui's own vite.config.ts intentionally
// restricts `test.include` to `tests/unit/**` and `src/**`, and this task's
// rule (never modify anything outside test/f1-defect/) forbids widening
// that glob. The sveltekit() vite plugin is required so SvelteKit's virtual
// modules ($env/dynamic/private, $app/*, the $lib alias) resolve the same
// way they do for the real suite. A plain top-level
// `import { sveltekit } from '@sveltejs/kit/vite'` fails here: vite-node
// resolves a config file's own imports starting from the CONFIG FILE'S
// directory, which is two levels below gremion-ui, so Node's resolver hits
// the workspace ROOT's node_modules (a different, exports-incomplete copy)
// before it ever reaches gremion-ui's own correctly-linked copy — and
// `require.resolve` scoped to gremion-ui/package.json still fails on this
// particular subpath because @sveltejs/kit's "./vite" export is
// import-condition-only (no "require" condition), so a require-based
// resolve reports it as undefined even though `import` would find it.
// Reading gremion-ui's own installed package.json "exports" map by hand and
// importing the resolved file by its own absolute path sidesteps both
// problems — it is exactly the file gremion-ui's own
// `import { sveltekit } from '@sveltejs/kit/vite'` resolves to, just reached
// without relying on specifier-based resolution from the wrong directory.
//
// Run (from the kernel civitas repo root):
//   pnpm --dir gremion-ui exec vitest run --config ../test/f1-defect/vitest.config.ts
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = path.dirname(fileURLToPath(import.meta.url))
const gremionUiDir = path.resolve(here, '../../gremion-ui')

/** Resolve `pkg/subpath` against gremion-ui's OWN installed copy (never the
 *  workspace root's), by reading that package's package.json "exports" map
 *  directly, then import() the resulting absolute file path. */
function resolveFromGremionUi(specifier: string): string {
  const parts = specifier.split('/')
  const nameParts = specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)
  const pkgName = nameParts.join('/')
  const subpathParts = parts.slice(nameParts.length)
  const subpath = subpathParts.length === 0 ? '.' : `./${subpathParts.join('/')}`
  const pkgDir = path.join(gremionUiDir, 'node_modules', ...pkgName.split('/'))
  const pkgJson = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const entry = pkgJson.exports?.[subpath]
  const rel = typeof entry === 'string' ? entry : entry?.import ?? entry?.default ?? entry?.require
  if (!rel) throw new Error(`No resolvable export for "${specifier}" in ${pkgDir}`)
  return path.join(pkgDir, rel)
}

async function importFromGremionUi(specifier: string) {
  const parts = specifier.split('/')
  const nameParts = specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)
  const pkgName = nameParts.join('/')
  const subpathParts = parts.slice(nameParts.length)
  const subpath = subpathParts.length === 0 ? '.' : `./${subpathParts.join('/')}`
  const pkgDir = path.join(gremionUiDir, 'node_modules', ...pkgName.split('/'))
  const pkgJson = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const entry = pkgJson.exports?.[subpath]
  const rel = typeof entry === 'string' ? entry : entry?.import ?? entry?.default ?? entry?.require
  if (!rel) throw new Error(`No resolvable export for "${specifier}" in ${pkgDir}`)
  return import(pathToFileURL(path.join(pkgDir, rel)).href)
}

export default defineConfig(async () => {
  const { sveltekit } = await importFromGremionUi('@sveltejs/kit/vite')
  // TASK-032 (kit 3): the kit config is no longer auto-discovered, so a bare
  // sveltekit() runs without the `$lib` alias ("`$lib` has been removed").
  // Pass gremion-ui's own createKitConfig(), exactly as its vite.config.ts does;
  // imported by absolute path so its own imports resolve from gremion-ui/.
  const { createKitConfig } = await import(pathToFileURL(path.join(gremionUiDir, 'kit.config.js')).href)
  // Two of the guards under test/f1-defect/guards/ are Svelte COMPONENT
  // render tests (@testing-library/svelte): svelteTesting() resolves
  // Svelte's browser build + DOM cleanup, and the environment must be
  // jsdom (not 'node') for `render()` to have a document to mount into.
  const { svelteTesting } = await importFromGremionUi('@testing-library/svelte/vite')

  return {
    root: gremionUiDir,
    plugins: [sveltekit(createKitConfig()), svelteTesting()],
    resolve: {
      alias: {
        '@testing-library/svelte': resolveFromGremionUi('@testing-library/svelte'),
      }
    },
    ssr: {
      noExternal: ['@gremion/db', '@gremion/ports']
    },
    test: {
      include: ['../test/f1-defect/guards/**/*.test.ts'],
      globals: true,
      environment: 'jsdom',
      fileParallelism: false
    }
  }
})
