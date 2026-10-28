// apps/control-panel/src/lib/server/requests.ts -- "Neuer Mandant" as a REQUEST
// (TASK-043d D2/D7/D8; replaces executor.ts, which spawned `gremion-tenant
// create`). The panel mutates nothing itself and runs nothing: it writes ONE
// row through plt.submit_provisioning_request (the only thing its database
// role may execute), carrying the operator's signed sign-in as evidence; the
// host-side executor claims it, re-verifies the evidence on the trusted layer
// and runs the create. The panel image holds neither docker nor gremion-tenant.
import type postgres from 'postgres'
import { accessWords } from './access-log'

export interface NewCustomerInput {
  slug: string
  host: string
  itAdmin: string
  councilAdmin: string
  bodyName: string
  brandProduct: string
  brandOrgShort: string
  enable: string[]
  /** Per enabled module: the operator's DPIA decision (TASK-044 D2); null: no explicit yes/no was given. */
  dpia: Record<string, { requiresDpia: boolean | null; documentRef: string }>
}

/** The operator's sign-in, as the executor re-verifies it (request-verify, D4). */
export interface Evidence {
  token: string
  acr: string
  /** The `auth_time` claim of the signed access token. */
  authTime: Date
  /** When the panel session was established (the code exchange). */
  sessionAt: Date
}

const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
// Mirror of @gremion/provisioning printable-text.ts (the panel image has no such
// dependency); requests.test.ts runs both over one corpus.
export const PRINTABLE = new RegExp(
  '^(?:[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ud800-\\udfff]|[\\ud800-\\udbff][\\udc00-\\udfff])+$',
)
const MODULE = /^[a-z][a-z0-9_]*$/
/** Mirror of @gremion/provisioning's RESERVED_SLUGS (slug.ts); requests.test.ts pins the two equal. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'platform', 'gremion', 'stura', 'keycloak', 'nextcloud', 'helios', 'postgres', 'control', 'template0', 'template1', 'public', 'cloud', 'matrix', 'elections', 'master',
])
const NON_ASCII = new RegExp('[^\\u0000-\\u007f]')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * Modules the gate refuses BY NAME, with the reason shown on the form. This is
 * the panel's copy of @gremion/provisioning's DENY_REASONS (the panel image
 * does not depend on that package); requests.test.ts pins the two equal, so a
 * change in the gate (TASK-058 lifts board) fails here until it is mirrored.
 * The executor's request-verify enforces the real list either way.
 */
export const DENY_REASONS: Readonly<Record<string, string>> = Object.freeze({
  board: 'board ist noch nicht mandantengetrennt und kann nicht aktiviert werden (R29-I1).',
  vault: 'vault (Tresor) bleibt im Pilotbetrieb abgeschaltet und kann nicht aktiviert werden (PRD-PLAT-012).',
})

/** True when `v` is 1 to `max` printable characters (not only blanks), as request-verify requires. */
function printable(v: string, max: number): boolean {
  return v.trim() !== '' && v.length <= max && PRINTABLE.test(v)
}

