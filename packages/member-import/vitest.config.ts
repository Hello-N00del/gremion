import { defineConfig } from 'vitest/config'

// @gremion/member-import's unit suite: every port is a recording fake, so it
// runs with no database or Keycloak. passWithNoTests is deliberately NOT set:
// a run that collects zero tests is a failure.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
