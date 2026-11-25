// org-unit-dependents.ts -- what still hangs on an org unit, and how to say so.
//
// Deleting an org unit is refused while records exist that the council would lose
// or that the database will not orphan. Every foreign key onto org_units is
// classified; delete.integration.test.ts reads pg_constraint and fails on one that
// is in neither list.
//
//   Refused while rows exist (named in the 409 text):
//     org_unit_members   the roster                    sub-groups (org_units.parent_id)
//     committee_elections                              protocols (minutes)
//     protocol_resolutions                             caucus (Fraktionen)
//     board (with its stacks and cards)                event_committees (calendar events)
//     role_assignments in status active or grace (live offices; an office does not need a roster row)
//     finance rows (the finance module's own answer, where finance is installed)
//   Goes with the unit (rows that belong to it and mean nothing without it):
//     committee_roles, with the ended role_assignments (expired, vacated) and the
//     role_assignment_history behind them, so a body whose offices changed over the years can
//     still be deleted once nothing is live,
//     committee_calendar_settings (colour), beschluss_register_settings, the provisioning
//     ledger and pending member operations, governance_membership_record (erasure
//     bookkeeping of the unit).
//
// Boards and events live in the kernel tables for a customer that never moved them and
// in the board/calendar module's own database for one that did. A module that is
// installed answers through its data provider ('board:org-unit-refs',
// 'calendar:org-unit-refs'), read where the rows really are. Only when no provider is
// registered does the kernel count its own tables. A provider that cannot answer makes
// the delete refuse (503): an unanswered question is never read as "none". The module
// answers are read before the delete transaction opens; the transaction locks the unit
// row and counts the kernel tables.
import type { SqlRunner } from '../db/tx'
import { getDataProvider } from '../modules/runtime-registry'

export interface OrgUnitDependents {
  readonly members: number
  readonly children: number
  readonly elections: number
  readonly protocols: number
  readonly resolutions: number
  readonly caucuses: number
  /** Live offices: role_assignments in status active or grace. */
  readonly offices: number
  readonly boards: number
  readonly events: number
  readonly finance: number
}

/** What the installed modules say about an org unit; null = no provider, the kernel tables decide. */
export interface ModuleRefCounts {
  readonly boards: number | null
  readonly events: number | null
  readonly finance: number
}

/** A module that is installed could not say what it holds for the unit. */
export class OrgUnitCheckUnavailable extends Error {
  constructor(readonly what: string) {
    super(`org unit dependents check unavailable: ${what}`)
    this.name = 'OrgUnitCheckUnavailable'
  }
}

type Refs = { referenced: boolean; counts: Record<string, number> }

async function ask(
  what: string, provider: ((id: string) => Promise<Refs>) | undefined, orgUnitId: string,
): Promise<Refs | null> {
  if (!provider) return null
  try {
    return await provider(orgUnitId)
  } catch {
    // The reason stays out of the answer and out of the log line: it can carry a tenant or host.
    throw new OrgUnitCheckUnavailable(what)
  }
}

function pick(refs: Refs | null, key: string): number | null {
  if (!refs) return null
  const n = refs.counts[key]
  if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return n
  return refs.referenced ? 1 : 0
}

/** Ask the installed modules. Cross-database, so it runs outside the row lock. */
export async function askModulesAboutOrgUnit(orgUnitId: string): Promise<ModuleRefCounts> {
  const [boards, events, finance] = await Promise.all([
    ask('Boards', getDataProvider('board:org-unit-refs'), orgUnitId),
    ask('Termine', getDataProvider('calendar:org-unit-refs'), orgUnitId),
    ask('Finanzdaten', getDataProvider('finance:org-unit-refs'), orgUnitId),
  ])
  const financeTotal = finance
    ? Object.values(finance.counts).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
    : 0
  return {
    boards: pick(boards, 'boards'),
    events: pick(events, 'events'),
    finance: finance && finance.referenced ? Math.max(financeTotal, 1) : 0,
  }
}

