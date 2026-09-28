import { defineConfig } from 'vitest/config'

// Unit specs: no database, no network. `pnpm --filter @gremion/module-catalogue test`.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
})
