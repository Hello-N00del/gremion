import { assertSafeTestDbUrl } from './assert-safe-test-db-url'
import { beforeAll, beforeEach } from 'vitest'
import { _getAls, type TenantContext } from '$lib/server/tenant/context'

// Fail-closed: refuse to run the destructive integration suite against any
// database URL that does not look like a local test fixture. This catches the
// case where a shell DATABASE_URL / CONTROL_DATABASE_URL is set to the live
// staging database (localhost:5433, user/db=stura — no "test" convention).
assertSafeTestDbUrl(process.env.DATABASE_URL ?? '', 'DATABASE_URL')
assertSafeTestDbUrl(process.env.CONTROL_DATABASE_URL ?? '', 'CONTROL_DATABASE_URL')

// Legacy single-tenant integration tests run against the default tenant's
// data plane. getDb()/getFinanceDb() are now fail-closed, so establish a
// default TenantContext in ALS before each test. enterWith sets the store
// for the remainder of the current async execution (the test body).
const DEFAULT_TEST_TENANT = {
  id: 'default',
  // P2.1b T7: the per-tenant service singletons (matrix/synapse/helios/
  // newsletter/livekit) branch on slug === 'default' to keep tenant #1 on its
  // env-derived values byte-identically — the harness tenant must carry it.
  slug: 'default',
  // §8.1 / D-CONFIGPATH (P2.1c T13): the harness now carries a real configPath
  // so it stops depending on config.ts's (removed) `id === 'default'` special-case
  // — it rides the SAME readConfig(tenant.configPath) path as a real tenant. The
  // value mirrors registry.ts configPathForTenant('default'): env.CONFIG_PATH with
  // the same /app default, so default-tenant config reads stay byte-identical.
  configPath: process.env.CONFIG_PATH ?? '/app/config/config.json',
  dbUrl: process.env.DATABASE_URL,
  dbMax: 5,
  dbPrepare: true,
  // P2.1a — display-name / KC-admin code now reads getTenant().realmName /
  // kcAdminUrl / kcClientId / kcClientSecretRef via ALS. Widen the default test
  // tenant with the KC fields so any integration test that touches those paths
  // reads real values instead of undefined.
  realmName: 'sturaos',
  kcAdminUrl: process.env.KEYCLOAK_ADMIN_URL ?? 'http://keycloak:8080/auth',
  kcClientId: 'gremion-admin',
  kcClientSecretRef: 'env:KEYCLOAK_ADMIN_CLIENT_SECRET',
} as unknown as TenantContext

function establishDefaultTenant() {
  // A test file may FULLY replace $lib/server/tenant/context with vi.mock (e.g.
  // rate-limit-routes.integration.test.ts), so _getAls may not exist there.
  // Guard the enterWith so a fully-mocked context module does not crash the
  // shared harness.
  if (typeof _getAls === 'function') {
    _getAls().enterWith(DEFAULT_TEST_TENANT)
  }
}

// beforeAll AND beforeEach: some suites seed their data plane in a `beforeAll`
// (e.g. tests/finance/yearend-fixture.ts truncate+seed), which runs BEFORE the
// first `beforeEach` — so establish the default tenant in both, or beforeAll-time
// getDb()/getFinanceDb() fail-closed.
beforeAll(establishDefaultTenant)
beforeEach(establishDefaultTenant)
