import { assertNonProductionDbUrl } from './assert-safe-test-db-url'
import { beforeAll, beforeEach } from 'vitest'
import { _getAls, type TenantContext } from '$lib/server/tenant/context'

// Fail-closed (spec B section 6 no-truncate guard): refuse to run the
// destructive integration suite unless every URL it uses names a database that
// cannot be this host's production one (GREMION_PRODUCTION_STACK, no default).
assertNonProductionDbUrl(process.env.DATABASE_URL ?? '', 'DATABASE_URL')
assertNonProductionDbUrl(process.env.CONTROL_DATABASE_URL ?? '', 'CONTROL_DATABASE_URL')

/**
 * The harness tenant (TASK-042 §9). There is no default tenant: the suite's data
 * plane belongs to the fixture tenant `fixture` that `pnpm migrate:test-fixture`
 * (scripts/migrate-test-fixture.mjs) creates with createTestTenant and migrates.
 * getDb()/getFinanceDb() are fail-closed, so this context is entered in ALS
 * before each test (enterWith sets the store for the remainder of the current
 * async execution: the test body).
 *
 * The id is a fixed UUIDv7: a UUID like every registry id (storage's
 * assertTenantId refuses anything else), fixed so the context needs no control-
 * DB read (many suites TRUNCATE the control registry between tests). Suites that
 * need a REGISTRY tenant create one with createTestTenant.
 *
 * It is deliberately NOT the id of the `fixture` row migrate:test-fixture
 * registers (the control DB mints that one, and the row is TRUNCATEd by many
 * suites anyway). Only the DATA PLANE is shared: this context and that row both
 * point at DATABASE_URL, whose schema_migrations the fleet run filled. Nothing
 * here may look the ALS id up in the registry; a suite that needs registry
 * identity uses the TestTenant createTestTenant returns.
 */
export const FIXTURE_TENANT_ID = '01920000-0000-7000-8000-00000000f1c5'
const TENANT_DATA_ROOT = (process.env.TENANT_DATA_ROOT ?? '/data').replace(/\/+$/, '')

const FIXTURE_TEST_TENANT = {
  id: FIXTURE_TENANT_ID,
  slug: 'fixture',
  // The same `${TENANT_DATA_ROOT}/<slug>/config.json` registry.configPathForTenant
  // derives for every tenant (vitest.integration.config.ts points the root at
  // tests/integration/fixtures/tenant-data).
  configPath: `${TENANT_DATA_ROOT}/fixture/config.json`,
  dbUrl: process.env.DATABASE_URL,
  dbMax: 5,
  dbPrepare: true,
  // P2.1a — display-name / KC-admin code reads getTenant().realmName /
  // kcAdminUrl / kcClientId / kcClientSecretRef via ALS; carry real values
  // (unchanged from the pre-TASK-042 harness so KC-mocking suites keep matching).
  realmName: 'gremion-test',
  kcAdminUrl: process.env.KEYCLOAK_ADMIN_URL ?? 'http://keycloak:8080/auth',
  kcClientId: 'gremion-admin',
  kcClientSecretRef: 'env:KEYCLOAK_ADMIN_CLIENT_SECRET',
} as unknown as TenantContext

function establishFixtureTenant() {
  // A test file may FULLY replace $lib/server/tenant/context with vi.mock (e.g.
  // rate-limit-routes.integration.test.ts), so _getAls may not exist there.
  // Guard the enterWith so a fully-mocked context module does not crash the
  // shared harness.
  if (typeof _getAls === 'function') {
    _getAls().enterWith(FIXTURE_TEST_TENANT)
  }
}

// beforeAll AND beforeEach: some suites seed their data plane in a `beforeAll`
// (e.g. tests/finance/yearend-fixture.ts truncate+seed), which runs BEFORE the
// first `beforeEach` — so establish the fixture tenant in both, or beforeAll-time
// getDb()/getFinanceDb() fail-closed.
beforeAll(establishFixtureTenant)
beforeEach(establishFixtureTenant)
