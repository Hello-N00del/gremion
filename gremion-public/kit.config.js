// gremion-public/kit.config.js
import { createRequire } from 'node:module';
import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// Design handover v12 (apex topology) — the portal is mounted under a
// build-time-configurable base path.
//
//   BASE_PATH unset (DEFAULT) → portal served at `/`
//     The kernel default, and unchanged behaviour: clone + `docker compose up`
//     puts the portal at the root of whatever host the operator points at it.
//   BASE_PATH=/portal         → portal served at `/portal`
//     For a deployment that fans ONE origin out into landing (`/`), portal
//     (`/portal`), Keycloak (`/auth`) and the app — the apex topology this
//     portal is built for. The kernel only ships the capability; where the
//     portal is mounted is an instance decision.
//
// `paths.base` is baked in at BUILD time (SvelteKit inlines it into the client
// bundle), so this is a build arg, never a runtime env var — see the matching
// `ARG BASE_PATH` in this app's Dockerfile. Every internal link in src/ routes
// through `base` from `$lib/base` (see that module's header comment for why
// it is no longer `$app/paths`); nothing may hardcode a leading-slash
// absolute path (guarded by src/lib/test/base-path.test.ts).
//
// TASK-032 (TRD-410 [D R20-D5]): kit's `paths.base` type narrowed to
// `'' | `/${string}`` — validate rather than blindly cast an arbitrary env
// string into it, so a malformed BASE_PATH (missing leading slash) fails the
// build loudly instead of silently mounting the portal somewhere unintended.
const rawBase = process.env.BASE_PATH ?? '';
if (rawBase !== '' && !rawBase.startsWith('/')) {
  throw new Error(`BASE_PATH must be empty or start with '/', got '${rawBase}'`);
}
/** @type {'' | `/${string}`} */
const base = /** @type {any} */ (rawBase);

/** The validated build-time base path, shared with vite.config.ts's `define`. */
export const basePath = base;

// TASK-032 (TRD-410 [D R20-D5], Q4): kit 3 requires Svelte(Kit) config to be
// passed through the `sveltekit(...)` Vite plugin call rather than
// auto-discovered — `svelte-kit sync` warns "svelte.config.js is no longer
// used" if nothing imports it. vite.config.ts therefore calls
// `createKitConfig()` and passes the result into `sveltekit()`.
// The shape is also flattened: kit 3's `Config` type puts
// `adapter`/`alias`/`paths`/`version` at the top level instead of nested under
// a `kit:` key. Same mechanics as gremion-ui/kit.config.js.
const require = createRequire(import.meta.url);

// Q4: the stamp is public on this anonymous portal, so it carries the kit
// MAJOR and a 7-char commit sha only: no full version, no environment data.
const SHORT_SHA = /^[0-9a-f]{7}$/;

/**
 * The build-version stamp `kit<major>+civitas.<sha>` (see
 * gremion-ui/kit.config.js). A build without a valid `BUILD_SHA` FAILS; it
 * never falls back to a timestamp.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function versionName(env) {
  const sha = env.BUILD_SHA;
  if (!sha) {
    throw new Error(
      'BUILD_SHA is required to compute the SvelteKit build-version stamp (kit3+civitas.<sha>) — set it as a build ARG, never fall back to a timestamp'
    );
  }
  if (!SHORT_SHA.test(sha)) {
    throw new Error('BUILD_SHA must be exactly 7 lowercase hex characters (git rev-parse --short=7 HEAD)');
  }
  const kitMajor = require('@sveltejs/kit/package.json').version.split('.')[0];
  return `kit${kitMajor}+civitas.${sha}`;
}

/**
 * The SvelteKit config. It stamps `version.name` when BUILD_SHA is set (and
 * rejects a malformed one), and otherwise loads WITHOUT a stamp, because
 * `svelte-kit sync` (pnpm check), vitest and `vite dev` all resolve it and
 * sync even resolves it as command `build`. `buildStampGuard` enforces "no
 * BUILD_SHA, no build" for a real `vite build` only.
 *
 * @param {{ env?: Record<string, string | undefined> }} [options]
 * @returns {import('@sveltejs/kit/vite').Config}
 */
export function createKitConfig({ env = process.env } = {}) {
  // TASK-032 (TRD-410 [D R20-D5]): kit 3 moved the `Config` type from the
  // main '@sveltejs/kit' entry into '@sveltejs/kit/vite'.
  /** @type {import('@sveltejs/kit/vite').Config} */
  const config = {
    preprocess: vitePreprocess(),
    // TASK-032 (TRD-410 [D R20-D5]): adapter-node 6's AdapterOptions dropped
    // `port` (the type is gone in 6.0.0-next.13's ambient .d.ts). No
    // behavior change: the built server's own runtime default is already
    // `env('PORT', '3000')` (src/index.js), so `{ port: 3000 }` was setting a
    // build-time value identical to the existing runtime default.
    adapter: adapter(),
    paths: { base },
    // kit 3 removes the automatic `$lib` alias in favour of `#lib` (upstream
    // CHANGELOG.md, 3.0.0-next.9: "replace the `$lib` alias with `#lib` and
    // remove `files.lib` config"), but `alias` itself is only DEPRECATED, not
    // removed (3.0.0-next.17/24: "deprecate the `alias` option") — it still
    // works and still feeds svelte-kit's generated tsconfig path mapping, so
    // this reinstates `$lib` explicitly rather than rewriting every `$lib`
    // import to `#lib`. Matches gremion-ui/kit.config.js.
    alias: {
      $lib: 'src/lib',
    },
  };
  if (env.BUILD_SHA !== undefined) {
    config.version = { name: versionName(env) };
  }
  return config;
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
      versionName(env);
    },
  };
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
  if (command !== 'serve' || isTest) return [];
  /** @type {string[]} */
  const applied = [];
  for (const [key, value] of Object.entries(fileEnv)) {
    if (target[key] === undefined) {
      target[key] = value;
      applied.push(key);
    }
  }
  return applied;
}
