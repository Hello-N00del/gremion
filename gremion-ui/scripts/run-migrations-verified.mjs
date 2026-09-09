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

registerHooks({ resolve: shimResolve, load: shimLoad })

// Mirrors hooks.server.ts boot(): post-P2.1b, getDb() is fail-closed
// (requireTenant() THROWS outside runWithTenant), so the data plane can only be
// migrated inside a tenant scope. We therefore run the SAME orchestration boot
// does — control migrations → register the `default` tenant in the control
// registry → fleet-migrate every ACTIVE tenant (runFleetMigrations resolves each
// by slug and applies runMigrations() inside runWithTenant(ctx, …)). Requires
// CONTROL_DATABASE_URL (+ the control DB to exist) and the default tenant's
// CONFIG_PATH, exactly like a real boot.
try {
  const { runControlMigrations } = await import('../src/lib/server/tenant/control-migrations.ts')
  const { registerDefaultTenant } = await import('../src/lib/server/tenant/register-default.ts')
  const { runFleetMigrations } = await import('../src/lib/server/tenant/fleet.ts')

  await runControlMigrations()
  await registerDefaultTenant()
  const outcomes = await runFleetMigrations()

  const failed = [...outcomes.entries()].filter(([, o]) => !o.ok)
  if (failed.length > 0) {
    for (const [id, o] of failed) {
      console.error(`[run-migrations-verified] tenant ${id} FAILED: ${o.error ?? ''}`, o.cause ?? '')
    }
    process.exit(1)
  }
  console.info(`[run-migrations-verified] all tenants migrated + verified (${outcomes.size} tenant(s))`)
  process.exit(0)
} catch (err) {
  console.error('[run-migrations-verified] migration failure:', err)
  process.exit(1)
}
