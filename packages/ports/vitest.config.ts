import { defineConfig } from 'vitest/config'

// @gremion/ports unit specs are dependency-free (node:crypto only) and run
// standalone via `pnpm -C packages/ports test`. They ALSO run through gremion-ui's
// vitest via the `../packages/ports/src/**/*.test.ts` include glob (vite.config.ts),
// which is the monolith's collection path after the broker/tracer move.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: true,
  },
})
