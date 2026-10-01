import adapter from '@sveltejs/adapter-node'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // adapter-node: the panel is one Node process (Dockerfile: `node build`).
    // SvelteKit's CSRF origin check stays at its default (on): a form POST
    // from any origin but ORIGIN -- the operator's browser behind `ssh -L` --
    // is answered 403.
    adapter: adapter({ out: 'build' }),
  },
}

export default config
