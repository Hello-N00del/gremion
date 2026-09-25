import { defineConfig } from 'vitest/config'

// @gremion/generated-clients-dart specs run via
// `pnpm --filter @gremion/generated-clients-dart test`. Every unit spec takes
// an injected generator, so only src/**/*.integration.test.ts needs the real
// pinned openapi-generator + Dart SDK (PATH or Docker; it fails, never skips,
// when neither is available).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 15_000,
  },
})
