import { defineConfig } from 'vitest/config'

// @gremion/generated-clients-dart specs run via
// `pnpm --filter @gremion/generated-clients-dart test` (both projects) or
// `test:unit` (`--project unit`, no Docker). Every unit spec takes an injected
// generator or fake tools. Only the `integration` project needs the real pinned
// openapi-generator + Dart SDK (PATH or Docker), and it FAILS, never skips,
// when neither is available. The split lives here rather than in a shell glob
// so it behaves the same under cmd.exe.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    projects: [
      { extends: true, test: { name: 'unit', include: ['src/**/*.test.ts'], exclude: ['src/**/*.integration.test.ts'], testTimeout: 15_000 } },
      { extends: true, test: { name: 'integration', include: ['src/**/*.integration.test.ts'], testTimeout: 900_000 } },
    ],
  },
})
