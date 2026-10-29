import { defineConfig } from 'vitest/config'

// The kernel API on a scratch PG18 (test/harness/stack.mjs starts it, runs
// this config, and removes it by name). The files share the scratch server's
// databases, so they run one at a time.
export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    // test/bodies/live.int.test.ts needs the broker: test/bodies/proof.sh runs it with vitest.live.config.ts;
    // TASK-081's own scratch stack (test/authz/stack.mjs, vitest.authz-int.config.ts) runs test/authz
    exclude: ['test/bodies/live.int.test.ts', 'test/authz/**', '**/node_modules/**'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
