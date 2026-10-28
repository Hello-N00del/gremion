import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'migrations')
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

/**
 * The kernel data-plane block after the port-back: the 22 files the carve left
 * plus the nine of spec B's migrations chapter §2. Spec B §1's census measured
 * 36 StuRa numbers absent from the kernel tree: 20 finance + 044/045 are module-
 * owned and carried by the modules holding repo, 046/047 are content, 050-052
 * are handover and ship nowhere (D-01), and the remaining nine are these.
 * B7-renumber-ranges-baseline renumbers this set to 0001-0199.
 */
export const KERNEL_BLOCK_BASENAMES = [
  '0001_governance_schema.sql', '0002_config_store.sql', '0003_calendar_schema.sql',
  '0004_committee_elections.sql', '0005_dev_seed.sql', '0006_full_seed.sql',
  '0007_protocols.sql', '0008_public_portal.sql', '0009_audit_log.sql',
  '0010_org_units.sql', '0011_org_units_dev_seed.sql',
  '0012_role_assignment_history_pseudonymize.sql', '0018_sub_org_type.sql',
  '0024_audit_log_composite_index.sql', '0033_org_unit_child_term.sql',
  '0034_deck_board.sql', '0037_provisioning_member_ops.sql',
  '0038_org_unit_kind_catalog.sql', '0039_caucus.sql', '0040_event_consumption.sql',
  '0041_protocol_resolution_global_nr_unique.sql',
  '0042_protocol_resolution_required_majority.sql', '0043_audit_log_hash_chain.sql',
  '0048_resolution_decided_at.sql', '0049_org_unit_event_outbox.sql',
  '0053_notification_read_marker.sql', '0054_resolution_adoption_mode.sql',
  '0055_resolution_challenges.sql', '0056_role_assignment_history_recalled.sql',
  '0057_fk_hot_filter_indexes.sql', '0058_public_reader_grants.sql',
  // F1-FIX-02-K: the first kernel-only data-plane file after the port-back
  // (the INV-1 chain anchor; claimed through scripts/migrations/register.mjs).
  '0059_audit_log_chain_anchor.sql',
  // TRD-196: the per-module erasure report (claimed through register.mjs).
  '0060_erasure_report.sql',
]

/** Module-owned or unshipped numbers that must never appear in the kernel block. */
const FOREIGN_BASENAMES = [
  '013_finance_schema.sql', '044_content_schema.sql', '045_content_publish.sql',
  '046_content_publish_ops.sql', '047_news_posts_content_origin.sql',
  '050_handover_schema.sql', '051_handover_event.sql', '052_handover_module_binding.sql',
]

describe('kernel data-plane migration block', () => {
  it('holds exactly the 33 kernel-block basenames', () => {
    const onDisk = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    expect(onDisk).toEqual([...KERNEL_BLOCK_BASENAMES].sort())
  })

  it('is 33 files', () => {
    expect(KERNEL_BLOCK_BASENAMES.length).toBe(33)
  })

  it('carries no module-owned or unshipped file', () => {
    const onDisk = new Set(readdirSync(MIGRATIONS_DIR))
    expect(FOREIGN_BASENAMES.filter((f) => onDisk.has(f))).toEqual([])
  })

  it('every basename is four digits (pad 4, TASK-029 register), an underscore and a name', () => {
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql'))) {
      expect(f).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/)
    }
  })
})

/** The nine data-plane basenames the 2026-09-15 port-back brought in. */
export const PORTED_BASENAMES = [
  '0003_calendar_schema.sql', '0034_deck_board.sql', '0049_org_unit_event_outbox.sql',
  '0053_notification_read_marker.sql', '0054_resolution_adoption_mode.sql',
  '0055_resolution_challenges.sql', '0056_role_assignment_history_recalled.sql',
  '0057_fk_hot_filter_indexes.sql', '0058_public_reader_grants.sql',
]