/** The counts for one unit, on the runner given (the delete route passes its locking transaction). */
export async function getOrgUnitDependents(
  sql: SqlRunner, orgUnitId: string, modules: ModuleRefCounts,
): Promise<OrgUnitDependents> {
  const rows = await sql<Array<Omit<OrgUnitDependents, 'finance'>>>`
    SELECT
      (SELECT count(*) FROM org_unit_members WHERE org_unit_id = ${orgUnitId})::int AS members,
      (SELECT count(*) FROM org_units WHERE parent_id = ${orgUnitId})::int AS children,
      (SELECT count(*) FROM committee_elections WHERE org_unit_id = ${orgUnitId})::int AS elections,
      (SELECT count(*) FROM protocols WHERE committee_id = ${orgUnitId})::int AS protocols,
      (SELECT count(*) FROM protocol_resolutions r JOIN protocols p ON p.id = r.protocol_id
         WHERE p.committee_id = ${orgUnitId})::int AS resolutions,
      (SELECT count(*) FROM caucus WHERE council_org_unit_id = ${orgUnitId})::int AS caucuses,
      (SELECT count(*) FROM role_assignments a JOIN committee_roles cr ON cr.id = a.role_id
         WHERE cr.org_unit_id = ${orgUnitId} AND a.status IN ('active', 'grace'))::int AS offices,
      (SELECT count(*) FROM board WHERE org_unit_id = ${orgUnitId})::int AS boards,
      (SELECT count(DISTINCT event_id) FROM event_committees WHERE committee_id = ${orgUnitId})::int AS events`
  const r = rows[0]
  return {
    members: r?.members ?? 0,
    children: r?.children ?? 0,
    elections: r?.elections ?? 0,
    protocols: r?.protocols ?? 0,
    resolutions: r?.resolutions ?? 0,
    caucuses: r?.caucuses ?? 0,
    offices: r?.offices ?? 0,
    // The module's own answer wins over the kernel table: a board that moved leaves a stale copy behind.
    boards: modules.boards ?? r?.boards ?? 0,
    events: modules.events ?? r?.events ?? 0,
    finance: modules.finance,
  }
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** The German 409 text naming what still hangs on the unit, or null when nothing does. */
export function describeOrgUnitDependents(d: OrgUnitDependents): string | null {
  const parts: string[] = []
  if (d.members > 0) parts.push(count(d.members, 'Mitglied', 'Mitglieder'))
  if (d.children > 0) parts.push(count(d.children, 'Untergruppe', 'Untergruppen'))
  if (d.elections > 0) parts.push(count(d.elections, 'Wahl', 'Wahlen'))
  if (d.protocols > 0) parts.push(count(d.protocols, 'Protokoll', 'Protokolle'))
  if (d.resolutions > 0) parts.push(count(d.resolutions, 'Beschluss', 'Beschlüsse'))
  if (d.caucuses > 0) parts.push(count(d.caucuses, 'Fraktion', 'Fraktionen'))
  if (d.offices > 0) parts.push(count(d.offices, 'laufendes Amt', 'laufende Ämter'))
  if (d.boards > 0) parts.push(count(d.boards, 'Board', 'Boards'))
  if (d.events > 0) parts.push(count(d.events, 'Termin', 'Termine'))
  if (d.finance > 0) parts.push(count(d.finance, 'Finanzeintrag', 'Finanzeinträge'))
  if (parts.length === 0) return null
  return `Das Gremium kann nicht gelöscht werden, solange noch Daten daran hängen: ${parts.join(', ')}.`
}

/** The text for a foreign-key refusal that no guard anticipated. */
export const ORG_UNIT_STILL_REFERENCED =
  'Das Gremium kann nicht gelöscht werden, solange noch andere Daten daran hängen.'

/** The 503 text when an installed module could not be asked. */
export function describeCheckUnavailable(what: string): string {
  return `Das Gremium wurde nicht gelöscht: ${what} konnten nicht geprüft werden, weil das zuständige Modul gerade nicht antwortet. Bitte später erneut versuchen.`
}

/** True for a PostgreSQL foreign-key violation (23503), however the driver wrapped it. */
export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23503'
}
