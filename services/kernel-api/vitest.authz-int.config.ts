import { defineConfig } from 'vitest/config'

// TASK-081's PDP/grants suites on a scratch PG18 (test/authz/stack.mjs starts
// it and removes it by name). Files share the server, so one at a time.
export default defineConfig({
  test: {
    include: ['test/authz/**/*.int.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
