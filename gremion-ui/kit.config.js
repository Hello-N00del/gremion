// gremion-ui/kit.config.js
import { createRequire } from 'node:module'
import adapter from '@sveltejs/adapter-node'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

// TASK-032 (TRD-410 [D R20-D5], Q4): kit 3 requires Svelte(Kit) config to be
// passed through the `sveltekit(...)` Vite plugin call rather than
// auto-discovered — `svelte-kit sync` warns "svelte.config.js is no longer
// used" if nothing imports it (upstream CHANGELOG.md, "breaking: require
// Svelte config options to be passed through the Vite plugin"). vite.config.ts
// therefore calls `createKitConfig()` and passes the result into
// `sveltekit()`. The shape is also flattened: kit 3's `Config` type puts
// `adapter`/`alias`/`version` etc. at the top level instead of under `kit:`.
const require = createRequire(import.meta.url)

// Q4: the stamp is public on the anonymous portal, so it carries the kit
// MAJOR and a 7-char commit sha only: no full version, no environment data.
const SHORT_SHA = /^[0-9a-f]{7}$/

/**
 * The build-version stamp `kit<major>+civitas.<sha>`, asserted by
 * scripts/build-stamp.test.mjs and by the brief's falsifying check
 * (`GET <base>/_app/version.json` names kit major 3 and the kernel commit).
 * `BUILD_SHA` is a Docker `ARG` (see Dockerfile). Throws when it is missing or
 * not a 7-char lowercase hex sha: a build never falls back to a timestamp,
 * because a silent fallback would make the stamp claim a commit it was not
 * built from.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function versionName(env) {
  const sha = env.BUILD_SHA
  if (!sha) {
    throw new Error(
      'BUILD_SHA is required to compute the SvelteKit build-version stamp (kit3+civitas.<sha>) — set it as a build ARG, never fall back to a timestamp'
    )
  }
  if (!SHORT_SHA.test(sha)) {
    throw new Error('BUILD_SHA must be exactly 7 lowercase hex characters (git rev-parse --short=7 HEAD)')
  }
  const kitMajor = require('@sveltejs/kit/package.json').version.split('.')[0]
  return `kit${kitMajor}+civitas.${sha}`
}

/**
 * The SvelteKit config. It stamps `version.name` when BUILD_SHA is set (and
 * rejects a malformed one), and otherwise loads WITHOUT a stamp. Loading must
 * not require BUILD_SHA: `svelte-kit sync` (pnpm check), vitest and `vite dev`
 * all resolve this config, and sync even resolves it as command `build`. The
 * "no BUILD_SHA, no build" rule is enforced by `buildStampGuard` instead,
 * which fails only a real `vite build`.
 *
 * @param {{ env?: Record<string, string | undefined> }} [options]
 * @returns {import('@sveltejs/kit/vite').Config}
 */
export function createKitConfig({ env = process.env } = {}) {
  // TASK-032 (TRD-410 [D R20-D5]): kit 3 moved the `Config` type from the main
  // '@sveltejs/kit' entry into '@sveltejs/kit/vite' (it now extends
  // VitePluginSvelteOptions, matching this object being passed straight into
  // the `sveltekit(...)` Vite plugin call).
  /** @type {import('@sveltejs/kit/vite').Config} */
  const config = {
    preprocess: vitePreprocess(),
    adapter: adapter(),
    alias: {
      $lib: 'src/lib'
    }
  }
  if (env.BUILD_SHA !== undefined) {
    config.version = { name: versionName(env) }
  }
  return config
}

/**
 * A build-only Vite plugin that fails `vite build` without a valid BUILD_SHA.
 * `apply: 'build'` keeps it out of dev/vitest; `buildStart` runs only when
 * Rollup actually builds, never while a tool merely resolves the config.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ name: string, apply: 'build', buildStart: () => void }}
 */
export function buildStampGuard(env = process.env) {
  return {
    name: 'gremion:build-stamp-guard',
    apply: 'build',
    buildStart() {
      versionName(env)
    }
  }
}

/**
 * TASK-032 (deletion-aware, dev parity): under kit 2, `vite dev` exposed the
 * app's .env / .env.local / .env.[mode] values through $env/dynamic/private
 * (`make dev-configure` writes gremion-ui/.env.local). The code now reads
 * process.env, which never sees those files, so vite.config.ts hands Vite's
 * loadEnv() result here for the dev server. Only UNSET keys are filled (the
 * process env wins, as it did in kit), only for `serve`, and never under
 * vitest, so tests stay hermetic. A built (adapter-node) server is untouched:
 * it reads the real process env at runtime, exactly as before.
 *
 * @param {{ command: string, isTest: boolean, fileEnv: Record<string, string>, target?: Record<string, string | undefined> }} options
 * @returns {string[]} the keys that were filled
 */
export function applyDevEnvFiles({ command, isTest, fileEnv, target = process.env }) {
  if (command !== 'serve' || isTest) return []
  /** @type {string[]} */
  const applied = []
  for (const [key, value] of Object.entries(fileEnv)) {
    if (target[key] === undefined) {
      target[key] = value
      applied.push(key)
    }
  }
  return applied
}
