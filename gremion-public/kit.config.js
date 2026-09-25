// gremion-public/svelte.config.js
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

// TASK-032 (TRD-410 [D R20-D5], Q4): kit 3 requires Svelte(Kit) config to be
// passed through the `sveltekit(...)` Vite plugin call rather than
// auto-discovered — `svelte-kit sync` now warns "svelte.config.js is no
// longer used" if nothing imports it. This module still exists (svelte-check
// still reads it for `preprocess`), but vite.config.ts now imports it and
// passes it into `sveltekit()` explicitly. The shape is also flattened: kit
// 3's `Config` type puts `adapter`/`alias`/`paths`/`version` at the top level
// instead of nested under a `kit:` key. Same mechanics as gremion-ui.
const require = createRequire(import.meta.url);

function versionName() {
  const sha = process.env.BUILD_SHA;
  if (!sha) {
    throw new Error(
      'BUILD_SHA is required to compute the SvelteKit build-version stamp (kit3+civitas.<sha>) — set it as a build ARG, never fall back to a timestamp'
    );
  }
  const kitMajor = require('@sveltejs/kit/package.json').version.split('.')[0];
  return `kit${kitMajor}+civitas.${sha}`;
}

// TASK-032 (TRD-410 [D R20-D5]): kit 3 moved the `Config` type from the main
// '@sveltejs/kit' entry into '@sveltejs/kit/vite'.
/** @type {import('@sveltejs/kit/vite').Config} */
const config = {
  preprocess: vitePreprocess(),
  // TASK-032 (TRD-410 [D R20-D5]): adapter-node 6's AdapterOptions dropped
  // `port` (upstream CHANGELOG.md has no explicit breaking-change line for
  // this, but the type is gone in 6.0.0-next.13's ambient .d.ts). No
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
  // this reinstates `$lib` explicitly rather than rewriting the ~1000 `$lib`
  // imports across this app's source tree to `#lib`. Matches
  // gremion-ui/svelte.config.js, which already declared this alias
  // explicitly before kit 3 needed it.
  alias: {
    $lib: 'src/lib',
  },
  version: {
    name: versionName(),
  },
};

export default config;
