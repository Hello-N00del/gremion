// packages/member-import/src/apply.ts — apply a VALIDATED member list through a
// target port (brief Q1: the legacy org_unit_members adapter first). The library
// owns the order and the idempotency; the port owns Keycloak and SQL.
//
//   1. preflight (read-only): a found membership whose type or voting flag
//      differs from the row's role is `role_changed` -- the whole list is
//      refused BEFORE any account is created;
//   2. one account per distinct e-mail (an invite mail per CREATED user only);
//   3. one membership per row; a present identical membership is `unchanged`;
//   4. the touched bodies are re-armed for the projection worker.
// A rerun over a completed import therefore creates nothing and mails nothing.
import { splitName } from './normalize.ts'
import type { Role, RolesDocument } from './roles.ts'
import type { ReportRow, ValidationReport, ValidRow } from './validate.ts'

export interface ExistingMembership {
  membershipType: string
  voting: boolean
}

export interface AccountResult {
  userId: string
  created: boolean
  /** An invite mail was sent by this call. */
  invited: boolean
}

export interface MemberImportTarget {
  /** The account with this normalised e-mail, or null. Read-only. */
  findUserId(email: string): Promise<string | null>
  membership(bodyId: string, userId: string): Promise<ExistingMembership | null>
  /** Idempotent: finds or creates the account; sends the invite for a created one only. */
  ensureAccount(a: { email: string; firstName: string; lastName: string; role: string }): Promise<AccountResult>
  addMembership(m: { bodyId: string; userId: string; role: Role }): Promise<void>
  /** Re-arm the projection rows of these bodies so the worker reconciles members. */
  rearm(bodyIds: readonly string[]): Promise<void>
}

export interface ImportCounts {
  /** rows that inserted a membership */
  created: number
  /** of those: rows whose account already existed */
  linked_existing: number
  unchanged: number
  rejected: number
  accounts_created: number
  invites_sent: number
}

export interface ImportResult {
  status: 'validated' | 'rejected' | 'applied' | 'failed'
  sha256: string
  counts: ImportCounts
  rows: ReportRow[]
}

export class ImportRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportRefused'
  }
}

const zero = (): ImportCounts => ({ created: 0, linked_existing: 0, unchanged: 0, rejected: 0, accounts_created: 0, invites_sent: 0 })

export function validationResult(report: ValidationReport): ImportResult {
  return {
    status: report.status,
    sha256: report.sha256,
    counts: { ...zero(), rejected: report.rejected.length },
    rows: report.rejected,
  }
}

function roleOf(doc: RolesDocument, key: string): Role {
  const r = doc.roles.find((x) => x.key === key)
  if (!r) throw new ImportRefused(`role ${key} is not in the vertical's role table`)
  return r
}

/**
 * Applies `report` (which must be `validated` and carry `expectSha256`).
 * Returns `rejected` (nothing written) when the preflight finds a role change.
 */
export async function applyImport(
  report: ValidationReport,
  roles: RolesDocument,
  target: MemberImportTarget,
  expectSha256: string,
): Promise<ImportResult> {
  if (report.status !== 'validated') throw new ImportRefused('apply is refused: the list does not validate')
  if (report.sha256 !== expectSha256) {
    throw new ImportRefused('apply is refused: the list is not the one that was validated (sha256 differs)')
  }
  // 1. preflight, read-only
  const known = new Map<string, string | null>()
  const lookup = async (email: string) => {
    if (!known.has(email)) known.set(email, await target.findUserId(email))
    return known.get(email)!
  }
  const rejected: ReportRow[] = []
  for (const row of report.valid) {
    const userId = await lookup(row.email)
    if (userId === null) continue
    const role = roleOf(roles, row.role)
    const have = await target.membership(row.bodyId, userId)
    if (have && (have.membershipType !== role.membership_type || have.voting !== role.voting)) {
      rejected.push({ row: row.row, name: row.name, reason: 'role_changed' })
    }
  }
  if (rejected.length) {
    return { status: 'rejected', sha256: report.sha256, counts: { ...zero(), rejected: rejected.length }, rows: rejected }
  }
  // 2 + 3. accounts, then memberships
  const counts = zero()
  const accounts = new Map<string, AccountResult>()
  const touched = new Set<string>()
  const account = async (row: ValidRow): Promise<{ acc: AccountResult; existed: boolean }> => {
    const prior = accounts.get(row.email)
    if (prior) return { acc: prior, existed: !prior.created }
    const wasKnown = (await lookup(row.email)) !== null
    const { firstName, lastName } = splitName(row.name)
    const acc = await target.ensureAccount({ email: row.email, firstName, lastName, role: row.role })
    accounts.set(row.email, acc)
    if (acc.created) counts.accounts_created++
    if (acc.invited) counts.invites_sent++
    return { acc, existed: wasKnown }
  }
  for (const row of report.valid) {
    const { acc, existed } = await account(row)
    const role = roleOf(roles, row.role)
    const have = await target.membership(row.bodyId, acc.userId)
    if (have) {
      counts.unchanged++
      continue
    }
    await target.addMembership({ bodyId: row.bodyId, userId: acc.userId, role })
    counts.created++
    if (existed) counts.linked_existing++
    touched.add(row.bodyId)
  }
  // 4. the projection
  if (touched.size) await target.rearm([...touched])
  return { status: 'applied', sha256: report.sha256, counts, rows: [] }
}

/** True when a result is a clean no-op rerun: nothing created, nobody mailed. */
export function isNoopRerun(r: ImportResult): boolean {
  return r.status === 'applied' && r.counts.created === 0 && r.counts.accounts_created === 0 && r.counts.invites_sent === 0 && r.counts.rejected === 0
}
