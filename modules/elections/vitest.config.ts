import { defineConfig } from 'vitest/config'

// Unit tests for the elections module's own source under src/. The app half
// (app/**) is overlaid onto gremion-ui and tested there. Dependency-free: no
// database, no network.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: true,
  },
})
