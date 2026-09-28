import { defineConfig } from 'vitest/config'

// Unit tests for the calendar leaf service. Dependency-free (node:http,
// node:crypto only) — no PG/NATS. Integration tests (Task 4+) run via the
// separate vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.integration.test.ts', 'test/relay.test.ts'],
    environment: 'node',
    globals: true,
  },
})