/** Validates the form and returns the field errors (empty: valid). */
export function validateNewCustomer(
  input: NewCustomerInput,
  deny: Readonly<Record<string, string>> = DENY_REASONS,
  /** The module ids the form offered (plt.module toggleable rows); null: not checked. */
  known: readonly string[] | null = null,
): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!SLUG.test(input.slug) || input.slug.length < 3 || input.slug.length > 30) {
    errors.slug = 'Kurzname: 3-30 Zeichen, a-z, 0-9 und einzelne Bindestriche, beginnend mit einem Buchstaben.'
  } else if (RESERVED_SLUGS.has(input.slug)) {
    errors.slug = `Kurzname „${input.slug}“ ist reserviert und kann nicht vergeben werden.`
  }
  if (NON_ASCII.test(input.host)) errors.host = 'Hostname nur in ASCII (a-z, 0-9, Punkt, Bindestrich); Umlaute und IDN-Namen sind im Pilotbetrieb nicht möglich, kein Punycode.'
  else if (!HOST.test(input.host.toLowerCase())) errors.host = 'Hostname in Kleinbuchstaben, z. B. rat.musterstadt.de.'
  if (!EMAIL.test(input.itAdmin.toLowerCase())) errors.itAdmin = 'E-Mail-Adresse der IT-Administration.'
  if (!EMAIL.test(input.councilAdmin.toLowerCase())) errors.councilAdmin = 'E-Mail-Adresse der Gremienverwaltung.'
  // the printable-character rule request-verify applies, so a bad value is refused HERE, not later
  if (input.bodyName !== '' && !printable(input.bodyName, 80)) errors.bodyName = 'Name des ersten Gremiums: höchstens 80 Zeichen, keine Steuerzeichen.'
  if (!printable(input.brandProduct, 80)) errors.brandProduct = 'Produktname der Marke: 1-80 Zeichen, keine Steuerzeichen.'
  if (!printable(input.brandOrgShort, 20)) errors.brandOrgShort = 'Kurzname der Organisation: 1-20 Zeichen, keine Steuerzeichen.'
  if (input.enable.some((m) => !MODULE.test(m))) errors.enable = 'Module als Kennungen, z. B. calendar.'
  else {
    const denied = input.enable.find((m) => m in deny)
    if (denied !== undefined) errors.enable = deny[denied]!
    else if (known !== null && input.enable.some((m) => !known.includes(m))) {
      errors.enable = `Unbekanntes Modul: ${[...new Set(input.enable)].filter((m) => !known.includes(m)).join(', ')}.`
    }
    else {
      const ids = [...new Set(input.enable)]
      // every ticked module carries an explicit ja/nein: an absent or unknown answer is never read as "nicht erforderlich"
      const unanswered = ids.filter((m) => typeof input.dpia[m]?.requiresDpia !== 'boolean')
      // brief Q3: a written decision (document reference) for EVERY ticked module, whatever the answer
      const missing = ids.filter((m) => (input.dpia[m]?.documentRef ?? '').trim() === '')
      if (unanswered.length > 0) errors.dpia = `DPIA-Entscheidung (erforderlich oder nicht erforderlich) fehlt: ${unanswered.join(', ')}.`
      else if (missing.length > 0) errors.dpia = `Dokumentverweis zur DPIA-Entscheidung fehlt: ${missing.join(', ')}.`
      else {
        // the same 500-character cap and printable rule request-verify applies (document_ref)
        const long = ids.filter((m) => input.dpia[m]!.documentRef.trim().length > 500)
        const bad = ids.filter((m) => !printable(input.dpia[m]!.documentRef, 500))
        if (long.length > 0) errors.dpia = `Dokumentverweis zur DPIA-Entscheidung: höchstens 500 Zeichen (${long.join(', ')}).`
        else if (bad.length > 0) errors.dpia = `Dokumentverweis zur DPIA-Entscheidung: keine Steuerzeichen (${bad.join(', ')}).`
      }
    }
  }
  return errors
}

/** The normalised `create` args exactly as request-verify (@gremion/provisioning requests.ts) accepts them. */
export function createArgs(input: NewCustomerInput): Record<string, unknown> {
  const enable = [...new Set(input.enable)].sort()
  const dpia: Record<string, unknown> = {}
  for (const id of enable) {
    const d = input.dpia[id]
    if (!d) continue
    dpia[id] = { requires_dpia: d.requiresDpia === true, reason_codes: ['operator_decision'], document_ref: d.documentRef.trim() === '' ? null : d.documentRef.trim() }
  }
  const args: Record<string, unknown> = {
    slug: input.slug,
    host: input.host.toLowerCase(),
    itAdmin: input.itAdmin.toLowerCase(),
    councilAdmin: input.councilAdmin.toLowerCase(),
    brand: { product: input.brandProduct, orgShort: input.brandOrgShort },
    enable,
    dpia,
  }
  if (input.bodyName !== '') args.bodyName = input.bodyName
  return args
}

