import { defineConfig } from 'vitest/config'

// Integration test config for the files leaf service. The leaf is stateless (no
// PG), so integration tests here would exercise a real Nextcloud endpoint. None
// exist yet; this config exists for shape-parity with the other leaves and so
// `pnpm --filter files-service test:integration` resolves.
export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    environment: 'node',
    globals: true,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 30_000,
  },
})
