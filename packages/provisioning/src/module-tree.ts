// The one reader of the modules/ tree (R29-LOW-07 L5, Q20). The tenant-provision
// CLI (`gremion-tenant init`, gremion-ui/scripts/tenant-provision.ts) and the two
// provisioning tests that must see the catalogue exactly the way the CLI does
// (test/catalogue-rows.tree.test.ts, test/integration/platform.int.test.ts) all
// load it through this function instead of three inline copies of the rule.
//
// The rule is loadCatalogue's, minus its validation: one entry per modules/<id>
// directory that holds a module.json, ids in sorted order, the file JSON.parsed
// (a malformed file throws). The directory must exist; the CLI names a missing
// one itself before calling.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LifecycleModule } from '@gremion/tenant-store/lifecycle'

export function loadModuleJsons(modulesRoot: string): LifecycleModule[] {
  return readdirSync(modulesRoot)
    .sort()
    .filter((id) => existsSync(join(modulesRoot, id, 'module.json')))
    .map((id) => ({
      id,
      dir: join(modulesRoot, id),
      moduleJson: JSON.parse(readFileSync(join(modulesRoot, id, 'module.json'), 'utf-8')) as LifecycleModule['moduleJson'],
    }))
}
