import { defineConfig } from 'vitest/config'

// TASK-080-a round 3: test/bodies/image-proof.sh runs test/bodies/image.proof.ts (the image-level proof) with this
// config. Not part of `test` (needs a stack) nor of the integration or live suites.
export default defineConfig({
  test: {
    include: ['test/bodies/image.proof.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
})
