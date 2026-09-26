// Root Vite+ config (TASK R25-2, Stage 1). Lint + fmt ONLY: gremion-ui and
// gremion-public keep their own SvelteKit `vite.config.ts` for the Vite/Vitest
// plugin pipeline (sveltekit(), svelteTesting(), tailwindcss(), server/ssr/test
// blocks) — this file must not touch any of that. `vp lint`/`vp fmt` run from
// the workspace root and this is the nearest `vite.config.*` carrying a `lint`/
// `fmt` block, so both apps are linted/formatted through this file without a
// package-level block (monorepo guide: nested lint/fmt blocks are discouraged).
//
// Stage 2 (switching the apps' own vite/vitest to the vite-plus core, `vp
// test`/`vp build`, pnpm overrides) is a separate later unit — nothing here
// changes test or build behaviour.
import { defineConfig } from 'vite-plus'

export default defineConfig({
  lint: {
    // unicorn + typescript + oxc are Oxlint's own defaults; import/promise/
    // node/vitest are opt-in (CLI --import-plugin etc.) and named explicitly
    // here so `vp check` (which reads this same block) gets them too.
    plugins: ['typescript', 'unicorn', 'oxc', 'import', 'promise', 'node', 'vitest'],
    categories: {
      correctness: 'error',
      suspicious: 'warn',
      perf: 'warn',
      pedantic: 'off',
      style: 'off',
      restriction: 'off',
      nursery: 'off',
    },
    options: {
      // tsgolint (TypeScript 7 / TS-Go) type-aware rules, e.g.
      // typescript/no-floating-promises, typescript/await-thenable.
      typeAware: true,
    },
    rules: {
      // node:test's test()/describe()/hooks return promises that the runner
      // itself awaits, so a top-level `test(...)` is not a floating promise.
      // This is the allow-list typescript-eslint documents for exactly this
      // case (no-floating-promises, allowForKnownSafeCalls). Every other
      // unawaited promise stays an error. Without it the rule reported 258
      // false positives in scripts/**/*.test.mjs and ops/**.
      'typescript/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            {
              from: 'package',
              package: 'node:test',
              name: ['test', 'it', 'describe', 'suite', 'before', 'after', 'beforeEach', 'afterEach'],
            },
          ],
        },
      ],
      // A vi.fn()/vi.spyOn() without type parameters is loosely typed, not
      // wrong: a typing preference, not a correctness defect (479 sites).
      // Off rather than churn every mock; tighten per package if wanted.
      'vitest/require-mock-type-parameters': 'off',
    },
    // Svelte 5 runes: empirically oxlint 1.85.0 already resolves $state,
    // $derived, $effect, $props, $bindable, $inspect and $host natively (a
    // whole-tree `vp lint gremion-ui/src gremion-public/src -f json` run
    // found zero no-undef diagnostics naming any of them) — the FACTS brief's
    // "declare them or they hit no-undef" did not hold for this version.
    // Declared anyway as a harmless, explicit safety net.
    globals: {
      $state: 'readonly',
      $derived: 'readonly',
      $effect: 'readonly',
      $props: 'readonly',
      $bindable: 'readonly',
      $inspect: 'readonly',
      $host: 'readonly',
    },
    ignorePatterns: [
      'node_modules/**',
      'build/**',
      'dist/**',
      '.svelte-kit/**',
      'coverage/**',
      'packages/generated-clients/src/generated/**',
      'packages/generated-clients-dart/**',
      'docs/**',
      '**/__fixtures__/**',
      '**/*.min.js',
    ],
  },
  fmt: {
    // House style read from the existing tree (no prior formatter config
    // existed): single quotes and no semicolons dominate overwhelmingly
    // (sampled 40 .ts/.mjs/.svelte files: 4869 single- vs 810 double-quote
    // characters; already-formatted files like gremion-public/src/hooks.server.ts
    // round-trip with zero diff under these two settings). printWidth (100)
    // and trailingComma ('es5' beat 'all' on a real multi-arg call site, 64
    // vs 66 changed lines) are oxfmt/Prettier's own long-standing defaults —
    // kept as the closest available match; arrowParens 'always' (default)
    // already matches every single-param arrow sampled. Svelte-file formatting
    // is left disabled (its own default): enabling prettier-plugin-svelte
    // would reformat every .svelte file on first run, which "do not reformat
    // anything" rules out for Stage 1.
    singleQuote: true,
    semi: false,
    printWidth: 100,
    trailingComma: 'es5',
    ignorePatterns: [
      'node_modules/**',
      'build/**',
      'dist/**',
      '.svelte-kit/**',
      'coverage/**',
      'packages/generated-clients/src/generated/**',
      'packages/generated-clients-dart/**',
      'docs/**',
      '**/__fixtures__/**',
      '**/*.min.js',
    ],
  },
})
