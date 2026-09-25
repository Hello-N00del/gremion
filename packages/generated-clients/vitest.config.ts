import { defineConfig } from 'vitest/config'

// @gremion/generated-clients unit specs run standalone via
// `pnpm --filter @gremion/generated-clients test`. They read the real
// contracts/ tree at the repository root (two levels up from this package),
// so they must run with cwd semantics that let `find repo root` walk up from
// import.meta.url rather than assuming process.cwd().
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: true,
  },
})
