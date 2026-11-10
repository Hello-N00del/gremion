import { defineConfig } from 'vitest/config'

// Integration specs: the two-tenant scratch stack (test/harness/stack.mjs
// starts it and runs this config). The files share the tenants' databases,
// so they run one at a time.
export default defineConfig({
  test: {
    // isolation-evidence-producer.test.ts (pilot wave 2) records the producer's
    // file into gremion_platform; it cleans up its own rows.
    include: ['test/integration/**/*.test.ts', 'test/isolation-evidence-producer.test.ts'],
    environment: 'node',
    globalSetup: ['test/harness/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
