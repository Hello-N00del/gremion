import { defineConfig } from 'vitest/config'

// scripts/verify/suites/integration.mjs, part `keycloak-stepup`: the live Keycloak step-up deny proof
// (test/keycloak/stepup-deny.int.test.ts). The file starts its own Keycloak container (plain docker, by
// name, 127.0.0.1 only), so it needs neither the scratch PG18 of `test:integration` nor a broker; the
// verify part runs it with this config on its own. `test:integration` still collects it too.
export default defineConfig({
  test: {
    include: ['test/keycloak/stepup-deny.int.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
})
