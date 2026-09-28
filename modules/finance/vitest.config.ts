import { defineConfig } from 'vitest/config'

// Unit tests for the finance leaf service. Dependency-free (node:http,
// node:crypto only) — no PG. Integration tests (backfill / api) run via the
// separate vitest.integration.config.ts against a disposable Postgres.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.integration.test.ts'],
    environment: 'node',
    globals: true,
  },
})
