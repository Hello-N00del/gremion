import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODULE_MANIFESTS } from './registry'
import {
  CROSS_CUTTING_MIGRATIONS,
  backFillNotice,
  crossCuttingViolations,
} from './migration-ownership'
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
  it('calendar OFF still applies 003, which still sorts before 058 in the kernel chain', () => {
    const list = applyList('calendar')
    expect(list).toContain('0003_calendar_schema.sql')
    expect(list.indexOf('0003_calendar_schema.sql')).toBeLessThan(
      list.indexOf('0058_public_reader_grants.sql'),
    )
  })

  it('elections OFF still applies 004, and before 010 ALTERs committee_elections', () => {
    const list = applyList('elections')
    expect(list).toContain('0004_committee_elections.sql')
    expect(list.indexOf('0004_committee_elections.sql')).toBeLessThan(
      list.indexOf('0010_org_units.sql'),
    )
  })

  it('board OFF still applies 034, after the kernel tables its FKs reference', () => {
    const list = applyList('board')
    expect(list).toContain('0034_deck_board.sql')
    // board.org_unit_id -> org_units(id) (010), card.protocol_action_item_id ->
    // protocol_action_items(id) (007). Both must be created first.
    expect(list.indexOf('0007_protocols.sql')).toBeLessThan(list.indexOf('0034_deck_board.sql'))
    expect(list.indexOf('0010_org_units.sql')).toBeLessThan(list.indexOf('0034_deck_board.sql'))
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
    expect(list()).toContain('0049_org_unit_event_outbox.sql')
  })

  it('053 ships (the notification read marker)', () => {
    expect(list()).toContain('0053_notification_read_marker.sql')
  })

  it('054 sorts after 007 and 042 — it ALTERs protocol_resolutions and re-adds 042s CHECK', () => {
    expect(at('0054_resolution_adoption_mode.sql')).toBeGreaterThan(at('0007_protocols.sql'))
    expect(at('0054_resolution_adoption_mode.sql')).toBeGreaterThan(
      at('0042_protocol_resolution_required_majority.sql'),
    )
  })

  it('056 sorts after 001 — it DROPs the inline CHECK 001 creates on role_assignment_history', () => {
    expect(at('0056_role_assignment_history_recalled.sql')).toBeGreaterThan(
      at('0001_governance_schema.sql'),
    )
  })

  it('057 sorts after 010 and guards its content-schema indexes on to_regclass', () => {
    expect(at('0057_fk_hot_filter_indexes.sql')).toBeGreaterThan(at('0010_org_units.sql'))
    const body = readFileSync(join(MIGRATIONS_DIR, '0057_fk_hot_filter_indexes.sql'), 'utf-8')
    expect(body).toMatch(/to_regclass\('content\.post_media'\)/)
    expect(body).toMatch(/to_regclass\('content\.post_recipients'\)/)
  })
})

// The chain was extended BELOW what an already-initialised database has
// applied (003 and 034 sit in gaps under the pre-port-back high-water mark
// 0048_resolution_decided_at.sql). runMigrations() applies in filename order but
// SELECTs the applied set, so such a file is picked up out of order on the next
// boot of an old database; 003 REFERENCES committees(id), renamed by 010, so it
// aborts with "relation committees does not exist" — an error that names a
// table nobody removed, on a boot that then wedges for good because
// applyMigrationFile is atomic and records nothing. The run is doomed either
// way; what this adds is the diagnosis, printed BEFORE the abort.
describe('backFillNotice', () => {
  const CHAIN = [
    '0001_governance_schema.sql', '0003_calendar_schema.sql', '0010_org_units.sql',
    '0034_deck_board.sql', '0048_resolution_decided_at.sql', '0049_org_unit_event_outbox.sql',
  ]
  const OLD_DB = new Set([
    '0001_governance_schema.sql', '0010_org_units.sql', '0048_resolution_decided_at.sql',
  ])

  it('says nothing on a fresh database — sort order makes every file apply in order', () => {
    expect(backFillNotice({ applied: new Set(), candidates: CHAIN })).toBeNull()
  })

  it('says nothing when every unapplied file sorts above the high-water mark', () => {
    expect(
      backFillNotice({ applied: OLD_DB, candidates: CHAIN.filter((f) => f >= '049') }),
    ).toBeNull()
  })

  it('names every back-filled file, the mark it sits under, and the remedy', () => {
    const notice = backFillNotice({ applied: OLD_DB, candidates: CHAIN })
    expect(notice).not.toBeNull()
    expect(notice).toContain('0003_calendar_schema.sql')
    expect(notice).toContain('0034_deck_board.sql')
    expect(notice).not.toContain('0049_org_unit_event_outbox.sql')
    expect(notice).toContain('0048_resolution_decided_at.sql')
    expect(notice).toMatch(/down -v/)
    expect(notice).toContain('docs/ops/migration-portback-2026-09-15.md')
  })

  it('does not cry back-fill over a module OFF->ON catch-up, whose gaps are expected', () => {
    expect(
      backFillNotice({
        applied: OLD_DB,
        candidates: CHAIN,
        expected: new Set(['0003_calendar_schema.sql', '0034_deck_board.sql']),
      }),
    ).toBeNull()
  })
})

describe('F6 guard: calendar_events (003), committee_elections (004), deck_board (034) stay kernel-applied', () => {
  const kernelFiles = () =>
    new Set(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')))

  it('the cross-cutting set is exactly 003/004/034', () => {
    expect(Object.keys(CROSS_CUTTING_MIGRATIONS).sort()).toEqual([
      '0003_calendar_schema.sql',
      '0004_committee_elections.sql',
      '0034_deck_board.sql',
    ])
  })

  it('the real registry and migrations directory have no violation', () => {
    expect(crossCuttingViolations(MODULE_MANIFESTS, kernelFiles())).toEqual([])
  })

  it.each(Object.keys(CROSS_CUTTING_MIGRATIONS))(
    'a manifest claiming %s fails loudly, naming the reason',
    (file) => {
      const base = file.replace(/\.sql$/, '')
      const msgs = crossCuttingViolations(
        [...MODULE_MANIFESTS, { id: 'rogue', migrations: [base] }],
        kernelFiles(),
      )
      expect(msgs).toHaveLength(1)
      expect(msgs[0]).toContain("module 'rogue' claims " + file)
      expect(msgs[0]).toContain('must stay KERNEL-applied')
      expect(msgs[0]).toContain('0010 ALTERs committee_elections')
    },
  )

  it.each(Object.keys(CROSS_CUTTING_MIGRATIONS))(
    'moving %s out of the kernel directory fails loudly',
    (file) => {
      const without = kernelFiles()
      without.delete(file)
      const msgs = crossCuttingViolations(MODULE_MANIFESTS, without)
      expect(msgs).toHaveLength(1)
      expect(msgs[0]).toContain(file + ' is not in the kernel migrations directory')
    },
  )

  it('the real manifests of calendar, elections and board carry no migrations key entry for them', () => {
    for (const id of ['calendar', 'elections', 'board']) {
      const m = MODULE_MANIFESTS.find((x) => x.id === id)
      expect(m, `manifest ${id} registered`).toBeDefined()
      for (const base of m!.migrations ?? []) {
        expect(`${base}.sql` in CROSS_CUTTING_MIGRATIONS).toBe(false)
      }
    }
  })
})
