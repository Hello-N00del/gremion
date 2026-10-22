// packages/member-import/src/validate.ts — validate a member list against a
// customer's bodies and a vertical's importable roles (brief Q4, Q6-Q8). PURE:
// the caller reads the bodies; nothing here touches a database or an account.
//
// A row is rejected, with a NAMED reason code, for: a missing name, a missing
// or implausible e-mail, a missing or unknown (or ambiguous) body, an unknown or
// non-importable role, or a second row for the same e-mail in the same body.
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
  | 'invalid_email'
  | 'missing_body'
  | 'unknown_body'
  | 'ambiguous_body'
  | 'unknown_role'
  | 'duplicate_in_body'
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

export function validateRows(rows: readonly RawRow[], ctx: ValidateContext): ValidationReport {
  const byName = new Map<string, BodyRef[]>()
  for (const b of ctx.bodies) {
    const k = labelKey(b.name)
    byName.set(k, [...(byName.get(k) ?? []), b])
  }
  const roleKeys = new Set(importableRoles(ctx.roles).map((r) => r.key))
  const valid: ValidRow[] = []
  const rejected: ReportRow[] = []
  const seen = new Set<string>()
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
      reject('invalid_email')
      continue
    }
    const bodyKey = labelKey(r.body)
    if (!bodyKey) {
      reject('missing_body')
      continue
    }
    const bodies = byName.get(bodyKey) ?? []
    if (bodies.length === 0) {
      reject('unknown_body')
      continue
    }
    if (bodies.length > 1) {
      reject('ambiguous_body')
      continue
    }
    const role = labelKey(r.role) || DEFAULT_ROLE
    if (!roleKeys.has(role)) {
      reject('unknown_role')
      continue
    }
    const pair = `${bodies[0]!.id}\u0000${email}`
    if (seen.has(pair)) {
      reject('duplicate_in_body')
      continue
    }
    seen.add(pair)
    valid.push({ row: r.row, name, email, bodyId: bodies[0]!.id, role })
  }
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
