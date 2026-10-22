// apps/control-panel/src/lib/server/requests.ts -- "Neuer Mandant" as a REQUEST
// (TASK-043d D2/D7/D8; replaces executor.ts, which spawned `gremion-tenant
// create`). The panel mutates nothing itself and runs nothing: it writes ONE
// row through plt.submit_provisioning_request (the only thing its database
// role may execute), carrying the operator's signed sign-in as evidence; the
// host-side executor claims it, re-verifies the evidence on the trusted layer
// and runs the create. The panel image holds neither docker nor gremion-tenant.
import type postgres from 'postgres'

export interface NewCustomerInput {
  slug: string
  host: string
  itAdmin: string
  councilAdmin: string
  bodyName: string
  brandProduct: string
  brandOrgShort: string
  enable: string[]
  /** Per enabled module: the operator's DPIA decision (TASK-044 D2). */
  dpia: Record<string, { requiresDpia: boolean; documentRef: string }>
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
const MODULE = /^[a-z][a-z0-9_]*$/
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

/** Validates the form and returns the field errors (empty: valid). */
export function validateNewCustomer(input: NewCustomerInput, deny: Readonly<Record<string, string>> = DENY_REASONS): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!SLUG.test(input.slug) || input.slug.length < 3 || input.slug.length > 30 || input.slug === 'platform') {
    errors.slug = 'Kurzname: 3-30 Zeichen, a-z, 0-9 und einzelne Bindestriche, beginnend mit einem Buchstaben; nicht "platform".'
  }
  if (!HOST.test(input.host.toLowerCase())) errors.host = 'Hostname in Kleinbuchstaben, z. B. rat.musterstadt.de.'
  if (!EMAIL.test(input.itAdmin.toLowerCase())) errors.itAdmin = 'E-Mail-Adresse der IT-Administration.'
  if (!EMAIL.test(input.councilAdmin.toLowerCase())) errors.councilAdmin = 'E-Mail-Adresse der Gremienverwaltung.'
  if (input.bodyName.length > 80) errors.bodyName = 'Name des ersten Gremiums: höchstens 80 Zeichen.'
  if (input.brandProduct.length < 1 || input.brandProduct.length > 80) errors.brandProduct = 'Produktname der Marke: 1-80 Zeichen.'
  if (input.brandOrgShort.length < 1 || input.brandOrgShort.length > 20) errors.brandOrgShort = 'Kurzname der Organisation: 1-20 Zeichen.'
  if (input.enable.some((m) => !MODULE.test(m))) errors.enable = 'Module als Kennungen, z. B. calendar.'
  else {
    const denied = input.enable.find((m) => m in deny)
    if (denied !== undefined) errors.enable = deny[denied]!
    else {
      // brief Q3: a written decision (document reference) for EVERY ticked module
      const missing = [...new Set(input.enable)].filter((m) => (input.dpia[m]?.documentRef ?? '').trim() === '')
      if (missing.length > 0) errors.dpia = `Dokumentverweis zur DPIA-Entscheidung fehlt: ${missing.join(', ')}.`
      else {
        // the same 500-character cap request-verify applies (document_ref)
        const long = [...new Set(input.enable)].filter((m) => (input.dpia[m]?.documentRef ?? '').trim().length > 500)
        if (long.length > 0) errors.dpia = `Dokumentverweis zur DPIA-Entscheidung: h�chstens 500 Zeichen (${long.join(', ')}).`
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
    dpia[id] = { requires_dpia: d.requiresDpia, reason_codes: ['operator_decision'], document_ref: d.documentRef.trim() === '' ? null : d.documentRef.trim() }
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
    const rows = await sql<{ id: string }[]>`
      SELECT plt.submit_provisioning_request(
               'create', ${input.slug}, ${sql.json(createArgs(input) as never)}, ${key}::uuid, ${operatorId}::uuid,
               ${evidence.acr}, ${evidence.authTime}::timestamptz, ${evidence.sessionAt}::timestamptz, ${evidence.token},
               NULL, NULL)::text AS id`
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