// A ported file that sorts BELOW the highest basename the pre-port-back kernel
// shipped is a BACK-FILL, and the README's own rule ("the next free number is
// current highest + 1, never a number reused from a gap") forbids one. Every
// database initialised before the port-back has already recorded that
// high-water mark in schema_migrations, so runMigrations() picks a back-filled
// file up out of order on the next boot: 0003_calendar_schema.sql:69,77
// REFERENCES committees(id), which 0010_org_units.sql:6 renamed to org_units, so
// it aborts, applyMigrationFile records nothing, and the boot wedges on every
// retry with an error naming a table nobody removed. Derived from the two sets
// rather than written down, so a future back-fill cannot slip in undeclared.
/**
 * Kernel files written AFTER the port-back, numbered above every ported one
 * through the TASK-029 register. They are neither pre-port-back nor ported, so
 * they must not move the pre-port-back high-water mark.
 */
export const POST_PORT_BACK_BASENAMES = ['0059_audit_log_chain_anchor.sql', '0060_erasure_report.sql']
const PRE_PORT_BACK_BASENAMES = KERNEL_BLOCK_BASENAMES.filter(
  (f) => !PORTED_BASENAMES.includes(f) && !POST_PORT_BACK_BASENAMES.includes(f),
)
export const PRE_PORT_BACK_HIGH_WATER = [...PRE_PORT_BACK_BASENAMES].sort().at(-1) as string
export const BACK_FILLED_BASENAMES = PORTED_BASENAMES.filter(
  (f) => f < PRE_PORT_BACK_HIGH_WATER,
).sort()

describe('numbers back-filled below the pre-port-back high-water mark', () => {
  it('is exactly 003 and 034, measured against 048', () => {
    expect(PRE_PORT_BACK_HIGH_WATER).toBe('0048_resolution_decided_at.sql')
    expect(BACK_FILLED_BASENAMES).toEqual(['0003_calendar_schema.sql', '0034_deck_board.sql'])
  })

  it('every post-port-back file is in the block and sorts above every earlier one (claimed, never back-filled)', () => {
    const earlier = KERNEL_BLOCK_BASENAMES.filter((f) => !POST_PORT_BACK_BASENAMES.includes(f)).sort()
    for (const f of POST_PORT_BACK_BASENAMES) {
      expect(KERNEL_BLOCK_BASENAMES).toContain(f)
      expect(f > earlier.at(-1)!, `${f} must sort above ${earlier.at(-1)}`).toBe(true)
    }
  })

  it('no file on disk sorts below the mark without being declared', () => {
    const onDisk = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
    const declared = new Set([...PRE_PORT_BACK_BASENAMES, ...BACK_FILLED_BASENAMES])
    expect(onDisk.filter((f) => f < PRE_PORT_BACK_HIGH_WATER && !declared.has(f))).toEqual([])
  })

  it('the provenance record names every back-filled file and the re-init it forces', () => {
    const doc = readFileSync(
      join(REPO_ROOT, 'docs', 'ops', 'migration-portback-2026-09-15.md'),
      'utf-8',
    )
    const i = doc.indexOf('## Back-filled numbers')
    expect(i, 'the provenance record has no "## Back-filled numbers" section').toBeGreaterThan(-1)
    const section = doc.slice(i)
    // the dated record names the files as ported (pad 3), before TASK-029's pad-4 renames
    const asRecorded = (f: string) => f.replace(/^0(\d{3}_)/, '$1')
    for (const f of BACK_FILLED_BASENAMES) expect(section).toContain(asRecorded(f))
    expect(section).toContain(asRecorded(PRE_PORT_BACK_HIGH_WATER))
    expect(section).toMatch(/down -v/)
    expect(section).toMatch(/re-initialis/i)
  })

  it('the migrations README flags the exception to its own numbering rule', () => {
    const readme = readFileSync(join(MIGRATIONS_DIR, 'README.md'), 'utf-8')
    const i = readme.indexOf('### Numbering: the gaps are inherited, not corruption')
    expect(i, 'the numbering section has been renamed').toBeGreaterThan(-1)
    const section = readme.slice(i, readme.indexOf('## What is here, what is not'))
    expect(section).toMatch(/back-fill/i)
    for (const f of BACK_FILLED_BASENAMES) expect(section).toContain(f)
    expect(section).toContain('migration-portback-2026-09-15.md')
  })
})
