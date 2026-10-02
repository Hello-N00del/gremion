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
    // One file at a time, in one worker: the files share the finance_test_ control DB
    // and race on CREATE DATABASE (pg_database_datname_index) when run in parallel.
    // Vitest 4 removed test.poolOptions (the old forks.singleFork was silently
    // ignored); these are the top-level Vitest 4 options (R29-KHYG-K, mirrors the
    // StuRaOS services/finance F1-FIX-05-S fix).
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
