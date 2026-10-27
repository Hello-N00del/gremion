// packages/member-import/src/validate.ts — validate a member list against a
// customer's bodies and a vertical's importable roles (brief Q4, Q6-Q8). PURE:
// the caller reads the bodies; nothing here touches a database or an account.
//
// A row is rejected, with a NAMED reason code, for: a missing name, a missing
// or malformed e-mail, a blank / unknown body, an unknown or non-importable
// role, or an e-mail that appears more than once in the same body (EVERY row of
// such a set is rejected, not only the later ones).
//
// The codes are the SCHEMA DB-IDT-IMPORTROW validation_result enum
// (missing_name, missing_email, malformed_email, duplicate_email_in_body,
// unknown_body, unknown_role), so 080-b can write idt.import_row without a
// mapping. Named deviation: `role_changed` (apply.ts) is an apply-time refusal
// of a found membership with another role, not a validation result; it is
// reported with outcome 'rejected' and has no enum value of its own.
// E-mail addresses are NEVER echoed in the report (GDPR Art. 5(1)(c)): a
// rejected row is named by its row number and name only.
import { createHash } from 'node:crypto'
import { parseList, type RawRow } from './csv.ts'
import { isPlausibleEmail, labelKey, normalizeEmail, normalizeName } from './normalize.ts'
import { importableRoles, type RolesDocument } from './roles.ts'

export const DEFAULT_ROLE = 'member'

export type RejectReason =
  | 'missing_name'
  | 'missing_email'
  | 'malformed_email'
  | 'unknown_body'
  | 'unknown_role'
  | 'duplicate_email_in_body'
  | 'role_changed'

export interface BodyRef {
  id: string
  name: string
}

export interface ValidateContext {
  bodies: readonly BodyRef[]
  roles: RolesDocument
}

export interface ValidRow {
  row: number
  name: string
  email: string
  bodyId: string
  role: string
}

export interface ReportRow {
  row: number
  name: string
  reason: RejectReason
}

export interface ValidationReport {
  status: 'validated' | 'rejected'
  /** sha256 of the normalised list: the operator reads it at validate and the apply must name it. */
  sha256: string
  total: number
  valid: ValidRow[]
  rejected: ReportRow[]
}

/** The order- and spelling-independent fingerprint of a list. */
export function listSha256(rows: readonly RawRow[], defaultRole = DEFAULT_ROLE): string {
  const canon = rows
    .map((r) => [normalizeName(r.name), normalizeEmail(r.email), labelKey(r.body), labelKey(r.role) || defaultRole])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex')
}

const pairKey = (c: { bodyId: string; email: string }) => `${c.bodyId}\u0000${c.email}`

export function validateRows(rows: readonly RawRow[], ctx: ValidateContext): ValidationReport {
  const byName = new Map<string, BodyRef[]>()
  for (const b of ctx.bodies) {
    const k = labelKey(b.name)
    byName.set(k, [...(byName.get(k) ?? []), b])
  }
  const roleKeys = new Set(importableRoles(ctx.roles).map((r) => r.key))
  const valid: ValidRow[] = []
  const rejected: ReportRow[] = []
  const candidates: ValidRow[] = []
  for (const r of rows) {
    const name = normalizeName(r.name)
    const reject = (reason: RejectReason) => rejected.push({ row: r.row, name, reason })
    const email = normalizeEmail(r.email)
    if (!name) {
      reject('missing_name')
      continue
    }
    if (!email) {
      reject('missing_email')
      continue
    }
    if (!isPlausibleEmail(email)) {
      reject('malformed_email')
      continue
    }
    // a blank body, an unknown body and an ambiguous body name (two bodies of
    // one spelling) all resolve to no single body: unknown_body
    const bodies = byName.get(labelKey(r.body)) ?? []
    if (bodies.length !== 1) {
      reject('unknown_body')
      continue
    }
    const role = labelKey(r.role) || DEFAULT_ROLE
    if (!roleKeys.has(role)) {
      reject('unknown_role')
      continue
    }
    candidates.push({ row: r.row, name, email, bodyId: bodies[0]!.id, role })
  }
  // an e-mail named more than once in one body is ambiguous about WHICH row is
  // meant (name, role): every row of the set is rejected
  const count = new Map<string, number>()
  for (const c of candidates) count.set(pairKey(c), (count.get(pairKey(c)) ?? 0) + 1)
  for (const c of candidates) {
    if ((count.get(pairKey(c)) ?? 0) > 1) rejected.push({ row: c.row, name: c.name, reason: 'duplicate_email_in_body' })
    else valid.push(c)
  }
  rejected.sort((x, y) => x.row - y.row)
  return {
    status: rejected.length === 0 ? 'validated' : 'rejected',
    sha256: listSha256(rows),
    total: rows.length,
    valid,
    rejected,
  }
}

/** Parse + validate in one step; a ListFormatError propagates (the whole list is unreadable). */
export function validateList(text: string, ctx: ValidateContext): ValidationReport {
  return validateRows(parseList(text), ctx)
}
