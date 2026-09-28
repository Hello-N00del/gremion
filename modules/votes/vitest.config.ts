import { defineConfig } from 'vitest/config'

// Unit tests for the votes leaf service. Dependency-free at the transport layer
// (node:http, node:crypto) — no PG/NATS (the leaf is stateless). Integration
// tests (if any) run via the separate vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.integration.test.ts'],
    environment: 'node',
    globals: true,
  },
})
