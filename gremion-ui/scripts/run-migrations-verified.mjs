// gremion-ui/scripts/run-migrations-verified.mjs
//
// CI / automation entrypoint for applying database migrations with
// SHA-256 manifest verification (G-012) and atomic per-file transactions
// (G-078).
//
// Closes A-016 (addendum-2). The previous CI flow ran a raw psql loop
// (`for f in migrations/*.sql; do psql -f "$f"; done`) which bypassed
// verifyMigrationIntegrity entirely and never wrote schema_migrations
// bookkeeping rows — meaning CI could apply a tampered or out-of-order
// migration and still pass, while prod would refuse to boot. Routing CI
// through runMigrations() restores the same verification + bookkeeping
// path that prod gets on cold start.
//
// runMigrations() itself calls verifyMigrationIntegrity() per file
// (db.ts:107) and applies each via applyMigrationFile() (G-078:
// schema_migrations bookkeeping + sql.unsafe wrapped in one txn). No
// extra verifyMigrationIntegrity() call is needed at this layer.
//
// Invocation: `pnpm migrate` (defined in gremion-ui/package.json), which
// resolves to `tsx scripts/run-migrations-verified.mjs`. tsx is required
// because we dynamic-import the TypeScript module $lib/server/db.ts
// directly; plain `node` cannot resolve a .ts import.
//
// Same module-hook bootstrap as migration-cli-entry.mjs so the SvelteKit
// env shim resolves `$env/dynamic/private` (which db.ts uses to read
// DATABASE_URL) outside the SvelteKit dev/preview servers.

import { registerHooks } from 'node:module'
import { resolve as shimResolve, load as shimLoad } from './sveltekit-env-shim.mjs'
import { fleetVerdict, requireTenantFrom } from './fleet-verdict.mjs'

registerHooks({ resolve: shimResolve, load: shimLoad })

// Mirrors hooks.server.ts boot(): post-P2.1b, getDb() is fail-closed
// (requireTenant() THROWS outside runWithTenant), so the data plane can only be
// migrated inside a tenant scope. We therefore run the SAME orchestration boot
// does — control migrations → fleet-migrate every ACTIVE registry tenant
// (runFleetMigrations resolves each by slug and applies runMigrations() inside
// runWithTenant(ctx, …)). TASK-042: it registers NO tenant; on an empty
// registry it migrates the control plane only and SAYS so (exit 0: a fresh
// host before its first customer is a legitimate state). A caller that needs a
// migrated data plane passes `--require-tenant` (or MIGRATE_REQUIRE_TENANT=1)
// and fails there (scripts/fleet-verdict.mjs). The integration harness creates
// its fixture tenant first (`pnpm migrate:test-fixture`,
// scripts/migrate-test-fixture.mjs). Requires CONTROL_DATABASE_URL (+ the
// control DB to exist), exactly like a real boot.
try {
  const requireTenant = requireTenantFrom(process.argv.slice(2), process.env)
  const { runControlMigrations } = await import('../src/lib/server/tenant/control-migrations.ts')
  const { runFleetMigrations } = await import('../src/lib/server/tenant/fleet.ts')

  await runControlMigrations()
  const outcomes = await runFleetMigrations()

  const verdict = fleetVerdict(outcomes, { requireTenant, tag: '[run-migrations-verified]' })
  for (const args of verdict.errors) console.error(...args)
  for (const line of verdict.info) console.info(line)
  process.exit(verdict.code)
} catch (err) {
  console.error('[run-migrations-verified] migration failure:', err)
  process.exit(1)
}
