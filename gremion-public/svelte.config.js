// gremion-public/svelte.config.js
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

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ port: 3000 }),
    paths: { base },
  },
};

export default config;