/** A request the database refused, in the operator's words (SQLSTATE of submit_provisioning_request). */
export class SubmitRefused extends Error {
  readonly status: 400 | 403 | 409 | 503
  constructor(status: 400 | 403 | 409 | 503, message: string) {
    super(message)
    this.status = status
  }
}

/** Maps the SQLSTATE of a refused submit to a German message; anything else is a 503 with no detail. */
export function submitRefusal(err: unknown): SubmitRefused {
  const code = (err as { code?: string } | null)?.code
  switch (code) {
    case '28000':
      return new SubmitRefused(403, 'Die Anmeldung genügt nicht (loa2 und eine Anmeldung der letzten Stunde sind nötig). Bitte neu anmelden.')
    case '42501':
      return new SubmitRefused(403, 'Dieses Konto darf keine Mandanten anfordern.')
    case '23505':
      return new SubmitRefused(409, 'Dieser Schlüssel wurde schon für eine andere Anfrage benutzt. Bitte das Formular neu laden.')
    case '22023':
      return new SubmitRefused(400, 'Die Anfrage wurde von der Datenbank abgelehnt (ungültige Angaben).')
    default:
      return new SubmitRefused(503, 'Die Anfrage konnte nicht gespeichert werden (Plattform-Datenbank; Details im Panel-Log).')
  }
}

/**
 * Writes the create request. Returns the request id. The ONE statement the
 * panel's database role may run to change anything. A repeat with the same
 * key and the same content returns the same id and writes no second row.
 */
export async function submitCreate(sql: postgres.Sql, input: NewCustomerInput, operatorId: string, key: string, evidence: Evidence): Promise<string> {
  if (!UUID.test(operatorId)) throw new SubmitRefused(403, 'Die Operator-Kennung ist keine UUID.')
  if (!UUID.test(key)) throw new SubmitRefused(400, 'Der Formularschlüssel fehlt oder ist ungültig. Bitte das Formular neu laden.')
  try {
    // TRD-092: the access record and the request are ONE statement (no request without its record).
    const w = accessWords('create', input.slug, false)
    const rows = await sql<{ id: string }[]>`
      SELECT plt.submit_provisioning_request(
               'create', ${input.slug}, ${sql.json(createArgs(input) as never)}, ${key}::uuid, ${operatorId}::uuid,
               ${evidence.acr}, ${evidence.authTime}::timestamptz, ${evidence.sessionAt}::timestamptz, ${evidence.token},
               NULL, NULL)::text AS id
        FROM (SELECT oac.record_access(${input.slug}, ${w.action}, ${w.what}, ${w.why}, ${operatorId}, NULL)) AS access_record`
    return rows[0]!.id
  } catch (err) {
    throw submitRefusal(err)
  }
}

export interface ModuleChoice {
  id: string
  name: string
  /** Why it cannot be ticked (the gate's deny list), or null. */
  denied: string | null
}

/** The module checkboxes: plt.module's toggleable rows, the deny set shown disabled with its reason. */
export async function listModuleChoices(sql: postgres.Sql, deny: Readonly<Record<string, string>> = DENY_REASONS): Promise<ModuleChoice[]> {
  const rows = await sql<{ module_key: string; name: string }[]>`SELECT module_key, name FROM plt.module WHERE toggleable ORDER BY module_key`
  return rows.map((r) => ({ id: r.module_key, name: r.name, denied: deny[r.module_key] ?? null }))
}

/** Seconds since the executor's newest heartbeat, or null when there is none. */
export async function heartbeatAgeSeconds(sql: postgres.Sql): Promise<number | null> {
  const rows = await sql<{ age: number | null }[]>`SELECT extract(epoch FROM (now() - max(seen_at)))::float8 AS age FROM plt.executor_heartbeat`
  const age = rows[0]?.age
  return typeof age === 'number' && Number.isFinite(age) ? age : null
}
