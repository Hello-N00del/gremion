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
    },
    // Nonce-based Content-Security-Policy for the app's own pages. In `auto` mode SvelteKit
    // stamps a per-response nonce on every inline <script> it injects (hydration, data) and
    // emits the matching `script-src 'self' 'nonce-...'` policy: as an HTTP header on
    // server-rendered pages, as a <meta> tag on prerendered ones. 'unsafe-inline' is therefore
    // absent from script-src, so the CSP contains an injected inline script. Template scripts
    // are not auto-nonced: the one in src/app.html carries %sveltekit.nonce% by hand.
    //
    //   - style-src keeps 'unsafe-inline' on purpose. Svelte scoped styles and utility classes
    //     emit inline style attributes, which nonces cannot cover.
    //   - connect-src stays broad (https:, wss:): the app talks to operator-configured
    //     messaging, files and call endpoints, so an allowlist here would couple the build to
    //     deployment config. Those endpoints enforce their own access.
    //   - frame-ancestors is NOT set here. A <meta> CSP ignores it, so a prerendered page would
    //     silently lose anti-framing. hooks.server.ts cspGuard sets it as a response header
    //     instead, which covers every render mode.
    //   - The running-system header checks anchor on `default-src 'self'; `. SvelteKit chooses
    //     the emission order itself (it puts default-src first); re-check after a SvelteKit upgrade.
    csp: {
      mode: 'auto',
      directives: {
        'default-src': ['self'],
        'script-src': ['self'],
        'style-src': ['self', 'unsafe-inline'],
        'img-src': ['self', 'data:', 'blob:', 'https:'],
        'font-src': ['self', 'data:'],
        'connect-src': ['self', 'https:', 'wss:'],
        'frame-src': ['self'],
        'base-uri': ['self'],
        'form-action': ['self'],
        'object-src': ['none']
      }
    }
  }
}

export default config
