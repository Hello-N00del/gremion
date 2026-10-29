import { defineConfig } from 'vitest/config'

// TASK-080-a test/bodies/proof.sh: the live proof (PG18 + the authenticated NATS of
// test/harness/live-stack.mjs). Not part of `test` (no database) nor of
// `test:integration` (its own PG, no broker): proof.sh runs it with this config.
export default defineConfig({
  test: {
    include: ['test/bodies/live.int.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
})
