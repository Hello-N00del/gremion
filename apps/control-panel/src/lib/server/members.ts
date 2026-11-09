// The customer page's "Vertikale und Mitglieder" section (pilot creation path):
// the REQUESTS built from the operator's forms, seed_vertical and import_members
// (phase validate, then phase apply with the sha256 the validate reported), and
// what is read back from the validate request's events. The panel mutates
// nothing itself and holds no member data: the list travels IN the request row
// (the host purges it on any final state) and reaches the container on stdin.
//
// No member name, address or list content is ever put in an error text, an
// event, a log line or an access-record word here: the page names counts, row
// numbers (the handler's own lines), the sha256 and the size limits only.
import type postgres from 'postgres'
import { IMPORT_LIST_MAX_BYTES, IMPORT_PAYLOAD_MAX_BYTES, isKnownVertical, parseImportSummary, redactAddresses } from '../members'
import { moduleActionsOffered } from '../modules'
import { newestRequest, queueRequest, UUID } from './customer-request'
import { requestEvents, type EventLine } from './modules'
import { SubmitRefused, type Evidence } from './requests'

export type MemberKind = 'seed_vertical' | 'import_members'

/** The normalised args request-verify accepts, per kind (@gremion/provisioning requests.ts). */
export const memberArgs = {
  seed: (slug: string, vertical: string): Record<string, unknown> => ({ slug, vertical }),
  validate: (slug: string, vertical: string, csv: string): Record<string, unknown> => ({ slug, phase: 'validate', vertical, csv }),
  apply: (slug: string, vertical: string, csv: string, expectSha256: string): Record<string, unknown> => ({ slug, phase: 'apply', vertical, csv, expectSha256 }),
}

export type CsvList = { ok: true; csv: string } | { ok: false; status: 400 | 413; error: string }

const NOT_A_LIST = 'Bitte die Mitgliederliste als CSV-Datei wählen.'
/** The refusal of a list over the cap, also the answer when the server's body limit already stopped the upload. */
export const LIST_TOO_BIG = 'Die CSV-Datei ist größer als 1 MiB und wird nicht angenommen.'

/**
 * The uploaded member list as text, checked BEFORE a request is queued: a file part, not
 * empty, within the host's 1 MiB list cap and the database's 1.5 MiB payload cap (the
 * JSON form of the text is what is stored), UTF-8 without NUL. Every refusal text is fixed
 * wording: it never quotes the file.
 */
export async function readCsvList(form: FormData, key = 'list'): Promise<CsvList> {
  const f = form.get(key)
  if (typeof f !== 'object' || f === null || typeof (f as Blob).arrayBuffer !== 'function') return { ok: false, status: 400, error: NOT_A_LIST }
  const file = f as Blob
  if (file.size === 0) return { ok: false, status: 400, error: 'Die CSV-Datei ist leer.' }
  if (file.size > IMPORT_LIST_MAX_BYTES) return { ok: false, status: 413, error: LIST_TOO_BIG }
  let csv: string
  try {
    csv = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer())
  } catch {
    return { ok: false, status: 400, error: 'Die Datei ist kein UTF-8-Text. Bitte die Liste als CSV in UTF-8 speichern.' }
  }
  if (csv.includes('\u0000')) return { ok: false, status: 400, error: 'Die Datei enthält Nullzeichen und ist keine CSV-Liste.' }
  if (csv.trim() === '') return { ok: false, status: 400, error: 'Die CSV-Datei enthält keine Zeilen.' }
  // what is stored is the JSON text of the args: every quote and line break costs a second byte
  if (Buffer.byteLength(JSON.stringify(csv), 'utf8') + 1024 > IMPORT_PAYLOAD_MAX_BYTES) {
    return { ok: false, status: 413, error: 'Die CSV-Liste ist nach der Kodierung für eine Anfrage zu groß (Grenze 1,5 MiB).' }
  }
  return { ok: true, csv }
}

/** A validate that can be applied: the newest import request, succeeded, its summary read from its events. */
export interface ValidatedList {
  requestId: string
  vertical: string
  sha256: string
  // No counts: the validate verb writes nothing, so its created/linked/unchanged are always 0 and
  // showing them asked the operator to confirm numbers that carry no information. The real figures
  // come with the apply's own events.
}

export interface ImportState {
  validated: ValidatedList | null
  /** The events of the newest import request once it has ended (the handler's own lines, address-free, passed the address net). */
  events: EventLine[]
}

const EMPTY: ImportState = { validated: null, events: [] }

/**
 * The customer's NEWEST import_members request. Only a SUCCEEDED validate whose list validated is
 * offered for apply: an apply after it (the list is in), a failed or still running one, or a
 * validate that found rejected rows all end the offer. The host purges the list from the row but
 * keeps phase and vertical (platform 0010), which is what is read here.
 */
export async function loadImportState(sql: postgres.Sql, slug: string): Promise<ImportState> {
  const rows = await sql<{ id: string; state: string; phase: string | null; vertical: string | null }[]>`
    SELECT request_id::text AS id, state, args ->> 'phase' AS phase, args ->> 'vertical' AS vertical
      FROM plt.provisioning_request_status
     WHERE customer_slug = ${slug} AND kind = 'import_members'
     ORDER BY created_at DESC, request_id DESC LIMIT 1`
  const r = rows[0]
  if (!r || typeof r.id !== 'string' || r.state === 'queued' || r.state === 'running') return EMPTY
  const events = (await requestEvents(sql, r.id, 120)).map((e) => ({ level: e.level, step: e.step, message: redactAddresses(e.message) }))
  const summary = r.phase === 'validate' && r.state === 'succeeded' ? parseImportSummary(events) : null
  const validated =
    summary && summary.status === 'validated' && typeof r.vertical === 'string' && isKnownVertical(r.vertical)
      ? { requestId: r.id, vertical: r.vertical, sha256: summary.sha256 }
      : null
  return { validated, events }
}

const NOT_OFFERED = 'Vertikale und Mitgliederlisten können nur für einen aktiven Mandanten ohne laufende Anfrage angestoßen werden.'

/**
 * Queues seed_vertical or import_members. `status` is the customer's registry status (null: none).
 * Throws SubmitRefused 409 when the section is not offered in that state or another request of
 * the customer is queued or running (the same gate as the module actions).
 */
export async function submitMemberRequest(
  sql: postgres.Sql,
  kind: MemberKind,
  slug: string,
  status: string | null,
  args: Record<string, unknown>,
  operatorId: string,
  evidence: Evidence,
): Promise<string> {
  if (!UUID.test(operatorId)) throw new SubmitRefused(403, 'Die Operator-Kennung ist keine UUID.')
  if (!moduleActionsOffered(status, await newestRequest(sql, slug))) throw new SubmitRefused(409, NOT_OFFERED)
  return queueRequest(sql, kind, slug, args, operatorId, evidence)
}