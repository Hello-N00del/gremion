import { defineConfig } from 'vitest/config'

// Integration test config for the board leaf service. Runs against a real
// disposable Postgres. BOARD_TEST_PG_URL is REQUIRED (no default) and MUST point
// at a throwaway container on a NON-5432 port — port 5432 on this host is the LIVE
// staging Postgres. The fail-closed guard in test/support/pg-test-guard.ts enforces
// required-env + localhost-only + non-5432 port + a board_test_ DB-name prefix
// (mirrors #249 / finance PR #393 / #394), and assertScratchTenantDb admits only
// the three fixture tenant databases, so a test run can NEVER touch live data.
//
// BOARD_TEST_PG_CONTAINER is ALSO REQUIRED: the name of the scratch container that
// runs BOARD_TEST_PG_URL. The lifecycle suite (A8) runs disableModule, whose export
// step is pg_dump; the suite runs pg_dump/pg_restore inside that container so the
// client matches the server's major. Without it that suite fails loudly. Full run:
//   BOARD_TEST_PG_URL=postgres://postgres@127.0.0.1:<port>/postgres \
//   BOARD_TEST_PG_CONTAINER=<container name> pnpm --filter board-service test:integration
//
// The suites share one scratch server and the fixture tenant databases, so files
// run one at a time (Vitest 4 dropped test.poolOptions; fileParallelism is the
// switch now).
export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    environment: 'node',
    globals: true,
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
