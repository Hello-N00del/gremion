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

describe('the five unclaimed kernel migrations and their order constraints', () => {
  const list = () => readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  const at = (f: string) => list().indexOf(f)

  it('049 ships (the org-unit outbox table)', () => {
    expect(list()).toContain('049_org_unit_event_outbox.sql')
  })

  it('053 ships (the notification read marker)', () => {
    expect(list()).toContain('053_notification_read_marker.sql')
  })

  it('054 sorts after 007 and 042 — it ALTERs protocol_resolutions and re-adds 042s CHECK', () => {
    expect(at('054_resolution_adoption_mode.sql')).toBeGreaterThan(at('007_protocols.sql'))
    expect(at('054_resolution_adoption_mode.sql')).toBeGreaterThan(
      at('042_protocol_resolution_required_majority.sql'),
    )
  })

  it('056 sorts after 001 — it DROPs the inline CHECK 001 creates on role_assignment_history', () => {
    expect(at('056_role_assignment_history_recalled.sql')).toBeGreaterThan(
      at('001_governance_schema.sql'),
    )
  })

  it('057 sorts after 010 and guards its content-schema indexes on to_regclass', () => {
    expect(at('057_fk_hot_filter_indexes.sql')).toBeGreaterThan(at('010_org_units.sql'))
    const body = readFileSync(join(MIGRATIONS_DIR, '057_fk_hot_filter_indexes.sql'), 'utf-8')
    expect(body).toMatch(/to_regclass\('content\.post_media'\)/)
    expect(body).toMatch(/to_regclass\('content\.post_recipients'\)/)
  })
})
