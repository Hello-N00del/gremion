import { defineConfig } from 'vitest/config'

// Integration test config for the calendar leaf service.
// Runs against a real disposable Postgres. CALENDAR_TEST_PG_URL is REQUIRED (no
// default) and MUST point at a throwaway container on a NON-5432 port — port 5432
// on this host is the LIVE staging Postgres. The fail-closed guard in
// test/support/pg-test-guard.ts enforces required-env + localhost-only + non-5432
// port + the calendar_test_ DB-name prefix (mirrors #249 / finance PR #393 / #394).
export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts', 'test/relay.test.ts'],
    environment: 'node',
    globals: true,
    // Integration tests are sequential within a file; no parallel workers
    // needed here (small set, each test is IO-bound on PG).
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 30_000,
  },
})
