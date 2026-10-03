// src/lib/server/seed/seed-board.ts
// WI-6 / P0 demo board fixtures (behind SEED_DEMO_FIXTURES). Idempotent: skips a
// board whose name already exists for the unit, so re-running runSeed() does
// not duplicate boards/cards. Boards/stacks/cards are keyed off org-unit KEYS
// (resolved via the seeder's idMap) — no hardcoded UUIDs. Card due dates anchor
// on the design reference date 2026-05-31: every due lands at
// today + (designDue − 2026-05-31), so overdue/soon/done states stay faithful
// over time. c-1/c-4 carry a protocol_action_item_id (promote-link) resolved
// from the design action-item ids the protocol seeder returns.
//
// R29-BOARD-STORE-S B6: every read and write goes through the BoardBackendPort
// (getBoardBackend() by default; precedent seed-newsletter.ts), so with
// BOARD_BACKEND=service the fixtures land in the tenant's OWN leaf database
// board_<slug> — before this, the seed wrote the KERNEL database even in service
// mode and the leaf showed an empty /tasks. The de-duplication read is the
// port's listing for the unit (archived boards included) plus a name match.
// runSeed calls this only when config.modules.board === true (Q3).
import { getBoardBackend, type BoardBackendPort } from '../board/backend'

/** The design's reference "today". Card dues are stored relative to this so the
 *  fixtures keep their overdue/soon/done relationship to the seed-time clock. */
const DESIGN_TODAY = new Date('2026-05-31T00:00:00Z')

/** Whole-day delta from DESIGN_TODAY to an ISO `YYYY-MM-DD` design date. */
function deltaDays(designDate: string): number {
  const target = new Date(`${designDate}T00:00:00Z`)
  return Math.round((target.getTime() - DESIGN_TODAY.getTime()) / 86_400_000)
}

