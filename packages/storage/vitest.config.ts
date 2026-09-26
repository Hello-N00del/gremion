import { defineConfig } from 'vitest/config'

// @gremion/storage specs run standalone via `pnpm --filter @gremion/storage test`
// AND through gremion-ui's vitest via the `../packages/storage/src/**/*.test.ts`
// include glob (gremion-ui/vite.config.ts), same as @gremion/ports.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: true,
    fileParallelism: false,
  },
})
