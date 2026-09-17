import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODULE_MANIFESTS } from './registry'
import { CROSS_CUTTING_MIGRATIONS } from './migration-ownership'
import { disabledModuleMigrationFiles } from '$lib/server/module-migrations'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'migrations')

/** Replicate db.ts:180-205's fresh-init file selection with the REAL registry. */
function applyList(offModuleId: string): string[] {
  const config = {
    modules: Object.fromEntries([
      ...MODULE_MANIFESTS.filter((m) => m.toggleable).map((m) => [m.id, m.id !== offModuleId]),
      [offModuleId, false],
    ]),
  } as { modules: Record<string, boolean> }
  const skips = disabledModuleMigrationFiles(config, MODULE_MANIFESTS)
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => !skips.has(f))
}

describe('cross-cutting kernel DDL survives a module-OFF fresh init', () => {
  it('calendar OFF still applies 003, and before 058 needs calendar_events', () => {
    const list = applyList('calendar')
    expect(list).toContain('003_calendar_schema.sql')
    expect(list.indexOf('003_calendar_schema.sql')).toBeLessThan(
      list.indexOf('058_public_reader_grants.sql'),
    )
  })

  it('elections OFF still applies 004, and before 010 ALTERs committee_elections', () => {
    const list = applyList('elections')
    expect(list).toContain('004_committee_elections.sql')
    expect(list.indexOf('004_committee_elections.sql')).toBeLessThan(
      list.indexOf('010_org_units.sql'),
    )
  })

  it('board OFF still applies 034, after the kernel tables its FKs reference', () => {
    const list = applyList('board')
    expect(list).toContain('034_deck_board.sql')
    // board.org_unit_id -> org_units(id) (010), card.protocol_action_item_id ->
    // protocol_action_items(id) (007). Both must be created first.
    expect(list.indexOf('007_protocols.sql')).toBeLessThan(list.indexOf('034_deck_board.sql'))
    expect(list.indexOf('010_org_units.sql')).toBeLessThan(list.indexOf('034_deck_board.sql'))
  })

  it('no registered module manifest claims a kernel-block migration', () => {
    const onDisk = new Set(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')))
    const offenders: string[] = []
    for (const m of MODULE_MANIFESTS) {
      for (const base of m.migrations ?? []) {
        const file = `${base}.sql`
        if (onDisk.has(file) && !(file in CROSS_CUTTING_MIGRATIONS)) {
          offenders.push(`${m.id} claims ${file}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
