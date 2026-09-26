import { defineConfig } from 'vitest/config'

// Unit specs: no database. `pnpm --filter @gremion/tenant-store test`.
// The integration specs (test/integration/**) need the scratch stack and run
// through vitest.integration.config.ts instead.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts'],
    environment: 'node',
  },
})
