// R29-Q20-RETENTION drift guard (operator decision R29-I24, 2026-10-01): the REAL
// modules/ tree, read the way `gremion-tenant init` reads it (gremion-ui
// scripts/tenant-provision.ts loadModules, i.e. loadModuleJsons: one entry per
// modules/<id> with a module.json), must plan to a full load and no undecided module. The five
// database-less modules carry the provisional default profiles; the six with a
// database carry their own declared ones.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PROVISIONAL_RETENTION_PROFILES, planCatalogueRows, type CatalogueModule } from '../src/catalogue-rows.ts'
import { loadModuleJsons } from '../src/module-tree.ts'

const MODULES = resolve(fileURLToPath(new URL('../../../modules', import.meta.url)))

interface TreeModule extends CatalogueModule {
  moduleJson: CatalogueModule['moduleJson'] & { runtime: { database: unknown } }
}

// Loaded through the SAME helper the tenant-provision CLI uses (R29-LOW-07 L5),
// so this guard sees the tree exactly the way `gremion-tenant init` does.
const tree = loadModuleJsons(MODULES) as unknown as TreeModule[]

/** The five database-less modules (section 2 of the brief; TASK-077 Q14 contexts). */
const PROVISIONAL = {
  elections: { profile: 'rp-ele-module-data', context: 'ele' },
  files: { profile: 'rp-fil-module-data', context: 'fil' },
  handover: { profile: 'rp-hnd-module-data', context: 'hnd' },
  messaging: { profile: 'rp-msg-module-data', context: 'msg' },
  votes: { profile: 'rp-gov-module-data', context: 'gov' },
} as const

/** The six with a database: their own runtime.export.retentionProfile. */
const DECLARED = {
  board: { profile: 'rp-brd-module-data', context: 'brd' },
  calendar: { profile: 'rp-cal-module-data', context: 'cal' },
  content: { profile: 'rp-pub-module-data', context: 'pub' },
  finance: { profile: 'rp-fin-module-data', context: 'fin' },
  publishing: { profile: 'rp-nws-module-data', context: 'nws' },
  vault: { profile: 'rp-pwd-module-data', context: 'pwd' },
} as const

describe('the real modules/ tree plans to a full catalogue load', () => {
  const plan = planCatalogueRows(tree)

  it('(a) every in-tree module is loaded and none is undecided', () => {
    expect(tree.length).toBeGreaterThan(0)
    expect(plan.undecided).toEqual([])
    expect(plan.load.map((r) => r.moduleKey)).toEqual(tree.map((m) => m.id).sort())
  })

  it('(b) the five database-less modules carry exactly the provisional profiles, flagged provisional', () => {
    for (const [id, want] of Object.entries(PROVISIONAL)) {
      expect(plan.load.find((r) => r.moduleKey === id), id).toMatchObject({ retentionProfile: want.profile, owningContext: want.context, provisional: true })
    }
  })

  it('(b) the six modules with a database carry their declared profiles, not provisional', () => {
    for (const [id, want] of Object.entries(DECLARED)) {
      expect(plan.load.find((r) => r.moduleKey === id), id).toMatchObject({ retentionProfile: want.profile, owningContext: want.context, provisional: false })
    }
    expect(Object.keys(DECLARED).length + Object.keys(PROVISIONAL).length).toBe(tree.length)
  })

  it('(c) the table keys are EXACTLY the in-tree modules whose runtime.export is null', () => {
    const noExport = tree.filter((m) => m.moduleJson.runtime.export === null).map((m) => m.id).sort()
    expect(Object.keys(PROVISIONAL_RETENTION_PROFILES).sort()).toEqual(noExport)
    expect(Object.keys(PROVISIONAL_RETENTION_PROFILES).sort()).toEqual(Object.keys(PROVISIONAL).sort())
  })
})
