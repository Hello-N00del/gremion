import { defineConfig } from 'vitest/config'

// @gremion/retention's unit suite: no database, no network. passWithNoTests is
// deliberately NOT set: a run that collects zero tests is a failure.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The scratch-database specs run through test/integration/run.mjs only.
    exclude: ['test/integration/**'],
    environment: 'node',
  },
})
