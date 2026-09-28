import { defineConfig } from 'vitest/config'

// Integration test config for the finance leaf service.
// Runs against a real disposable Postgres. FINANCE_TEST_PG_URL is REQUIRED (no
// default) and MUST point at a throwaway container on a NON-5432 port — port 5432
// on this host is the LIVE staging Postgres. The fail-closed guard inside each
// *.integration.test.ts enforces localhost-only + non-5432 port + the
// finance_test_ DB-name prefix (mirrors #249 / assert-safe-test-db-url).
export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    environment: 'node',
    globals: true,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 30_000,
  },
})
