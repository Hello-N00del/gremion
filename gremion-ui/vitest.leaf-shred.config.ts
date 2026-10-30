import { defineConfig } from 'vitest/config'

// The newsletter + calendar leaf shred executors' real-Postgres proof, in its own
// minimal lane: node environment, exactly one file, NO setupFiles and NO
// DATABASE_URL / CONTROL_DATABASE_URL defaults (the shared integration setup
// would point at the kernel database). The file requires LEAF_SHRED_TEST_PG_URL
// (a throwaway container on loopback, a non-5432 port, GREMION_PRODUCTION_STACK
// set) and refuses anything else before connecting.
//
//   GREMION_PRODUCTION_STACK=none \
//   LEAF_SHRED_TEST_PG_URL=postgres://leaf_test:<pw>@127.0.0.1:<port>/postgres \
//     pnpm --filter gremion-ui test:leaf-shred
//
// No Paraglide plugin: the file imports only the provisioner's leaf-shred.ts and
// the slug module, neither of which reaches $lib/i18n.
export default defineConfig({
  test: {
    include: ['tests/leaf-shred/leaf-shred.pg.test.ts'],
    environment: 'node',
    globals: true,
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
