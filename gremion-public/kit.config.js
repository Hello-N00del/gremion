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
// through `base` from `$app/paths`; nothing may hardcode a leading-slash
// absolute path (guarded by src/lib/test/base-path.test.ts).
const base = process.env.BASE_PATH ?? '';

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
  adapter: adapter({ port: 3000 }),
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
