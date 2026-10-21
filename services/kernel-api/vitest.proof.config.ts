import { defineConfig } from 'vitest/config'

// TASK-077 stack-proof.sh phases that run TypeScript against the e2e stack: the
// seed (stack-seed.ts) and the live assertions (stack-e2e.ts). Not part of the
// integration suite (its own PG): stack-proof.sh runs them with this config.
export default defineConfig({
  test: {
    include: ['test/harness/stack-seed.ts', 'test/harness/stack-e2e.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
