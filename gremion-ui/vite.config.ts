import { sveltekit } from '@sveltejs/kit/vite'
import { svelteTesting } from '@testing-library/svelte/vite'
import tailwindcss from '@tailwindcss/vite'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  // svelteTesting() resolves Svelte's browser build + DOM cleanup for
  // @testing-library/svelte component tests; VITEST-gated, so prod/dev unaffected.
  // tailwindcss() replaces the old postcss.config.js (@tailwindcss/postcss)
  // wiring — vite 8's rolldown-based CSS resolver mis-resolves the bare
  // `@import 'tailwindcss'` specifier as a filesystem path during `vite build`
  // (ENOENT opening a literal "tailwindcss" file), a known rolldown-vite/
  // postcss-import interaction. The official fix is Tailwind's own Vite
  // plugin, which bypasses postcss's import resolution entirely.
  plugins: [tailwindcss(), sveltekit(), svelteTesting()],
  server: {
    // #260: default to loopback so `pnpm dev` does NOT expose the dev server
    // (source via /@fs, HMR websocket) to the LAN of the operator box that also
    // also runs a deployment of this stack. Opt INTO LAN exposure explicitly by
    // setting VITE_DEV_HOST=0.0.0.0 (or `vite dev --host`) — e.g. only when
    // testing from a physical device. The Android emulator reaches the host via
    // 10.0.2.2 on loopback already, so it does not need 0.0.0.0.
    host: process.env.VITE_DEV_HOST || 'localhost',
    port: 4001,
    strictPort: true
  },
  ssr: {
    noExternal: ['@gremion/db', '@gremion/ports']
  },
  test: {
    // `packages/db` and `packages/ports` have no own vitest config in this run;
    // their dependency-free unit specs (e.g. client.test.ts, broker.test.ts) run
    // through gremion-ui's vitest, which noExternals both. The relative globs reach
    // them without a second config. (@gremion/ports DOES carry a standalone
    // vitest.config.ts for `pnpm -C packages/ports test`; this glob is the
    // monolith's collection path so test:unit keeps the port specs after the move.)
    // `scripts/install-git-hooks.test.ts` is listed EXPLICITLY: the pre-commit
    // hook guard lives beside the script it guards, outside src/. Without this
    // entry the suite is never collected and the gate that runs it passes
    // vacuously — the same shape of failure the guard itself is about.
    include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts', 'scripts/install-git-hooks.test.ts', '../packages/db/src/**/*.test.ts', '../packages/ports/src/**/*.test.ts'],
    // *.integration.test.ts files need a real Postgres — they run separately
    // via `pnpm test:integration` (see vitest.integration.config.ts).
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
    globals: true,
    environment: 'jsdom',
    setupFiles: ['tests/unit/setup.ts'],
    fileParallelism: false
  }
})
