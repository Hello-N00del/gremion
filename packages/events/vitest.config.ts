import { defineConfig } from 'vitest/config'

// Unit specs (test/*.test.ts) need nothing but node. The live specs
// (test/live/*.test.ts) run only under scripts/proof.sh, which starts the scratch
// Postgres and NATS and sets EVENTS_PROOF; a plain `pnpm test` excludes them
// rather than collecting a file whose every test would skip.
export default defineConfig({
  test: {
    include: process.env.EVENTS_PROOF ? ['test/live/**/*.test.ts'] : ['test/**/*.test.ts'],
    exclude: process.env.EVENTS_PROOF ? [] : ['test/live/**'],
    environment: 'node',
    globals: true,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