/** ISO `YYYY-MM-DD` for today + `days`. */
function isoIn(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Resolve a card's stored due date from its design due, anchored on today. */
function dueFor(designDue: string): string {
  return isoIn(deltaDays(designDue))
}

interface CardSpec {
  stack: number
  title: string
  /** Assignee username (resolved via userIds) or null. */
  assignee?: string | null
  /** Design due date (YYYY-MM-DD) relative to DESIGN_TODAY, or null for no due. */
  designDue?: string | null
  /** Bare label string — NEVER 'Organisation'. */
  label?: string | null
  description?: string | null
  /** Design action-item id (e.g. 'ai-247-1') to wire as the promote-link. */
  promoteActionItemKey?: string
}

interface BoardSpec {
  orgUnitKey: string
  boardName: string
  archived?: boolean
  stacks: string[]
  cards: CardSpec[]
}

const SPECS: BoardSpec[] = [
  {
    orgUnitKey: 'studierendenrat',
    boardName: 'StuRa-Plenum',
    stacks: ['Offen', 'In Arbeit', 'Wartet', 'Erledigt'],
    cards: [
      { stack: 0, title: 'Protokoll Plenum Nr. 247 finalisieren', assignee: 'anna.berger', designDue: '2026-06-02', label: 'Sitzung', description: 'TOP 1–14 redigieren, dann zur Genehmigung einreichen.', promoteActionItemKey: 'ai-247-1' },
      { stack: 0, title: 'Raum HB-1.27 für Plenum 248 buchen', assignee: 'emma.fischer', designDue: '2026-06-10', label: 'Orga', description: 'Hybrid-Setup mit Element Call reservieren.' },
      { stack: 0, title: 'Datenschutzerklärung juristisch prüfen', assignee: 'anna.berger', designDue: '2026-07-01', label: 'Extern', description: 'Externe Kanzlei beauftragen.' },
      { stack: 1, title: 'TOP Bühnentechnik Sommerfest vorbereiten', assignee: 'felix.weber', designDue: '2026-06-04', label: 'Sitzung', description: 'Angebot Eventtechnik Wiethaus als Vorlage aufbereiten.', promoteActionItemKey: 'ai-247-2' },
      { stack: 3, title: 'Sitzungsvorlage Vorstand Nr. 58 versenden', assignee: 'ben.hoffmann', designDue: '2026-05-12', label: 'Sitzung', description: 'An alle Mitglieder, Frist 7 Tage.' },
    ],
  },
  {
    orgUnitKey: 'vorstand',
    boardName: 'Vorstand',
    stacks: ['Offen', 'In Arbeit', 'Erledigt'],
    cards: [
      { stack: 0, title: 'Kandidatur Vorstandswahl bestätigen', assignee: 'clara.wagner', designDue: '2026-05-26', label: 'Orga', description: 'Bestätigung für Helios-Wahl hel-vorstand-26.' },
      { stack: 0, title: 'Anwesenheitsliste Ref. Finanzen Nr. 12 nachtragen', assignee: 'clara.wagner', designDue: '2026-05-28', label: 'Sitzung', description: 'Zwei Nachmeldungen ergänzen.' },
      { stack: 1, title: 'Sommerfest-Termin mit Hochschule abstimmen', assignee: 'ben.hoffmann', designDue: '2026-06-08', label: 'Orga', description: 'Raumvergabe Campus-Innenhof anfragen.' },
    ],
  },
  {
    orgUnitKey: 'ref-finanzen',
    boardName: 'Referat Finanzen',
    stacks: ['Offen', 'In Arbeit', 'Wartet auf Freigabe', 'Erledigt'],
    cards: [
      { stack: 0, title: 'Beleg nachreichen — Druck Erstsemester-Hefte', assignee: 'emma.fischer', designDue: '2026-05-22', label: 'Dringend', description: 'B-2026-0003 fehlt zum Antrag exp-druck.' },
      { stack: 0, title: 'CSV-Kontoauszug April hochladen', assignee: 'clara.wagner', designDue: '2026-06-03', label: 'Finanzen', description: 'FinTS noch ausstehend — manueller Import für ba-giro.' },
      { stack: 1, title: 'KV-Erstprüfung: Kulturförderung Land', assignee: 'hannes.bauer', designDue: '2026-06-05', label: 'Finanzen', description: 'Antrag app-prj-kultur sachlich prüfen.' },
      { stack: 2, title: 'HV-Freigabe: Bühnentechnik Sommerfest', assignee: 'anna.berger', designDue: '2026-06-01', label: 'Finanzen', description: 'app-exp-bueh · 4.280 € — Endfreigabe ausstehend.' },
      { stack: 3, title: 'Projektabrechnung Erstifahrt abschließen', assignee: 'david.schulz', designDue: '2026-05-10', label: 'Finanzen', description: 'prj-erstifahrt — Belege vollständig.' },
    ],
  },
  {
    orgUnitKey: 'ref-oeffentlichkeit',
    boardName: 'Referat ÖA',
    stacks: ['Ideen', 'In Arbeit', 'Veröffentlicht'],
    cards: [
      { stack: 0, title: 'Instagram-Reel Sommerfest', assignee: 'emma.fischer', designDue: null, label: 'Öffentlichkeit', description: 'Teaser-Clip, 30 Sek.' },
      { stack: 1, title: 'Newsletter Mai gegenlesen', assignee: 'emma.fischer', designDue: '2026-06-02', label: 'Öffentlichkeit', description: 'nl-2026-05 vor Versand am 02.05.' },
    ],
  },
  {
    orgUnitKey: 'fs-informatik',
    boardName: 'FS Informatik',
    stacks: ['Offen', 'In Arbeit', 'Erledigt'],
    cards: [
      { stack: 1, title: 'Erstifahrt 2026 Programm finalisieren', assignee: 'david.schulz', designDue: '2026-06-15', label: 'Orga', description: 'Abendprogramm + Workshops planen.' },
    ],
  },
  {
    orgUnitKey: 'fs-informatik',
    boardName: 'Erstifahrt 2025',
    archived: true,
    stacks: [],
    cards: [],
  },
]

export async function seedBoardFixtures(
  orgUnitIds: ReadonlyMap<string, string>,
  userIds: ReadonlyMap<string, string>,
  actionItemIds: ReadonlyMap<string, string>,
  backend: BoardBackendPort = getBoardBackend()
): Promise<void> {
  const createdBy = userIds.get('dev.admin') ?? null
  for (const spec of SPECS) {
    const orgUnitId = orgUnitIds.get(spec.orgUnitKey)
    if (orgUnitId === undefined) continue
    const existing = await backend.listBoardsForOrgUnits([orgUnitId])
    if (existing.some((b) => b.name === spec.boardName)) continue
    // The board and its stacks in one create (one transaction in both backends).
    const { stacks } = await backend.createBoard({
      orgUnitId,
      name: spec.boardName,
      archived: spec.archived ?? false,
      stacks: [...spec.stacks],
    })
    const stackIds = [...stacks].sort((a, b) => a.sort_order - b.sort_order).map((s) => s.id)
    if (stackIds.length !== spec.stacks.length) {
      throw new Error(`seedBoardFixtures: board "${spec.boardName}" came back with ${stackIds.length} of ${spec.stacks.length} stacks`)
    }
    let order = 0
    for (const c of spec.cards) {
      const assignee = c.assignee == null ? null : userIds.get(c.assignee) ?? null
      const promoteId = c.promoteActionItemKey
        ? actionItemIds.get(c.promoteActionItemKey) ?? null
        : null
      await backend.createCard({
        stackId: stackIds[c.stack]!,
        title: c.title,
        description: c.description ?? null,
        assigneeKeycloakId: assignee,
        dueDate: c.designDue == null ? null : dueFor(c.designDue),
        label: c.label ?? null,
        order: order++,
        protocolActionItemId: promoteId,
        createdBy,
      })
    }
  }
}
