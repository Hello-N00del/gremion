import { sveltekit } from '@sveltejs/kit/vite'
import { svelteTesting } from '@testing-library/svelte/vite'
import tailwindcss from '@tailwindcss/vite'
import { configDefaults, defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import { paraglideVitePlugin } from '@inlang/paraglide-js'
import paraglideOptions from './src/lib/i18n/paraglide-options.js'

// TASK-208: the responsive-shell component suite runs in real Chromium (Vitest
// browser mode, Playwright provider). CHROMIUM_EXECUTABLE_PATH points it at a
// preinstalled Chromium where Playwright's pinned build cannot be downloaded;
// unset, Playwright launches its own pinned browser.
// CHROMIUM_SHOW_SCROLLBARS=1 drops Playwright's default --hide-scrollbars, so
// the reflow checks also run with classic (layout-taking) scrollbars.
const chromiumLaunch = {
  ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
  ...(process.env.CHROMIUM_SHOW_SCROLLBARS === '1' ? { ignoreDefaultArgs: ['--hide-scrollbars'] } : {})
}
const BROWSER_TESTS = ['src/lib/components/**/*.browser.test.ts', 'src/routes/**/*.browser.test.ts']
const DSF2_BROWSER_TESTS = 'src/lib/components/layout/**/*.dsf2.browser.test.ts'

export default defineConfig({
  // svelteTesting() resolves Svelte's browser build + DOM cleanup for
  // @testing-library/svelte component tests; VITEST-gated, so prod/dev unaffected.
  // tailwindcss() replaces the old postcss.config.js (@tailwindcss/postcss)
  // wiring — vite 8's rolldown-based CSS resolver mis-resolves the bare
  // `@import 'tailwindcss'` specifier as a filesystem path during `vite build`
  // (ENOENT opening a literal "tailwindcss" file), a known rolldown-vite/
  // postcss-import interaction. The official fix is Tailwind's own Vite
  // plugin, which bypasses postcss's import resolution entirely.
  // TASK-062 (TRD-412): Paraglide compiles src/lib/i18n/messages into
  // src/lib/i18n/paraglide (generated, gitignored) on dev, build and vitest.
  plugins: [paraglideVitePlugin(paraglideOptions), tailwindcss(), sveltekit(), svelteTesting()],
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
    // TASK-077 G6: @gremion/tenancy-core ships TypeScript sources (exports ->
    // ./src/*.ts); bundled here, so the runtime image never loads a .ts file
    // from node_modules (Node refuses type stripping there).
    noExternal: ['@gremion/db', '@gremion/ports', '@gremion/storage', '@gremion/tenancy-core']
  },
  test: {
    // Three projects. `unit` is the historical jsdom run (`pnpm test:unit`);
    // `browser` and `browser-dsf2` are the real-Chromium responsive-shell suite
    // (`pnpm test:browser`, TASK-208). Zero collected browser tests is a failure
    // (vitest exits 1 on "No test files found").
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
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
          include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts', 'scripts/install-git-hooks.test.ts', '../packages/db/src/**/*.test.ts', '../packages/ports/src/**/*.test.ts', '../packages/storage/src/**/*.test.ts'],
          // *.integration.test.ts files need a real Postgres — they run separately
          // via `pnpm test:integration` (see vitest.integration.config.ts).
          // *.browser.test.ts files need Chromium — the browser projects below.
          exclude: [...configDefaults.exclude, '**/*.integration.test.ts', '**/*.browser.test.ts'],
          globals: true,
          environment: 'jsdom',
          setupFiles: ['tests/unit/setup.ts'],
          fileParallelism: false
        }
      },
      {
        extends: true,
        // Svelte's client build: without the browser condition `svelte` resolves
        // to index-server.js and mount() throws.
        resolve: { conditions: ['browser', 'development'] },
        test: {
          name: 'browser',
          include: BROWSER_TESTS,
          exclude: [...configDefaults.exclude, DSF2_BROWSER_TESTS],
          globals: true,
          fileParallelism: false,
          browser: {
            enabled: true,
            headless: true,
            screenshotFailures: false,
            provider: playwright({ launchOptions: chromiumLaunch }),
            instances: [{ browser: 'chromium' }]
          }
        }
      },
      {
        // Item (8): 1280 px at 200 % zoom is a 640 CSS px viewport at device scale 2.
        extends: true,
        resolve: { conditions: ['browser', 'development'] },
        test: {
          name: 'browser-dsf2',
          include: [DSF2_BROWSER_TESTS],
          globals: true,
          fileParallelism: false,
          browser: {
            enabled: true,
            headless: true,
            screenshotFailures: false,
            provider: playwright({ launchOptions: chromiumLaunch, contextOptions: { deviceScaleFactor: 2 } }),
            instances: [{ browser: 'chromium' }]
          }
        }
      }
    ]
  }
})
