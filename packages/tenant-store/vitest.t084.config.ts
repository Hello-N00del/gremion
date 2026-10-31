import { defineConfig } from 'vitest/config'

// TASK-084-a specs: ONE scratch PostgreSQL 18 container (test/harness/t084-stack.mjs
// starts it and runs this config). The files share the server, so they run one
// at a time in a single fork.
export default defineConfig({
  test: {
    include: ['test/t084/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    pool: 'forks',
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
