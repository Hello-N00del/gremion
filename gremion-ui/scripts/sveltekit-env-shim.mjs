// gremion-ui/scripts/sveltekit-env-shim.mjs
//
// Node ESM resolve/load hook that maps SvelteKit's virtual modules
// `$env/dynamic/private` and `$env/dynamic/public` to a thin
// `{ env: process.env }` shim, so finance server modules can be
// reached outside SvelteKit (e.g. by `pnpm migration:diff`).
//
// Semantically identical to SvelteKit's dynamic-env runtime — the
// dynamic envs *are* a thin wrapper around process.env at first read.
//
// Note: these hooks are *synchronous* so they can be registered with
// `module.registerHooks()` (Node 22.15+ / 24+) instead of the older,
// now-deprecated `module.register()` worker-thread loader. The
// implementation never awaited anything anyway.

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PRIVATE_URL = 'sveltekit-env-shim:$env/dynamic/private'
const PUBLIC_URL  = 'sveltekit-env-shim:$env/dynamic/public'

// SvelteKit's `$lib` alias → gremion-ui/src/lib. tsx does not apply tsconfig
// `paths`, so a CLI entrypoint (e.g. `pnpm migrate`) that imports db.ts — which
// now pulls `$lib/server/...` after the Pillar-2 tenant work (tenant/context,
// db/pool-registry, config, modules/registry, module-migrations) — fails to
// resolve `$lib` without this. We resolve to the concrete .ts/.js (or index)
// file so tsx's load hook transpiles it; bare `$lib` maps to the directory.
const LIB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib')

function resolveLibUrl(rest) {
  const base = path.join(LIB_ROOT, rest)
  const candidates = rest
    ? [`${base}.ts`, `${base}.js`, path.join(base, 'index.ts'), path.join(base, 'index.js'), base]
    : [base]
  for (const c of candidates) {
    if (existsSync(c)) return pathToFileURL(c).href
  }
  return pathToFileURL(base).href // fall through; let the next hook error clearly
}

export function resolve(specifier, context, nextResolve) {
  if (specifier === '$env/dynamic/private') {
    return { url: PRIVATE_URL, shortCircuit: true }
  }
  if (specifier === '$env/dynamic/public') {
    return { url: PUBLIC_URL, shortCircuit: true }
  }
  if (specifier === '$lib' || specifier.startsWith('$lib/')) {
    const rest = specifier === '$lib' ? '' : specifier.slice('$lib/'.length)
    return nextResolve(resolveLibUrl(rest), context)
  }
  return nextResolve(specifier, context)
}

export function load(url, context, nextLoad) {
  if (url === PRIVATE_URL || url === PUBLIC_URL) {
    return {
      format: 'module',
      source: 'export const env = process.env;\n',
      shortCircuit: true
    }
  }
  return nextLoad(url, context)
}
