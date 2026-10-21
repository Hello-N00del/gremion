import { defineConfig } from 'vitest/config'

// @gremion/tenancy-core: pure functions plus injected DB/log seams, so the
// suite runs standalone. passWithNoTests is deliberately NOT set: a run that
// collects zero tests is a failure.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
