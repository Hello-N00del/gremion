// gremion-ui/scripts/migrate-test-fixture.mjs
//
// TASK-042 §9: the integration harness's migrate step. Boot and `pnpm migrate`
// register no tenant any more (zero-tenant boot), so on an empty control DB they
// migrate zero data planes. The integration suite needs ONE migrated data plane,
// so this script creates the harness fixture tenant the only way a kernel suite
// may (createTestTenant: slug `fixture`, primary host `fixture.test`, data plane
// = env:DATABASE_URL) and then runs the SAME fleet migration boot runs.
//
// Invocation: `pnpm migrate:test-fixture` (gremion-ui/package.json). Same tsx +
// SvelteKit env shim bootstrap as run-migrations-verified.mjs. Requires
// DATABASE_URL, CONTROL_DATABASE_URL and TENANT_DATA_ROOT (whose
// `fixture/config.json` carries the complete brand the fleet's brand guard
// requires), exactly like the suite itself (vitest.integration.config.ts).
// Idempotent: a re-run finds the tenant and its host already registered.

import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolve as shimResolve, load as shimLoad } from './sveltekit-env-shim.mjs'

registerHooks({ resolve: shimResolve, load: shimLoad })

// The same `??=` defaults vitest.integration.config.ts gives the suite, so this
// step and the suite agree on the fixture tenant's config file and on the
// platform apex addTenantDomain checks hosts against. A real shell value wins.
const here = dirname(fileURLToPath(import.meta.url))
process.env.TENANT_DATA_ROOT ??= join(here, '..', 'tests', 'integration', 'fixtures', 'tenant-data')
process.env.PLATFORM_DOMAIN ??= 'gremion.example'

export const FIXTURE = { slug: 'fixture', host: 'fixture.test' }

try {
  const { runControlMigrations } = await import('../src/lib/server/tenant/control-migrations.ts')
  const { runFleetMigrations } = await import('../src/lib/server/tenant/fleet.ts')
  const { createTestTenant } = await import('../tests/integration/create-test-tenant.ts')

  await runControlMigrations()
  const t = await createTestTenant(FIXTURE)
  const outcomes = await runFleetMigrations()

  const mine = outcomes.get(t.id)
  if (!mine) throw new Error(`fixture tenant ${t.id} was not in the fleet run`)
  const failed = [...outcomes.entries()].filter(([, o]) => !o.ok)
  if (failed.length > 0) {
    for (const [id, o] of failed) {
      console.error(`[migrate-test-fixture] tenant ${id} FAILED: ${o.error ?? ''}`, o.cause ?? '')
    }
    process.exit(1)
  }
  console.info(`[migrate-test-fixture] fixture tenant ${t.slug} (${t.id}, host ${t.host}) migrated (${outcomes.size} tenant(s))`)
  process.exit(0)
} catch (err) {
  console.error('[migrate-test-fixture] failure:', err)
  process.exit(1)
}
