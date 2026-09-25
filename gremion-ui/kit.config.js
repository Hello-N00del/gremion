import { createRequire } from 'node:module'
import adapter from '@sveltejs/adapter-node'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

// TASK-032 (TRD-410 [D R20-D5], Q4): kit 3 requires Svelte(Kit) config to be
// passed through the `sveltekit(...)` Vite plugin call rather than
// auto-discovered — `svelte-kit sync` now warns "svelte.config.js is no
// longer used" if nothing imports it (upstream CHANGELOG.md, "breaking:
// require Svelte config options to be passed through the Vite plugin"). This
// module still exists (and still exports the config object svelte-check
// reads for `preprocess`), but vite.config.ts now imports it and passes it
// into `sveltekit()` explicitly. The shape itself is also flattened: kit 3's
// `Config` type puts `adapter`/`alias`/`version` etc. at the top level
// instead of nested under a `kit:` key.
const require = createRequire(import.meta.url)

// The build-stamp version name, asserted by the guard/build-stamp test and by
// the falsifying check in the brief's acceptance (`GET <base>/_app/version.json`
// must name kit major 3 and the kernel commit). `BUILD_SHA` is a Docker `ARG`
// (see Dockerfile); with no `BUILD_SHA` the build FAILS — it never falls back
// to a timestamp, because a silent fallback would make the stamp claim a
// commit it was not actually built from.
function versionName() {
  const sha = process.env.BUILD_SHA
  if (!sha) {
    throw new Error(
      'BUILD_SHA is required to compute the SvelteKit build-version stamp (kit3+civitas.<sha>) — set it as a build ARG, never fall back to a timestamp'
    )
  }
  const kitMajor = require('@sveltejs/kit/package.json').version.split('.')[0]
  return `kit${kitMajor}+civitas.${sha}`
}

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
  },
  version: {
    name: versionName()
  }
}

export default config
