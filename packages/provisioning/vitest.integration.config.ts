import { defineConfig } from 'vitest/config'

// The provisioning package's integration specs: one scratch PostgreSQL 18
// started by test/integration/run.mjs (`pnpm test:integration`). The files
// share that server, so they run one at a time. Zero collected tests fail.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.int.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 120_000,
  },
})
