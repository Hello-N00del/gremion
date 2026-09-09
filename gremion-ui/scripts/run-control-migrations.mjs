// gremion-ui/scripts/run-control-migrations.mjs
// `pnpm migrate:control` entrypoint. Same SvelteKit env shim as
// run-migrations-verified.mjs so $env/dynamic/private resolves
// CONTROL_DATABASE_URL outside the dev/preview servers.
import { registerHooks } from 'node:module'
import { resolve as shimResolve, load as shimLoad } from './sveltekit-env-shim.mjs'

registerHooks({ resolve: shimResolve, load: shimLoad })

try {
  const m = await import('../src/lib/server/tenant/control-migrations.ts')
  await m.runControlMigrations()
  console.info('[run-control-migrations] all control migrations applied + verified')
  process.exit(0)
} catch (err) {
  console.error('[run-control-migrations] migration failure:', err)
  process.exit(1)
}
