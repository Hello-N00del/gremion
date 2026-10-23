import adapter from '@sveltejs/adapter-node'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    alias: {
      $lib: 'src/lib'
    },
    // `relative: false` (R33d): asset URLs are emitted ABSOLUTE. The default (relative to the rendered URL)
    // breaks the "Modul nicht aktiv" document, which hooks.server.ts renders from /module-off/<id> but serves at
    // the disabled page's own URL (any depth): `../_app/...` would resolve against the wrong directory.
    paths: {
      relative: false
    }
  }
}

export default config
