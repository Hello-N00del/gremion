// src/lib/server/seed/seed-protocols.ts
// P0 demo protocol fixtures (behind SEED_DEMO_FIXTURES). Anchors every date on
// the seed-time clock so action-item due states (overdue / soon) stay faithful
// over time. Returns a map from the design action-item id (e.g. 'ai-247-1') to
// the real DB action-item id so seedBoardFixtures can wire the promoted cards
// (c-1 → ai-247-1, c-4 → ai-247-2) via card.protocol_action_item_id.
import {
  createProtocol,
  addActionItem,
  addResolution,
  nextGlobalNr,
  setProtocolStatus,
  listResolutions,
  updateResolution,
} from '../protocols/protocol-db'

/** ISO `YYYY-MM-DD` for today + `days`. */
function isoIn(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

export async function seedProtocols(
  orgUnitIds: ReadonlyMap<string, string>,
  userIds: ReadonlyMap<string, string>
): Promise<Map<string, string>> {
  const ou = (key: string): string => {
    const id = orgUnitIds.get(key)
    if (id === undefined) throw new Error(`seedProtocols: unknown org-unit key "${key}"`)
    return id
  }
  const user = (username: string): string => {
    const id = userIds.get(username)
    if (id === undefined) throw new Error(`seedProtocols: unknown user "${username}"`)
    return id
  }

  // design action-item id -> real DB action-item id
  const actionItemIds = new Map<string, string>()

  // ── Plenum Nr. 247 (Studierendenrat) ───────────────────────────────────
  const plenum = await createProtocol({
    committeeId: ou('studierendenrat'),
    meetingDate: isoIn(-2),
    location: 'HB-1.27',
    title: 'Plenum Nr. 247',
    createdBy: user('anna.berger'),
  })
  const plenumItems: Array<{ designId: string; text: string; assignee: string; due: string }> = [
    { designId: 'ai-247-1', text: 'Protokoll Plenum Nr. 247 finalisieren', assignee: 'anna.berger', due: isoIn(1) },
    { designId: 'ai-247-2', text: 'TOP Bühnentechnik Sommerfest vorbereiten', assignee: 'felix.weber', due: isoIn(3) },
    { designId: 'ai-247-3', text: 'Förderantrag Kulturcafé ans Plenum weiterleiten', assignee: 'hannes.bauer', due: isoIn(5) },
    { designId: 'ai-247-4', text: 'Wahlausschuss für Vorstandswahl benennen', assignee: 'ben.hoffmann', due: isoIn(8) },
  ]
  for (const item of plenumItems) {
    const created = await addActionItem(plenum.id, {
      text: item.text,
      assigneeKeycloakId: user(item.assignee),
      dueDate: item.due,
    })
    actionItemIds.set(item.designId, created.id)
  }
  const year = new Date(plenum.meeting_date).getFullYear()
  await addResolution(plenum.id, {
    text: 'Beschluss zur Kulturförderung',
    votesYes: 18,
    votesNo: 2,
    votesAbstain: 1,
    result: 'passed',
    requiredMajority: 'simple',
  })
  // The resolution above carries no global_nr until assigned one — give it the
  // committee's next register number for the meeting year.
  const resolutions = await listResolutions(plenum.id)
  if (resolutions[0]) {
    const globalNr = await nextGlobalNr(ou('studierendenrat'), year)
    await updateResolution(resolutions[0].id, { globalNr })
  }
  await setProtocolStatus(plenum.id, 'published')

  // ── Vorstand Nr. 58 (Vorstand) ─────────────────────────────────────────
  const vorstand = await createProtocol({
    committeeId: ou('vorstand'),
    meetingDate: isoIn(-9),
    title: 'Vorstand Nr. 58',
    createdBy: user('anna.berger'),
  })
  const vs58 = await addActionItem(vorstand.id, {
    text: 'Hochschulleitung zu Sommerfest einladen',
    assigneeKeycloakId: user('anna.berger'),
    dueDate: isoIn(11),
  })
  actionItemIds.set('ai-vs58-2', vs58.id)

  // ── Ref. Finanzen Nr. 12 (Referat Finanzen) ────────────────────────────
  const finanzen = await createProtocol({
    committeeId: ou('ref-finanzen'),
    meetingDate: isoIn(-4),
    title: 'Ref. Finanzen Nr. 12',
    createdBy: user('clara.wagner'),
  })
  const fi12 = await addActionItem(finanzen.id, {
    text: 'Reservenbeschluss für HHJ 2026 vorbereiten',
    assigneeKeycloakId: user('clara.wagner'),
    dueDate: isoIn(6),
  })
  actionItemIds.set('ai-fi12-1', fi12.id)

  return actionItemIds
}
