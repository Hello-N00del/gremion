// TASK-041 (L3-08): bind customer A for the running-stack proof.
//
//   pnpm -C gremion-ui exec tsx ../test/host/fixtures/tenant-host-proof/bind-customer.mjs
//
// Env: CONTROL_DATABASE_URL (the proof's scratch Postgres, published on the
// host loopback by tenant-host-proof.sh). Runs the control migrations (the
// app would run the same ones at boot; they are idempotent), registers tenant
// `a` and binds its host through the REAL registry `addTenantDomain` -- the
// write path whose normaliseHost the resolver's read path shares. Prints the
// tenant id and the bound host. Never touches any database but the one named.
//
// Mirrors gremion-ui/scripts/run-control-migrations.mjs: the SvelteKit env shim
// is registered BEFORE registry.ts (which imports $env/dynamic/private) loads.
import { registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ui = path.resolve(here, '..', '..', '..', '..', 'gremion-ui')
const shim = await import(pathToFileURL(path.join(ui, 'scripts', 'sveltekit-env-shim.mjs')).href)
registerHooks({ resolve: shim.resolve, load: shim.load })

const HOST = process.env.T041_A_HOST ?? 'a.t041.test'
const SLUG = process.env.T041_A_SLUG ?? 'a'

try {
  const { runControlMigrations } = await import(
    pathToFileURL(path.join(ui, 'src/lib/server/tenant/control-migrations.ts')).href
  )
  const registry = await import(pathToFileURL(path.join(ui, 'src/lib/server/tenant/registry.ts')).href)
  await runControlMigrations()
  const tenant = await registry.registerTenant({
    slug: SLUG,
    status: 'active',
    // The app container carries this env var (tenant-host-proof.sh): A's own
    // data-plane database, migrated by the app's boot fleet.
    dbConnRef: 'env:T041_A_DATABASE_URL',
    realmName: `t041-${SLUG}`,
    issuer: `http://${HOST}/auth/realms/t041-${SLUG}`,
    kcInternal: `http://keycloak:8080/auth/realms/t041-${SLUG}`,
    kcClientId: 'gremion-admin',
    kcClientRef: 'env:KEYCLOAK_ADMIN_CLIENT_SECRET',
    authClientRef: 'env:AUTH_KEYCLOAK_SECRET',
    ncTarget: {},
    matrixSpace: {},
    domainProfile: {},
    brandRef: `config:${SLUG}`,
    blueprintRef: 'STURA_BLUEPRINT@1',
    connProfile: { perTenantMax: 2, prepare: true },
    backupKeyRef: 'env:AUTH_KEYCLOAK_SECRET',
    audiences: ['gremion-ui'],
  })
  const existing = await registry.listTenantDomains?.(tenant.id)
  const bound = Array.isArray(existing) && existing.some((d) => d.host === HOST)
  if (!bound) await registry.addTenantDomain(tenant.id, HOST, { isPrimary: true })
  console.log(`T041-BIND tenant=${tenant.id} slug=${SLUG} host=${HOST}`)
  process.exit(0)
} catch (err) {
  console.error('[bind-customer] failed:', err)
  process.exit(1)
}
