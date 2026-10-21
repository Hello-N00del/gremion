// Prints, one per line, the kernel migration files a FRESH init skips when the
// given deselectable module is OFF and every other module is ON: the same
// computation db.ts does (disabledModuleMigrationFiles over the real registry).
// Used by fresh-init-proof.sh --module-off <id>. Usage:
//   node scripts/module-off-skips.mjs <moduleId>
// Exits 2 when the id is unknown or not toggleable (a proof that turns off a
// module that cannot be turned off would be vacuous), and 3 when the skip set
// contains a cross-cutting migration (003/004/034 must stay kernel-applied).
import { registerHooks } from 'node:module'
import { resolve as shimResolve, load as shimLoad } from './sveltekit-env-shim.mjs'

registerHooks({ resolve: shimResolve, load: shimLoad })

const id = process.argv[2]
const { MODULE_MANIFESTS } = await import('../src/lib/modules/registry.ts')
const { disabledModuleMigrationFiles } = await import('../src/lib/server/module-migrations.ts')
const { CROSS_CUTTING_MIGRATIONS } = await import('../src/lib/modules/migration-ownership.ts')

const m = MODULE_MANIFESTS.find((x) => x.id === id)
if (!m || !m.toggleable) {
  console.error(`module-off-skips: '${id}' is not a registered toggleable module`)
  process.exit(2)
}
const modules = Object.fromEntries(
  MODULE_MANIFESTS.filter((x) => x.toggleable).map((x) => [x.id, x.id !== id]),
)
const skips = [...disabledModuleMigrationFiles({ modules }, MODULE_MANIFESTS)].sort()
const bad = skips.filter((f) => f in CROSS_CUTTING_MIGRATIONS)
if (bad.length) {
  console.error(`module-off-skips: ${id} OFF would skip cross-cutting kernel migration(s) ${bad.join(', ')}`)
  process.exit(3)
}
for (const f of skips) console.log(f)
