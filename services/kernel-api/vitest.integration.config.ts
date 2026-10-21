import { defineConfig } from 'vitest/config'

// The kernel API on a scratch PG18 (test/harness/stack.mjs starts it, runs
// this config, and removes it by name). The files share the scratch server's
// databases, so they run one at a time.
export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
