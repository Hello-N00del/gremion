import { defineConfig } from 'vitest/config'

// Unit specs (test/*.test.ts) need nothing but node. The live-broker specs
// (test/live/*.test.ts) run only under scripts/proof.sh, which starts the
// broker and sets NATS_AUTH_PROOF; a plain `pnpm test` excludes them rather
// than collecting a file whose every test would skip.
export default defineConfig({
  test: {
    include: process.env.NATS_AUTH_PROOF ? ['test/live/**/*.test.ts'] : ['test/**/*.test.ts'],
    exclude: process.env.NATS_AUTH_PROOF ? [] : ['test/live/**'],
    environment: 'node',
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
