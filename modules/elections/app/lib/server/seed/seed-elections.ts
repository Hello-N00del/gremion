// src/lib/server/seed/seed-elections.ts
// P0 demo election fixtures (behind SEED_DEMO_FIXTURES). Both rows are seeded
// NON-archived (archived_at stays null) so both stay visible on /votes and in
// the badge. The /votes loader renders these by keying off helios_uuid and
// degrades gracefully when the Helios backend is unreachable (WP-1b's
// HeliosClient graceful-degrade contract).
import { ElectionDb } from '../elections/election-db'

export async function seedElections(
  orgUnitIds: ReadonlyMap<string, string>,
  userIds: ReadonlyMap<string, string>
): Promise<number> {
  const orgUnitId = orgUnitIds.get('studierendenrat')
  if (orgUnitId === undefined) throw new Error('seedElections: unknown org-unit key "studierendenrat"')
  const createdBy = userIds.get('anna.berger')
  if (createdBy === undefined) throw new Error('seedElections: unknown user "anna.berger"')

  const fixtures: Array<{ heliosUuid: string; calendarLinked: boolean }> = [
    { heliosUuid: 'hel-vorstand-26', calendarLinked: true },
    { heliosUuid: 'hel-fs-inf-2025', calendarLinked: false },
  ]

  let count = 0
  for (const f of fixtures) {
    await ElectionDb.insert({
      heliosUuid: f.heliosUuid,
      orgUnitId,
      createdBy,
      calendarLinked: f.calendarLinked,
    })
    count++
  }
  return count
}
