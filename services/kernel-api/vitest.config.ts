import { defineConfig } from 'vitest/config'

// @gremion/kernel-api unit + in-process suites (no database: fakes, local jose
// issuers, a stub JWKS server on 127.0.0.1). The scratch-stack suites (PG18)
// are test:integration (vitest.integration.config.ts via test/harness/stack.mjs).
// passWithNoTests is deliberately NOT set: zero collected tests is a failure.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.int.test.ts', '**/node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
  },
})
