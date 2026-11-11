// @vitest-environment node
// Module Karenz (phase 2): the retained step fails closed for a catalogue id that neither registered a
// retention extractor nor declared (registerNoRetention) that it retains nothing. A shipped module that
// forgets the declaration is therefore not "fine": every switch-off of it fails the retained step, raises
// the critical alert, and day 30 can never finalize (the row stays `finalizing`, so the council can never
// switch the module back on). This guard makes the omission a CI failure instead of a tenant lock-out.
//
// Two views of the same rule, so neither can drift from the other:
//   runtime   every module that the default build overlays: after the generated server-init barrel has loaded,
//             hasRetentionDeclaration(id) is true.
//   source    every module with an in-process half (also the ones disabled by default, which the barrel does
//             not load): its register.server.ts calls registerNoRetention('<id>') or registerRetentionExtractor(...).
// The two lists of deliberate exceptions below fail closed ON PURPOSE and must stay accurate: an exempt id that
// gains a declaration is a stale exemption and fails here too.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HELD_BACK_CATALOGUE_IDS, SWITCHABLE_CATALOGUE_IDS } from '$lib/modules/catalogue-map'

// src/lib/server/module-karenz -> repository root
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')
const MODULES = join(REPO, 'modules')

/**
 * Catalogue ids that fail the retained step on purpose, with the reason. A disable of one of them stays
 * visibly stuck (alert, settings page) instead of deleting records the retention catalogue says must be kept.
 */
const FAILS_CLOSED_ON_PURPOSE: Readonly<Record<string, string>> = {
  finance: 'phase 3 extracts finance records by retention class (RC-FIN-BOOKS, RC-FIN-VOUCH, RC-FIN-CORR); until then a disable must not drop the books',
  handover: 'RC-HND-TRACK is a sealed copy kept for two years and no handover extractor exists yet; the module has no in-process half to register one',
}

const moduleIds = readdirSync(MODULES, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(MODULES, d.name, 'module.json')))
  .map((d) => d.name)
  .toSorted((a, b) => a.localeCompare(b))

const disabledFile: { disabled: { id: string }[] } = JSON.parse(readFileSync(join(MODULES, 'disabled.json'), 'utf8'))
const disabledByDefault: ReadonlySet<string> = new Set(disabledFile.disabled.map((e) => e.id))

const hasApp = (id: string) => existsSync(join(MODULES, id, 'app'))

function registerFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...registerFiles(p))
    else if (e.name === 'register.server.ts') out.push(p)
  }
  return out
}

/** True when the module's own register.server.ts files declare a retention decision for `id` (comments ignored). */
function declaredInSource(id: string): boolean {
  if (!hasApp(id)) return false
  return registerFiles(join(MODULES, id, 'app')).some((file) => {
    const code = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      .join('\n')
    return new RegExp(`^\\s*registerNoRetention\\(\\s*'${id}'\\s*\\)`, 'm').test(code) || /^\s*registerRetentionExtractor\(/m.test(code)
  })
}

describe('every module that can be switched off has an explicit retention decision', () => {
  it('finds the shipped modules and classifies every switchable and held-back id as one of them', () => {
    expect(moduleIds.length).toBeGreaterThan(0)
    for (const id of [...SWITCHABLE_CATALOGUE_IDS, ...Object.keys(HELD_BACK_CATALOGUE_IDS)]) {
      expect(moduleIds, `${id} is switchable or held back but has no modules/${id}/module.json`).toContain(id)
    }
  })

  it('declares retention in the source of every module with an in-process half (exceptions listed above)', () => {
    const missing = moduleIds.filter((id) => hasApp(id) && !(id in FAILS_CLOSED_ON_PURPOSE) && !declaredInSource(id))
    expect(missing, 'add registerNoRetention(<id>) or a retention extractor to the module register.server.ts').toEqual([])
  })

  it('declares retention at runtime for every module the default build loads, once the server-init barrel has run', async () => {
    await import('$lib/server/modules/server-init.generated')
    const { hasRetentionDeclaration } = await import('./retained/extractors')
    const loaded = moduleIds.filter((id) => hasApp(id) && !disabledByDefault.has(id))
    expect(loaded.length, 'the default build overlays at least one module').toBeGreaterThan(0)
    const missing = loaded.filter((id) => !(id in FAILS_CLOSED_ON_PURPOSE) && !hasRetentionDeclaration(id))
    expect(missing).toEqual([])
    // the source view and the runtime view agree for every loaded module
    for (const id of loaded) expect(declaredInSource(id), `${id}: source and runtime disagree`).toBe(hasRetentionDeclaration(id))
  })

  it('keeps the fail-closed exceptions accurate: each is a shipped module, has a reason, and still has no declaration', async () => {
    const { hasRetentionDeclaration } = await import('./retained/extractors')
    for (const [id, reason] of Object.entries(FAILS_CLOSED_ON_PURPOSE)) {
      expect(moduleIds, `${id} is exempt but is not a shipped module`).toContain(id)
      expect(reason.length).toBeGreaterThan(20)
      expect(declaredInSource(id), `${id} gained a declaration: remove the stale exemption`).toBe(false)
      expect(hasRetentionDeclaration(id), `${id} gained a declaration: remove the stale exemption`).toBe(false)
    }
  })
})
