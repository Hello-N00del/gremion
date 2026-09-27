import { defineConfig } from 'vitest/config'

// @gremion/edge-routers is dependency-free (node: builtins only) and runs
// standalone via `pnpm --filter @gremion/edge-routers test`. passWithNoTests is
// deliberately NOT set: a run that collects zero tests is a failure.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
