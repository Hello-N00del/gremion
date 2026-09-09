import { resolve } from 'node:path'
import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vitest/config'
import { assertSafeTestDbUrl } from './tests/integration/assert-safe-test-db-url'

// P2.1c (T15 / §6-P2.2): the real-boot fleet (hooks.boot-real.integration.test)
// now asserts a COMPLETE brand identity per tenant after migrations succeed. In
// production the DEFAULT tenant is MATERIALIZED (config.json has real brand
// values); reflect that for the suite by pointing the default tenant's
// CONFIG_PATH (registry.configPathForTenant('default') + tests/integration/
// setup.ts) at a committed complete-brand fixture. MUST be set here — before the
// $env/dynamic/private snapshot at worker fork — so registry reads it. `??=`
// lets a real shell/CI value win (e.g. the deselection-boot test's verein config).
process.env.CONFIG_PATH ??= resolve(__dirname, 'tests/integration/fixtures/default-config.json')

// The DB-backed FinTS crypto tests read FINTS_PASSWORD_KEY via
// $env/dynamic/private, which snapshots process.env when the SvelteKit env
// module first initialises — earlier than vitest setupFiles would run. Set it
// here in the config module (main process, before workers fork) so every worker
// inherits a valid 32-byte / 64-hex key. `??=` lets a real shell/CI value win.
process.env.FINTS_PASSWORD_KEY ??= '0'.repeat(64)

// P2.1a — the control-registry DB-backed tests read CONTROL_DATABASE_URL the
// same way db.ts reads DATABASE_URL. Default it here (main process, before
// workers fork) so local + CI converge; a real shell/CI value wins via ??=.
process.env.CONTROL_DATABASE_URL ??= 'postgres://gremion:gremion_test@localhost:5432/control'

// P2.1a — legacy single-tenant data-plane integration tests resolve a default
// tenant whose dbUrl reads DATABASE_URL (see tests/integration/setup.ts).
// Default it here so local + CI converge; a real shell/CI value wins via ??=.
process.env.DATABASE_URL ??= 'postgres://gremion:gremion_test@localhost:5432/gremion'

// P2.1a — the real-boot integration test (hooks.boot-real) and the e2e iss-replay
// test drive the REAL boot() -> data-plane runMigrations(). The integration DB
// has the SCHEMA migrations applied but NOT the *_seed.sql dev seeds (they
// reference dev-realm KC UUIDs + a committees table the harness doesn't
// populate), so an un-flagged runMigrations() would try to apply 005_dev_seed.sql
// and explode. Production already disables seeds (docker-compose.prod.yml); set
// the same flag here (config module, before the $env/dynamic/private snapshot)
// so runMigrations() is a clean no-op. No existing integration test relies on
// runMigrations applying seeds — they all use the pre-migrated DB directly.
process.env.GREMION_DISABLE_SEEDS ??= 'true'

// P2.1a — resolveTenantBySlug assembles a full TenantContext, which eagerly
// resolves the KC-admin + Auth.js UI client secret refs (getKeycloakAdminClient
// reads resolveSecret in its constructor) and derives the default tenant's
// authExternalBase from AUTH_KEYCLOAK_BASE/ISSUER. These are build-test
// placeholders only — no real KC/network call is made by the build test. `??=`
// lets a real shell/CI value win.
process.env.KEYCLOAK_ADMIN_CLIENT_SECRET ??= 'test-kc-admin-secret'
process.env.AUTH_KEYCLOAK_SECRET ??= 'test-ui-client-secret'
process.env.AUTH_KEYCLOAK_ISSUER ??= 'https://council.example/auth/realms/sturaos'
process.env.AUTH_KEYCLOAK_BASE ??= 'https://council.example/auth/realms/sturaos'

// Fail-closed: guard every DB URL the suite connects to — at config-load time
// so vitest refuses to even boot when a dangerous URL is set.
assertSafeTestDbUrl(process.env.DATABASE_URL ?? '', 'DATABASE_URL')
assertSafeTestDbUrl(process.env.CONTROL_DATABASE_URL ?? '', 'CONTROL_DATABASE_URL')

// Integration test config — DB-backed *.integration.test.ts files.
//
// These require a real Postgres reachable via DATABASE_URL with all
// migrations applied. Run with `pnpm test:integration`.
// The fast, dependency-free unit suite lives in vite.config.ts (`pnpm test:unit`).
export default defineConfig({
  plugins: [sveltekit()],
  ssr: { noExternal: ['@gremion/db'] },
  test: {
    include: ['src/**/*.integration.test.ts'],
    globals: true,
    environment: 'node',
    setupFiles: ['tests/integration/setup.ts'],
    // DB-backed test files share a single Postgres instance and truncate
    // shared tables in beforeEach — parallel files cause FK/race failures.
    fileParallelism: false,
  },
})
