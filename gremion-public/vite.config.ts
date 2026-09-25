// gremion-public/vite.config.ts
// defineConfig comes from 'vitest/config' (not 'vite') so its return type is
// augmented with the `test` block below — vitest 4 dropped the ambient
// `/// <reference types="vitest" />` ampersand-merge onto vite's own
// UserConfig, so importing plain `defineConfig` from 'vite' now makes
// svelte-check reject `test` as an unknown property. Same fix as gremion-ui's
// vite.config.ts (which imports the same helper from 'vitest/config').
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import svelteConfig from './kit.config.js';

export default defineConfig({
  // #436 — Tailwind v4 via its own Vite plugin, mirroring gremion-ui. This
  // replaces the v3 postcss.config.js (`tailwindcss` + `autoprefixer`
  // entries): vite 8's rolldown-based CSS resolver mis-resolves the bare
  // `@import 'tailwindcss'` specifier through postcss-import, and v4 does its
  // own vendor prefixing via Lightning CSS, so neither postcss entry survives.
  // TASK-032: kit 3 requires Svelte(Kit) config to be passed through the
  // `sveltekit(...)` plugin call rather than auto-discovered from
  // kit.config.js.
  plugins: [tailwindcss(), sveltekit(svelteConfig)],
  // TASK-032: kit 3 removed `base` from `$app/paths`; `$lib/base.ts` reads it
  // back from this build-time constant instead, sourced from the SAME
  // `kit.config.js` value SvelteKit itself uses for `paths.base` (one
  // computation, not a second env-var read that could drift from it).
  define: {
    __BASE_PATH__: JSON.stringify(svelteConfig.paths?.base ?? ''),
  },
  ssr: {
    noExternal: ['@gremion/db']
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
