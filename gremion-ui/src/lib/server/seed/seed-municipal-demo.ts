// src/lib/server/seed/seed-municipal-demo.ts
//
// P2.3 (#202) — Component 3: municipal demo content (the "clickable showcase").
//
// The legacy demo seeders (seedProtocols / …) are hardcoded to StuRa org-unit
// keys (`studierendenrat`, `vorstand`, …) and usernames (`anna.berger`, …), so
// they THROW on any other vertical's blueprint. This seeder is the
// municipal-vertical equivalent: it is keyed on the MUNICIPAL blueprint's own
// keys (Hauptausschuss / councillor1) and seeds a minimal-but-believable set —
// one published Beschluss/protocol in an Ausschuss — so a fresh municipal tenant
// lands on real, clickable governance artifacts rather than a bare org shell
// (design Goal/Decision).
//
// Carve note: the calendar feature module is not part of the governance-only
// kernel, so the former demo calendar entry is omitted (calendarEvents is always
// 0 here); the protocol/Beschluss governance fixture is what remains.
//
// It is TOLERANT, not hardcoded-strict: a fixture whose org-unit/user key is
// absent in the resolved blueprint is SKIPPED (never throws), so the includeDemo
// path stays green for any municipal-shaped blueprint. Idempotent: it no-ops when
// a protocol of the same title already exists for the committee, so a reseed does
// not duplicate rows (mirrors the seed-board idempotency contract).
import { createProtocol, addResolution, setProtocolStatus } from '../protocols/protocol-db'
import { getDb } from '../db'

/** ISO `YYYY-MM-DD` for today + `days`. */
function isoIn(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

export interface MunicipalDemoReport {
  /** Protocols created (0 if the target Ausschuss/user keys were absent). */
  protocols: number
  /** Resolutions (Beschlüsse) created. */
  resolutions: number
  /** Calendar entries created — always 0 in the governance-only kernel (the
   *  calendar feature module is not part of the kernel). Kept on the report
   *  shape for backward compatibility with callers. */
  calendarEvents: number
}

export async function seedMunicipalDemo(
  orgUnitIds: ReadonlyMap<string, string>,
  userIds: ReadonlyMap<string, string>,
): Promise<MunicipalDemoReport> {
  const sql = getDb()
  const report: MunicipalDemoReport = { protocols: 0, resolutions: 0, calendarEvents: 0 }

  // The author: prefer a sitting councillor, fall back to the dev.admin superuser.
  const author = userIds.get('councillor1') ?? userIds.get('dev.admin')

  // ── one published Beschluss/protocol in the Hauptausschuss (an Ausschuss) ──
  const hauptausschuss = orgUnitIds.get('hauptausschuss')
  if (hauptausschuss !== undefined && author !== undefined) {
    const title = 'Sitzung des Hauptausschusses Nr. 1'
    const existing = await sql<{ id: string }[]>`
      SELECT id FROM protocols WHERE committee_id = ${hauptausschuss} AND title = ${title} LIMIT 1`
    if (existing.length === 0) {
      const protocol = await createProtocol({
        committeeId: hauptausschuss,
        meetingDate: isoIn(-7),
        location: 'Rathaus, Sitzungssaal',
        title,
        createdBy: author,
      })
      report.protocols++
      await addResolution(protocol.id, {
        text: 'Beschluss über die Sanierung des Bürgerhauses',
        votesYes: 7,
        votesNo: 2,
        votesAbstain: 1,
        result: 'passed',
        requiredMajority: 'simple',
      })
      report.resolutions++
      await setProtocolStatus(protocol.id, 'published')
    }
  }

  // Carve note: the demo calendar entry (a Gemeinderat session) is omitted in the
  // governance-only kernel — the calendar feature module is carved out — so
  // report.calendarEvents stays 0.

  return report
}
