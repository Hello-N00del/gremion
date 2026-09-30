/**
 * Vitest setup for the deselection lane (pnpm test:deselection,
 * vitest.deselection.config.ts). This is intentionally SEPARATE from
 * tests/integration/setup.ts for two reasons:
 *
 * 1.  Guard-vs-runbook URL coupling (#267/#249): setup.ts also guards
 *     CONTROL_DATABASE_URL, which the deselection test does NOT consume.
 *     Guarding an unset/irrelevant var would reject perfectly valid deselection
 *     runs. We guard only DATABASE_URL here.
 *
 * 2.  Finance-OFF fresh DB vs. FINANCE-ON shared fixture: setup.ts includes
 *     beforeEach/beforeAll DB-cleanup hooks that truncate the shared integration
 *     DB. The deselection lane must NOT truncate anything — it boots into a
 *     fresh, empty, finance-OFF database and only asserts absence.
 *
 * Both setup files must wire a tenant ALS context (P2.1a): getDb()
 * and runMigrations() are fail-closed and throw "No tenant context" when called
 * outside runWithTenant(). municipal-acceptance.integration.test.ts (the
 * remaining consumer of this lane — see tests/integration/README.md) calls
 * both in its own beforeAll.
 */
import { assertNonProductionDbUrl } from './assert-safe-test-db-url'
import { beforeAll } from 'vitest'
import { _getAls, type TenantContext } from '$lib/server/tenant/context'

// Guard this lane too — it runs migrations against whatever DATABASE_URL is
// set; the no-truncate guard keeps it off this host's production database. We
// do NOT guard CONTROL_DATABASE_URL: the deselection test only touches the
// data-plane DB.
assertNonProductionDbUrl(process.env.DATABASE_URL ?? '', 'DATABASE_URL')

// The pool-registry keys on tenant.id and connects via tenant.dbUrl.
// Snapshot process.env.DATABASE_URL here (module-import time) so the context
// carries the URL the operator set before starting the vitest process — exactly
// the same pattern as setup.ts's FIXTURE_TEST_TENANT.dbUrl.
const DESELECTION_TEST_TENANT = {
  // TASK-042: there is no default tenant; this lane's tenant is a plain fixture
  // with a UUID id like every registry tenant (storage refuses anything else).
  id: '01920000-0000-7000-8000-00000000d5e1',
  slug: 'deselection',
  // §8.1 / D-CONFIGPATH: readConfig() reads tenant.configPath UNCONDITIONALLY
  // (config.ts getConfigPath no longer re-reads env). runMigrations() →
  // readConfig() drives the disabled-module migration skip-set, so the
  // finance-OFF proof MUST carry the operator's CONFIG_PATH here, or readConfig
  // falls back to the finance-ON DEFAULT_CONFIG and the finance migrations run
  // anyway (defeating the deselection / municipal-acceptance proof). Mirrors
  // the per-tenant config file setup.ts's FIXTURE_TEST_TENANT carries.
  configPath: process.env.CONFIG_PATH ?? '/app/config/config.json',
  dbUrl: process.env.DATABASE_URL,
  dbMax: 5,
  dbPrepare: true,
  // Carry minimal KC fields so any code path that reads getTenant().realmName /
  // kcAdminUrl / kcClientId / kcClientSecretRef does not get undefined.
  realmName: 'gremion-test',
  kcAdminUrl: process.env.KEYCLOAK_ADMIN_URL ?? 'http://keycloak:8080/auth',
  kcClientId: 'gremion-admin',
  kcClientSecretRef: 'env:KEYCLOAK_ADMIN_CLIENT_SECRET',
} as unknown as TenantContext

function establishDeselectionTenant() {
  // Guard: a vi.mock on the context module may remove _getAls (same defensive
  // pattern as setup.ts's establishDefaultTenant).
  if (typeof _getAls === 'function') {
    _getAls().enterWith(DESELECTION_TEST_TENANT)
  }
}

// beforeAll only: the deselection lane has no per-test DB cleanup hooks, so a
// single beforeAll establish is sufficient. The consuming spec's own beforeAll
// (runMigrations) runs AFTER this file's beforeAll thanks to setupFiles running
// before any test file is imported.
beforeAll(establishDeselectionTenant)
