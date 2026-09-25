import { defineConfig } from 'vitest/config'

// Integration specs: the two-tenant scratch stack (test/harness/stack.mjs
// starts it and runs this config). The files share the tenants' databases,
// so they run one at a time.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/harness/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
