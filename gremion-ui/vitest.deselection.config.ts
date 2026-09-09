import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vitest/config'

// The DB-backed FinTS crypto tests read FINTS_PASSWORD_KEY via
// $env/dynamic/private, which snapshots process.env when the SvelteKit env
// module first initialises — earlier than vitest setupFiles would run. Set it
// here in the config module (main process, before workers fork) so every worker
// inherits a valid 32-byte / 64-hex key. `??=` lets a real shell/CI value win.
process.env.FINTS_PASSWORD_KEY ??= '0'.repeat(64)

// P0.2 deselection boot-smoke config — DEDICATED lane for the standalone
// finance-OFF proof under tests/integration/**.
//
// This is intentionally SEPARATE from vitest.integration.config.ts: that lane
// collects `src/**/*.integration.test.ts` against a SHARED, FINANCE-ON,
// fully-migrated Postgres, whereas this proof needs the OPPOSITE — a FRESH,
// FINANCE-OFF, isolated DB (and, optionally, a throwaway Keycloak realm). A
// positional path arg to `vitest run` is a FILTER intersected with the config
// `include`, NOT an include override, so the deselection file (under
// tests/integration/**, outside `src/**`) is uncollectable via the integration
// config. This config's `include` matches it directly.
//
// Run with `pnpm test:deselection` against the isolated stack — see
// tests/integration/README.md for the full runbook. It is NOT a CI lane.
export default defineConfig({
  plugins: [sveltekit()],
  ssr: { noExternal: ['@gremion/db'] },
  test: {
    include: ['tests/integration/**/*.integration.test.ts'],
    globals: true,
    environment: 'node',
    // Establish the default-tenant ALS context (P2.1a) and guard DATABASE_URL
    // before the boot-smoke's beforeAll runs. See deselection-setup.ts for why
    // this is separate from the shared integration setup.ts.
    setupFiles: ['tests/integration/deselection-setup.ts'],
    // DB-backed test files share a single Postgres instance — keep file-level
    // parallelism off to match the integration lane's isolation guarantees.
    fileParallelism: false,
  },
})
