import { defineConfig } from 'vitest/config'

// Unit tests for the board leaf service. Dependency-free (node:http, node:crypto,
// node:fs only) — no PG. Integration tests run via vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.integration.test.ts'],
    environment: 'node',
    globals: true,
  },
})
