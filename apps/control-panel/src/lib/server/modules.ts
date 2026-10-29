// The customer page's "Module" section (TRD-044, PRD-OPS-004): what is read
// (plt.module + plt.module_enablement, both in the panel role's reads) and the
// four REQUESTS built from the operator's form: enable_module, disable_module,
// record_dpia, reconcile. The panel mutates nothing itself; the DPIA rules are
// the create form's (an explicit ja/nein and a document reference for every
// decision, the same length and printable rules request-verify applies).
import type postgres from 'postgres'
import { moduleActionsOffered, type ModuleKind } from '../modules'
import { newestRequest, queueRequest, UUID } from './customer-request'
import { DENY_REASONS, PRINTABLE, SubmitRefused, type Evidence } from './requests'

export interface ModuleInfo {
  id: string
  name: string
}

export interface CustomerModules {
  enabled: ModuleInfo[]
  /** Toggleable and not enabled; `denied` is the gate's by-name refusal (board, vault), shown instead of a button. */
  available: (ModuleInfo & { denied: string | null })[]
}

/** The customer's enabled modules and the ones that could be enabled. */
export async function loadCustomerModules(sql: postgres.Sql, customerId: string, deny: Readonly<Record<string, string>> = DENY_REASONS): Promise<CustomerModules> {
  const rows = await sql<{ module_key: string; name: string; enabled: boolean }[]>`
    SELECT m.module_key, m.name, coalesce(e.state = 'enabled', false) AS enabled
      FROM plt.module m
      LEFT JOIN plt.module_enablement e ON e.module_id = m.module_id AND e.customer_id = ${customerId}::uuid
     WHERE m.toggleable
     ORDER BY m.module_key`
  return {
    enabled: rows.filter((r) => r.enabled).map((r) => ({ id: r.module_key, name: r.name })),
    available: rows.filter((r) => !r.enabled).map((r) => ({ id: r.module_key, name: r.name, denied: deny[r.module_key] ?? null })),
  }
}

export interface EventLine {
  level: string
  step: string
  message: string
}

/** The events of one request, oldest first (already redacted by the executor), at most `limit`. */
export async function requestEvents(sql: postgres.Sql, requestId: string, limit = 60): Promise<EventLine[]> {
  const rows = await sql<EventLine[]>`
    SELECT level, step, message FROM plt.provisioning_request_event
     WHERE request_id = ${requestId}::uuid ORDER BY at, event_id LIMIT ${limit}`
  return rows.map((r) => ({ level: r.level, step: r.step, message: r.message }))
}

export type DpiaForm = { ok: true; requiresDpia: boolean; documentRef: string } | { ok: false; error: string }

/** The create form's rule for one module: an explicit ja/nein, and a document reference whatever the answer. */
export function parseDpiaForm(answer: string, ref: string): DpiaForm {
  if (answer !== 'yes' && answer !== 'no') return { ok: false, error: 'DPIA-Entscheidung (erforderlich oder nicht erforderlich) fehlt.' }
  const documentRef = ref.trim()
  if (documentRef === '') return { ok: false, error: 'Dokumentverweis zur DPIA-Entscheidung fehlt.' }
  if (documentRef.length > 500) return { ok: false, error: 'Dokumentverweis zur DPIA-Entscheidung: höchstens 500 Zeichen.' }
  if (!PRINTABLE.test(documentRef)) return { ok: false, error: 'Dokumentverweis zur DPIA-Entscheidung: keine Steuerzeichen.' }
  if (documentRef.startsWith('-')) return { ok: false, error: 'Dokumentverweis zur DPIA-Entscheidung: darf nicht mit einem Bindestrich beginnen.' }
  return { ok: true, requiresDpia: answer === 'yes', documentRef }
}

/** The normalised args request-verify accepts, per kind (@gremion/provisioning requests.ts). */
export const moduleArgs = {
  enable: (slug: string, module: string, d: { requiresDpia: boolean; documentRef: string }): Record<string, unknown> => ({
    slug,
    module,
    dpia: { requires_dpia: d.requiresDpia, reason_codes: ['operator_decision'], document_ref: d.documentRef },
  }),
  disable: (slug: string, module: string): Record<string, unknown> => ({ slug, module }),
  recordDpia: (slug: string, module: string, d: { requiresDpia: boolean; documentRef: string }): Record<string, unknown> => ({
    slug,
    module,
    requiresDpia: d.requiresDpia,
    documentRef: d.documentRef,
  }),
  reconcile: (slug: string, apply: boolean): Record<string, unknown> => ({ slug, apply }),
}

const NOT_OFFERED = 'Module können nur für einen aktiven Mandanten ohne laufende Anfrage geändert werden.'

/**
 * Queues one of the four kinds. `status` is the customer's registry status (null:
 * none). Throws SubmitRefused 409 when the section is not offered in that state
 * or another request of the customer is queued or running.
 */
export async function submitModuleRequest(
  sql: postgres.Sql,
  kind: ModuleKind,
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
