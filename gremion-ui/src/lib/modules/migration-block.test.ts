import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'migrations')

/**
 * The kernel data-plane block after the port-back: the 22 files the carve left
 * plus the nine of spec B's migrations chapter §2. Spec B §1's census measured
 * 36 StuRa numbers absent from the kernel tree: 20 finance + 044/045 are module-
 * owned and carried by the modules holding repo, 046/047 are content, 050-052
 * are handover and ship nowhere (D-01), and the remaining nine are these.
 * B7-renumber-ranges-baseline renumbers this set to 0001-0199.
 */
export const KERNEL_BLOCK_BASENAMES = [
  '001_governance_schema.sql', '002_config_store.sql', '003_calendar_schema.sql',
  '004_committee_elections.sql', '005_dev_seed.sql', '006_full_seed.sql',
  '007_protocols.sql', '008_public_portal.sql', '009_audit_log.sql',
  '010_org_units.sql', '011_org_units_dev_seed.sql',
  '012_role_assignment_history_pseudonymize.sql', '018_sub_org_type.sql',
  '024_audit_log_composite_index.sql', '033_org_unit_child_term.sql',
  '034_deck_board.sql', '037_provisioning_member_ops.sql',
  '038_org_unit_kind_catalog.sql', '039_caucus.sql', '040_event_consumption.sql',
  '041_protocol_resolution_global_nr_unique.sql',
  '042_protocol_resolution_required_majority.sql', '043_audit_log_hash_chain.sql',
  '048_resolution_decided_at.sql', '049_org_unit_event_outbox.sql',
  '053_notification_read_marker.sql', '054_resolution_adoption_mode.sql',
  '055_resolution_challenges.sql', '056_role_assignment_history_recalled.sql',
  '057_fk_hot_filter_indexes.sql', '058_public_reader_grants.sql',
]

/** Module-owned or unshipped numbers that must never appear in the kernel block. */
const FOREIGN_BASENAMES = [
  '013_finance_schema.sql', '044_content_schema.sql', '045_content_publish.sql',
  '046_content_publish_ops.sql', '047_news_posts_content_origin.sql',
  '050_handover_schema.sql', '051_handover_event.sql', '052_handover_module_binding.sql',
]

describe('kernel data-plane migration block', () => {
  it('holds exactly the 31 kernel-block basenames', () => {
    const onDisk = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    expect(onDisk).toEqual([...KERNEL_BLOCK_BASENAMES].sort())
  })

  it('is 31 files', () => {
    expect(KERNEL_BLOCK_BASENAMES.length).toBe(31)
  })

  it('carries no module-owned or unshipped file', () => {
    const onDisk = new Set(readdirSync(MIGRATIONS_DIR))
    expect(FOREIGN_BASENAMES.filter((f) => onDisk.has(f))).toEqual([])
  })

  it('every basename is three digits, an underscore and a name', () => {
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql'))) {
      expect(f).toMatch(/^\d{3}_[a-z0-9_]+\.sql$/)
    }
  })
})
