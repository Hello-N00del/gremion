// services/finance/src/store/index.ts
//
// The finance leaf's table catalog — the single source of truth for the
// id-preserving backfill (scripts/backfill.ts) and the copy/verify order. It
// describes the `finance` schema authored in migrations/001_finance_init.sql:
// every table, its column list (insert order), and which columns need special
// coercion (timestamptz → ISO-Z, DATE → YYYY-MM-DD, JSONB re-serialize, TEXT[]).
//
// Post-cutover this module ALSO carries the finance leaf's FULL live store
// surface — the read + write domain ops the /api/v1/* handlers dispatch to:
// fiscal_year, bank_account, FinTS status, receipt read + binary WRITE (the
// expense_attachment bytes ride the injected StorageBackend), expense
// read/write, pending-approval, budget / statement / booking reads, project
// state-machine + CRUD, and sub-org reads + sub_org_type catalog writes —
// alongside the #369 sub-org saga ops. All 52 LIVE ops run against the leaf's own `finance` schema — the
// year-end closeBudget (FIN-52) was the last kernel-coupling residual, now ported
// LEAF-LOCAL (see http/routes.ts LIVE_OPS; KERNEL_COUPLING_EXCEPTIONS is now empty).

import { randomUUID } from 'node:crypto'
import type { Sql } from '../tenant-store.js'
import type { StorageBackend } from '../storage/index.js'

/** The Postgres schema every finance table lives under. */
export const FINANCE_SCHEMA = 'finance'

/**
 * Copy order — FK-safe (parents before children). Self-referencing tables
 * (budget_plan.parent_plan_id, booking.supersedes) are copied ORDER BY id
 * ascending, so a parent (lower id) always precedes its child.
 */
export const COPY_ORDER = [
  'finanzordnung_profile',
  'finance_helios_settings',
  'reserve',
  'cash_audit',
  'finance_unit',
  'bank_account',
  'fiscal_year',
  'ledger_account',
  'bank_transaction',
  'fints_config',
  'csv_import_profile',
  'budget_plan',
  'budget_section',
  'budget_group',
  'budget_titel',
  'project',
  'expense',
  'receipt',
  'receipt_item',
  'expense_attachment',
  'booking_running_no_head',
  'booking',
  'payment_order',
  'approval',
  'approval_stage',
  'inventory_item',
  'discharge',
  'comment',
  'reconciliation',
] as const

export type FinanceTable = (typeof COPY_ORDER)[number]

/** All tables whose row counts the backfill verify gate compares. */
export const ALL_TABLES = COPY_ORDER

/**
 * Tables carrying a BIGINT GENERATED ALWAYS AS IDENTITY `id` column. Every
 * finance table EXCEPT booking_running_no_head (composite PK, no id) is one, so
 * the backfill inserts with OVERRIDING SYSTEM VALUE + setval to preserve ids.
 */
export const IDENTITY_TABLES: readonly FinanceTable[] = COPY_ORDER.filter(
  (t) => t !== 'booking_running_no_head',
)

/** Column list per table, in INSERT order. Mirrors 001_finance_init.sql. */
export const COLUMNS: Record<FinanceTable, string[]> = {
  finanzordnung_profile: [
    'id', 'bundesland', 'deckungsfaehigkeit_pct', 'reserve_base',
    'reserve_frei_amount_cents', 'reserve_frei_bound', 'reserve_betriebsmittel_amount_cents',
    'reserve_betriebsmittel_bound', 'reserve_zweckgebunden_amount_cents', 'reserve_zweckgebunden_bound',
    'carry_over_central', 'carry_over_fachschaft', 'retention_years', 'retention_from',
    'inventar_threshold_cents', 'handkasse_cap_cents', 'majority_haushalt', 'majority_nachtrag',
    'majority_entlastung', 'signer_stages', 'decision_authority_tiers', 'created_at', 'updated_at',
  ],
  finance_helios_settings: [
    'id', 'enabled', 'voting_period_days', 'quorum_pct', 'required_majority', 'binding',
    'created_at', 'updated_at',
  ],
  reserve: ['id', 'type', 'name', 'amount_cents', 'cap_cents', 'created_at'],
  cash_audit: ['id', 'audit_date', 'auditor', 'scope', 'result', 'report_ref', 'created_at'],
  finance_unit: ['id', 'org_unit_id', 'kind', 'bookkeeping_mode', 'carry_over_rule', 'created_at'],
  bank_account: [
    'id', 'name', 'iban', 'current_balance_cents', 'last_sync_at', 'fints_state', 'created_at',
  ],
  fiscal_year: ['id', 'name', 'start_date', 'end_date', 'created_at'],
  ledger_account: ['id', 'finance_unit_id', 'bank_account_id', 'type', 'name', 'created_at'],
  bank_transaction: [
    'id', 'bank_account_id', 'booking_date', 'valuta_date', 'counterparty_name',
    'counterparty_iban', 'amount_cents', 'saldo_cents', 'purpose', 'bank_reference',
    'import_hash', 'allocated_ledger_account_id', 'imported_at',
  ],
  fints_config: [
    'id', 'bank_account_id', 'fints_url', 'bank_code', 'username', 'password_encrypted',
    'last_sync_at', 'last_sync_status', 'last_sync_error', 'created_at',
  ],
  csv_import_profile: [
    'id', 'bank_account_id', 'name', 'column_mapping', 'separator', 'date_format', 'created_at',
  ],
  budget_plan: [
    'id', 'fiscal_year_id', 'name', 'state', 'parent_plan_id', 'statement', 'closed_at',
    'approved_by', 'approved_at', 'activated_by', 'activated_at', 'created_at',
  ],
  budget_section: [
    'id', 'budget_plan_id', 'finance_unit_id', 'preparation_state', 'created_at',
  ],
  budget_group: ['id', 'budget_section_id', 'name', 'budget_type', 'created_at'],
  budget_titel: [
    'id', 'budget_group_id', 'titel_nr', 'titel_name', 'planned_cents', 'deckungsfaehig',
    'deckungs_group', 'created_at',
  ],
  project: [
    'id', 'org_unit_id', 'type', 'name', 'state', 'responsible', 'description', 'date_start',
    'date_end', 'created_at',
  ],
  expense: [
    'id', 'finance_unit_id', 'project_id', 'payee_name', 'payee_iban', 'payee_purpose',
    'payment_method', 'state', 'paid_at', 'created_at',
  ],
  receipt: ['id', 'expense_id', 'beleg_nr', 'beleg_date', 'description', 'created_at'],
  receipt_item: ['id', 'receipt_id', 'budget_titel_id', 'amount_cents', 'created_at'],
  expense_attachment: [
    'id', 'expense_id', 'kind', 'filename', 'mime_type', 'storage_path', 'nextcloud_path',
    'uploaded_by', 'published_at', 'created_at',
  ],
  booking_running_no_head: ['ledger_account_id', 'fiscal_year_id'],
  booking: [
    'id', 'ledger_account_id', 'budget_titel_id', 'fiscal_year_id', 'amount_cents', 'booking_date',
    'running_no', 'payment_type', 'receipt_id', 'bank_transaction_id', 'state', 'supersedes',
    'correction_fiscal_year_id', 'retention_until', 'created_at',
  ],
  payment_order: [
    'id', 'expense_id', 'anordnung_by', 'feststellung_sachlich_by', 'feststellung_rechnerisch_by',
    'dual_signature_attested', 'state', 'created_at',
  ],
  approval: [
    'id', 'approvable_type', 'approvable_id', 'created_by', 'amount_cents', 'status',
    'current_stage_index', 'method', 'rejected_by', 'rejection_reason', 'decided_at',
    'helios_election_id', 'created_at',
  ],
  approval_stage: [
    'id', 'approval_id', 'stage_index', 'role', 'required_group', 'certifies', 'state',
    'signer_user_id', 'acted_at', 'note', 'step_up_loa', 'step_up_at',
  ],
  inventory_item: [
    'id', 'org_unit_id', 'inventory_no', 'name', 'acquisition_date', 'acquisition_value_cents',
    'disposed_at', 'disposal_resolution_ref', 'created_at',
  ],
  discharge: [
    'id', 'fiscal_year_id', 'finance_unit_id', 'audit_report_ref', 'approved_by', 'approved_at',
    'state', 'denied_reason', 'resolution_ref', 'created_at',
  ],
  comment: ['id', 'commentable_type', 'commentable_id', 'author', 'body', 'created_at'],
  reconciliation: [
    'id', 'ledger_account_id', 'period_year', 'period_month', 'soll_cents', 'ist_cents',
    'has_discrepancy', 'note', 'created_at',
  ],
}

/** TIMESTAMPTZ columns (normalized to an explicit-offset ISO-Z string). */
export const TIMESTAMP_COLUMNS: Record<FinanceTable, Set<string>> = {
  finanzordnung_profile: new Set(['created_at', 'updated_at']),
  finance_helios_settings: new Set(['created_at', 'updated_at']),
  reserve: new Set(['created_at']),
  cash_audit: new Set(['created_at']),
  finance_unit: new Set(['created_at']),
  bank_account: new Set(['last_sync_at', 'created_at']),
  fiscal_year: new Set(['created_at']),
  ledger_account: new Set(['created_at']),
  bank_transaction: new Set(['imported_at']),
  fints_config: new Set(['last_sync_at', 'created_at']),
  csv_import_profile: new Set(['created_at']),
  budget_plan: new Set(['closed_at', 'approved_at', 'activated_at', 'created_at']),
  budget_section: new Set(['created_at']),
  budget_group: new Set(['created_at']),
  budget_titel: new Set(['created_at']),
  project: new Set(['created_at']),
  expense: new Set(['paid_at', 'created_at']),
  receipt: new Set(['created_at']),
  receipt_item: new Set(['created_at']),
  expense_attachment: new Set(['published_at', 'created_at']),
  booking_running_no_head: new Set(),
  booking: new Set(['retention_until', 'created_at']),
  payment_order: new Set(['created_at']),
  approval: new Set(['decided_at', 'created_at']),
  approval_stage: new Set(['acted_at', 'step_up_at']),
  inventory_item: new Set(['created_at']),
  discharge: new Set(['approved_at', 'created_at']),
  comment: new Set(['created_at']),
  reconciliation: new Set(['created_at']),
}

/** DATE columns (normalized to a bare YYYY-MM-DD string — no tz shift). */
export const DATE_COLUMNS: Record<FinanceTable, Set<string>> = {
  finanzordnung_profile: new Set(),
  finance_helios_settings: new Set(),
  reserve: new Set(),
  cash_audit: new Set(['audit_date']),
  finance_unit: new Set(),
  bank_account: new Set(),
  fiscal_year: new Set(['start_date', 'end_date']),
  ledger_account: new Set(),
  bank_transaction: new Set(['booking_date', 'valuta_date']),
  fints_config: new Set(),
  csv_import_profile: new Set(),
  budget_plan: new Set(),
  budget_section: new Set(),
  budget_group: new Set(),
  budget_titel: new Set(),
  project: new Set(['date_start', 'date_end']),
  expense: new Set(),
  receipt: new Set(['beleg_date']),
  receipt_item: new Set(),
  expense_attachment: new Set(),
  booking_running_no_head: new Set(),
  booking: new Set(['booking_date']),
  payment_order: new Set(),
  approval: new Set(),
  approval_stage: new Set(),
  inventory_item: new Set(['acquisition_date', 'disposed_at']),
  discharge: new Set(),
  comment: new Set(),
  reconciliation: new Set(),
}

/** JSONB columns (re-serialized to a JSON string before binding). */
export const JSONB_COLUMNS: Partial<Record<FinanceTable, Set<string>>> = {
  finanzordnung_profile: new Set(['signer_stages', 'decision_authority_tiers']),
  csv_import_profile: new Set(['column_mapping']),
  budget_plan: new Set(['statement']),
}

/** TEXT[] columns (passed through to postgres-js as JS arrays). */
export const ARRAY_COLUMNS: Partial<Record<FinanceTable, Set<string>>> = {
  approval_stage: new Set(['certifies']),
}

/**
 * A checksummed column per table — the backfill verify gate compares a sorted
 * md5 of this column across source and target to catch content drift a row-count
 * check alone would miss. Deliberately a small representative set.
 */
export const CHECKSUM_COLUMN: Partial<Record<FinanceTable, string>> = {
  bank_account: 'iban',
  fiscal_year: 'name',
  project: 'name',
  expense: 'payee_name',
}

// ── sub-org saga store ops (#369 slice 3) ───────────────────────────────────────
// The finance_unit side of the createSubOrg/updateSubOrg/deleteSubOrg sagas and
// the checkOrgUnitFinanceRefs referential guard. org_units lives in the KERNEL DB,
// so these ops touch ONLY the leaf's finance schema; the ServiceFinanceClient
// orchestrates the org_units side + compensation.

/** The finance_unit JSON the leaf returns (bare row; BIGINT id → number). */
export interface FinanceUnitRow {
  id: number
  org_unit_id: string
  kind: string
  bookkeeping_mode: string
  carry_over_rule: string
}

interface RawFinanceUnitRow {
  id: string
  org_unit_id: string
  kind: string
  bookkeeping_mode: string
  carry_over_rule: string
}

function parseFinanceUnit(r: RawFinanceUnitRow): FinanceUnitRow {
  return { ...r, id: Number(r.id) }
}

export interface CreateFinanceUnitInput {
  orgUnitId: string
  kind?: string
  bookkeepingMode?: string
  carryOverRule?: string
}

/** createSubOrg finance side: insert the paired finance_unit for an org unit. */
export async function insertFinanceUnit(sql: Sql, input: CreateFinanceUnitInput): Promise<FinanceUnitRow> {
  const rows = await sql<RawFinanceUnitRow[]>`
    INSERT INTO finance.finance_unit (org_unit_id, kind, bookkeeping_mode, carry_over_rule)
    VALUES (
      ${input.orgUnitId}, ${input.kind ?? 'standard'},
      ${input.bookkeepingMode ?? 'central'}, ${input.carryOverRule ?? 'carry_forward'}
    )
    RETURNING id, org_unit_id, kind, bookkeeping_mode, carry_over_rule`
  return parseFinanceUnit(rows[0]!)
}

/** updateSubOrg saga resolve step: read a finance_unit by id (→ org_unit_id). */
export async function getFinanceUnitById(sql: Sql, id: string | number): Promise<FinanceUnitRow | null> {
  const rows = await sql<RawFinanceUnitRow[]>`
    SELECT id, org_unit_id, kind, bookkeeping_mode, carry_over_rule
    FROM finance.finance_unit WHERE id = ${id}`
  return rows[0] ? parseFinanceUnit(rows[0]) : null
}

/** updateSubOrg finance side: patch the finance_unit (empty patch = read-back). */
export async function updateFinanceUnitById(
  sql: Sql,
  id: string | number,
  patch: { bookkeepingMode?: string; carryOverRule?: string },
): Promise<FinanceUnitRow | null> {
  if (patch.bookkeepingMode !== undefined) {
    await sql`UPDATE finance.finance_unit SET bookkeeping_mode = ${patch.bookkeepingMode} WHERE id = ${id}`
  }
  if (patch.carryOverRule !== undefined) {
    await sql`UPDATE finance.finance_unit SET carry_over_rule = ${patch.carryOverRule} WHERE id = ${id}`
  }
  return getFinanceUnitById(sql, id)
}

/** The relations that make an org unit "still referenced" by finance — the 3
 *  omitted org_units FKs (finance_unit / project / inventory_item) plus the
 *  finance_unit's own RESTRICT dependents (ledger_account / budget_section /
 *  expense / discharge). */
export async function countOrgUnitFinanceRefs(sql: Sql, orgUnitId: string): Promise<Record<string, number>> {
  const rows = await sql<
    Array<{
      finance_unit: number
      project: number
      inventory_item: number
      ledger_account: number
      budget_section: number
      expense: number
      discharge: number
    }>
  >`
    SELECT
      (SELECT count(*) FROM finance.finance_unit WHERE org_unit_id = ${orgUnitId})::int AS finance_unit,
      (SELECT count(*) FROM finance.project WHERE org_unit_id = ${orgUnitId})::int AS project,
      (SELECT count(*) FROM finance.inventory_item WHERE org_unit_id = ${orgUnitId})::int AS inventory_item,
      (SELECT count(*) FROM finance.ledger_account la
         JOIN finance.finance_unit fu ON la.finance_unit_id = fu.id
        WHERE fu.org_unit_id = ${orgUnitId})::int AS ledger_account,
      (SELECT count(*) FROM finance.budget_section bs
         JOIN finance.finance_unit fu ON bs.finance_unit_id = fu.id
        WHERE fu.org_unit_id = ${orgUnitId})::int AS budget_section,
      (SELECT count(*) FROM finance.expense e
         JOIN finance.finance_unit fu ON e.finance_unit_id = fu.id
        WHERE fu.org_unit_id = ${orgUnitId})::int AS expense,
      (SELECT count(*) FROM finance.discharge d
         JOIN finance.finance_unit fu ON d.finance_unit_id = fu.id
        WHERE fu.org_unit_id = ${orgUnitId})::int AS discharge`
  const r = rows[0]!
  return {
    finance_unit: r.finance_unit,
    project: r.project,
    inventory_item: r.inventory_item,
    ledger_account: r.ledger_account,
    budget_section: r.budget_section,
    expense: r.expense,
    discharge: r.discharge,
  }
}

/** Sum of the counts EXCLUDING the finance_unit itself — the rows that block
 *  deleting the sub-org pair (finance_unit is deleted as part of the pair). */
export function blockingRefCount(counts: Record<string, number>): number {
  return (
    (counts.project ?? 0) +
    (counts.inventory_item ?? 0) +
    (counts.ledger_account ?? 0) +
    (counts.budget_section ?? 0) +
    (counts.expense ?? 0) +
    (counts.discharge ?? 0)
  )
}

// ── shared domain-error + coercion helpers (#383 leaf gap-close) ────────────────
// The store layer is the leaf's only domain layer (no separate service tier), so
// value-parity validation the native SERVICE layer performs (e.g. fiscal_year
// end>start) lives here. A FinanceValidationError → the route maps to HTTP 400;
// a store fn returning null → the route maps to 404 (mirrors the native routes'
// Error→4xx mapping).

/** A domain-validation failure (bad input the DB CHECKs don't catch). Routes map
 *  it to 400. Kept distinct from a generic Error so a handler can 400 it. */
export class FinanceValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FinanceValidationError'
  }
}

/** Write-scope denial (mirror of services/write/errors.ts#AccessDeniedError). The
 *  route maps it to HTTP 403. Thrown by assertOrgUnitWritable when a non-superuser
 *  actor may not write the target org unit (auditor, or org unit out of scope). */
export class AccessDeniedError extends Error {
  readonly httpStatus = 403
  // TASK-009 item 4 (parity with gremion-ui's copy of this class): `orgUnitId`
  // is sometimes reused by callers to carry a non-org-unit masking label (e.g.
  // lockMoneyPaymentOrderInScope's `hidden()` passing "payment_order#N") — an
  // optional `message` override lets such callers state the truth without
  // changing this class's shape, so every `instanceof AccessDeniedError` /
  // `.httpStatus` check still works unchanged.
  constructor(readonly actorId: string, readonly orgUnitId: string, message?: string) {
    super(message ?? `access denied: actor=${actorId} cannot write to org_unit=${orgUnitId}`)
    this.name = 'AccessDeniedError'
  }
}

/** The Vier-Augen approval-workflow error family (mirror of
 *  services/write/errors.ts#ApprovalWorkflowError). Each carries a stable `code`
 *  and the HTTP status the route maps it to (D1 status table: NOT_ELIGIBLE /
 *  SELF_APPROVAL / DUPLICATE_SIGNER / HELIOS_NOT_MANUALLY_SIGNABLE → 403,
 *  REJECTION_NOTE_REQUIRED → 400, WRONG_STAGE / ALREADY_DECIDED → 409,
 *  NO_ACTIVE_PROFILE → 500). */
export abstract class ApprovalWorkflowError extends Error {
  abstract readonly code: string
  abstract readonly httpStatus: number
}

export class NotEligibleForStage extends ApprovalWorkflowError {
  override readonly name = 'NotEligibleForStage'
  readonly code = 'NOT_ELIGIBLE'
  readonly httpStatus = 403
  constructor(actorId: string, requiredGroup: string) {
    super(`actor ${actorId} not eligible for stage (requires group ${requiredGroup})`)
  }
}

export class SelfApprovalForbidden extends ApprovalWorkflowError {
  override readonly name = 'SelfApprovalForbidden'
  readonly code = 'SELF_APPROVAL'
  readonly httpStatus = 403
  constructor(actorId: string) {
    super(`self-approval forbidden: actor ${actorId} is the approval creator`)
  }
}

export class DuplicateSignerForbidden extends ApprovalWorkflowError {
  override readonly name = 'DuplicateSignerForbidden'
  readonly code = 'DUPLICATE_SIGNER'
  readonly httpStatus = 403
  constructor(actorId: string) {
    super(`duplicate signer forbidden: actor ${actorId} already signed an earlier stage`)
  }
}

export class WrongStageError extends ApprovalWorkflowError {
  override readonly name = 'WrongStageError'
  readonly code = 'WRONG_STAGE'
  readonly httpStatus = 409
  constructor(message: string) {
    super(message)
  }
}

export class AlreadyDecidedError extends ApprovalWorkflowError {
  override readonly name = 'AlreadyDecidedError'
  readonly code = 'ALREADY_DECIDED'
  readonly httpStatus = 409
  constructor(approvalId: number, status: string) {
    super(`approval ${approvalId} already decided (status=${status})`)
  }
}

export class RejectionNoteRequired extends ApprovalWorkflowError {
  override readonly name = 'RejectionNoteRequired'
  readonly code = 'REJECTION_NOTE_REQUIRED'
  readonly httpStatus = 400
  constructor() {
    super('rejection requires a non-empty note')
  }
}

export class NoActiveProfileError extends ApprovalWorkflowError {
  override readonly name = 'NoActiveProfileError'
  readonly code = 'NO_ACTIVE_PROFILE'
  readonly httpStatus = 500
  constructor() {
    super('no active finanzordnung_profile found')
  }
}

export class HeliosApprovalNotManuallySignable extends ApprovalWorkflowError {
  override readonly name = 'HeliosApprovalNotManuallySignable'
  readonly code = 'HELIOS_NOT_MANUALLY_SIGNABLE'
  readonly httpStatus = 403
  constructor(approvalId: number) {
    super(`approval ${approvalId} is decided by Helios ingest and cannot be manually signed or rejected`)
  }
}

/** F1-FIX-05-K (H20): the approvable already has a pending approval. A repeated
 *  "Genehmigung anfordern" (double click, retry) must not open a second one. */
export class ApprovalAlreadyOpenError extends ApprovalWorkflowError {
  override readonly name = 'ApprovalAlreadyOpenError'
  readonly code = 'APPROVAL_ALREADY_OPEN'
  readonly httpStatus = 409
  constructor(type: string, approvableId: number) {
    super(`${type} ${approvableId} already has a pending approval`)
  }
}

/** F1-FIX-05-K (H20): an expense that is already approved or paid cannot open a
 *  new approval (a second approval would finalise into a second payment_order). */
export class ApprovableNotRequestableError extends ApprovalWorkflowError {
  override readonly name = 'ApprovableNotRequestableError'
  readonly code = 'APPROVABLE_NOT_REQUESTABLE'
  readonly httpStatus = 409
  constructor(type: string, approvableId: number, state: string) {
    super(`${type} ${approvableId} is ${state}; it cannot open a new approval`)
  }
}

/** F1-FIX-05-K (H20): finalising an expense approval when the expense already has a
 *  live (non-voided) payment_order. One expense, one payment order. */
export class PaymentOrderExistsError extends ApprovalWorkflowError {
  override readonly name = 'PaymentOrderExistsError'
  readonly code = 'PAYMENT_ORDER_EXISTS'
  readonly httpStatus = 409
  constructor(subject: string) {
    super(`${subject} already has a live payment_order`)
  }
}

/** True when `err` is a Postgres unique violation on the named index/constraint. */
function isUniqueViolationOn(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint_name?: string } | null
  return e?.code === '23505' && e.constraint_name === constraint
}

/** Coerce a DATE column (postgres-js may hand back a Date, or a 'YYYY-MM-DD'
 *  string when the query casts ::text) to the bare YYYY-MM-DD the DTO contract
 *  wants (mirror of dto-map.ts date handling — no tz shift). */
function toDateStr(v: string | Date): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : v.slice(0, 10)
}

// ── fiscal_year domain (#383) ───────────────────────────────────────────────────
// listFiscalYears / createFiscalYear / updateFiscalYear — the FiscalYear surface.
// fiscal_year is a programme-wide statutory entity (leaf-local table, no org_units
// join). The DTO shape mirrors read/dto-map.ts#toFiscalYearDto: exactly
// { id:number, name, start_date:'YYYY-MM-DD', end_date:'YYYY-MM-DD' } (created_at
// is NOT surfaced). end>start is validated here (native FiscalYearServiceImpl).

/** The FiscalYear DTO the leaf serialises (frozen contract — no created_at). */
export interface FiscalYearDto {
  id: number
  name: string
  start_date: string
  end_date: string
}

interface RawFiscalYearRow {
  id: string | number
  name: string
  start_date: string | Date
  end_date: string | Date
}

function parseFiscalYear(r: RawFiscalYearRow): FiscalYearDto {
  return { id: Number(r.id), name: r.name, start_date: toDateStr(r.start_date), end_date: toDateStr(r.end_date) }
}

/** ISO-8601 YYYY-MM-DD strings compare lexicographically, so `<=` is the correct
 *  degenerate-year predicate (mirror of FiscalYearServiceImpl). */
function assertYearOrder(startDate: string, endDate: string): void {
  if (endDate <= startDate) {
    throw new FinanceValidationError(
      `fiscal_year: end_date (${endDate}) must be greater than start_date (${startDate})`,
    )
  }
}

/** List every fiscal_year, start_date ascending (repo listFiscalYears order). */
export async function listFiscalYears(sql: Sql): Promise<FiscalYearDto[]> {
  const rows = await sql<RawFiscalYearRow[]>`
    SELECT id, name, start_date::text AS start_date, end_date::text AS end_date
    FROM finance.fiscal_year ORDER BY start_date`
  return rows.map(parseFiscalYear)
}

export interface CreateFiscalYearInput {
  name: string
  startDate: string
  endDate: string
}

/** Insert a fiscal_year (end>start enforced before the write). */
export async function createFiscalYear(sql: Sql, input: CreateFiscalYearInput): Promise<FiscalYearDto> {
  assertYearOrder(input.startDate, input.endDate)
  const rows = await sql<RawFiscalYearRow[]>`
    INSERT INTO finance.fiscal_year (name, start_date, end_date)
    VALUES (${input.name}, ${input.startDate}, ${input.endDate})
    RETURNING id, name, start_date::text AS start_date, end_date::text AS end_date`
  return parseFiscalYear(rows[0]!)
}

export type FiscalYearPatch = Partial<{ name: string; startDate: string; endDate: string }>

/** Patch a fiscal_year (COALESCE only-provided keys). Locks the row FOR UPDATE
 *  so a concurrent update cannot race the merged end>start re-validation. Returns
 *  null when the id does not exist (→ 404); an empty patch is a no-op read-back. */
export async function updateFiscalYear(
  sql: Sql,
  id: string | number,
  patch: FiscalYearPatch,
): Promise<FiscalYearDto | null> {
  return sql.begin(async (tx) => {
    const current = await tx<RawFiscalYearRow[]>`
      SELECT id, name, start_date::text AS start_date, end_date::text AS end_date
      FROM finance.fiscal_year WHERE id = ${id} FOR UPDATE`
    if (current.length === 0) return null
    const cur = parseFiscalYear(current[0]!)

    const hasName = patch.name !== undefined
    const hasStart = patch.startDate !== undefined
    const hasEnd = patch.endDate !== undefined
    if (!hasName && !hasStart && !hasEnd) return cur

    const nextStart = patch.startDate ?? cur.start_date
    const nextEnd = patch.endDate ?? cur.end_date
    assertYearOrder(nextStart, nextEnd)

    const rows = await tx<RawFiscalYearRow[]>`
      UPDATE finance.fiscal_year
         SET name       = COALESCE(${hasName ? patch.name! : null}, name),
             start_date = COALESCE(${hasStart ? patch.startDate! : null}, start_date),
             end_date   = COALESCE(${hasEnd ? patch.endDate! : null}, end_date)
       WHERE id = ${id}
       RETURNING id, name, start_date::text AS start_date, end_date::text AS end_date`
    return rows[0] ? parseFiscalYear(rows[0]) : null
  }) as Promise<FiscalYearDto | null>
}

/** Coerce a TIMESTAMPTZ column (Date from postgres-js, or an already-ISO string)
 *  to an explicit-offset ISO-Z string (mirror of dto-map.ts timestamptz handling). */
function toIsoZ(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : v
}

// ── actor read scope (#383 R10 scope-forwarding) ─────────────────────────────
// The per-actor org-unit read scope the ACL forwards over the internal finance
// headers (x-finance-is-auditor / x-finance-is-superuser / x-finance-scoped-org-units).
// Mirrors the native FinanceActor read-scope fields (services/read/access.ts):
// scopedOrgUnitIds are the org units the actor may see; isAuditor is the strict
// read-only signal; isSuperuser is the D1(a) runtime see-all short-circuit.
//
// TWO see-all gates — the native oracle DIVERGES per domain and the leaf mirrors it
// EXACTLY:
//   - bank_account / fints gate on isAuditor ONLY (read/bank-account.ts,
//     read/fints.ts use `isAuditor`, NOT seesAllFinance) → a superuser-not-auditor
//     is STILL org-unit-scoped there.
//   - expense / receipt gate on seesAllFinance = isAuditor || isSuperuser (they call
//     scopedFinanceUnitIds, which honours the superuser short-circuit) → a
//     superuser-not-auditor sees ALL there.

/** The actor's finance read scope, reconstructed from the ACL's internal headers. */
export interface ScopeContext {
  isAuditor: boolean
  isSuperuser: boolean
  scopedOrgUnitIds: readonly string[]
}

/** The full write actor the leaf reconstructs from the ACL headers — the read
 *  scope (ScopeContext) PLUS the actor's identity (x-finance-user-id) and Keycloak
 *  group memberships (x-finance-groups). The write ops (createExpense + the Vier-
 *  Augen approval family) need the identity for created_by / signer eligibility and
 *  the groups for per-stage required_group checks; the read ops need only the scope.
 *  Mirror of the FinanceActor fields the native services read (contracts/services.ts). */
export interface ActorContext extends ScopeContext {
  userId: string
  groups: readonly string[]
}

/** Write-scope predicate (mirror of services/write/access.ts#assertOrgUnitWritable).
 *  A runtime superuser bypasses the gate FIRST; an auditor is read-only (refused
 *  unconditionally); otherwise the target org unit must be in the actor's write
 *  scope. Throws AccessDeniedError (route → 403) on refusal. */
function assertOrgUnitWritable(actor: ActorContext, orgUnitId: string): void {
  if (actor.isSuperuser) return
  if (actor.isAuditor) throw new AccessDeniedError(actor.userId, orgUnitId)
  if (!actor.scopedOrgUnitIds.includes(orgUnitId)) {
    throw new AccessDeniedError(actor.userId, orgUnitId)
  }
}

/** See-all predicate for the expense/receipt reads (mirror of read/access.ts
 *  #seesAllFinance): auditor OR runtime superuser bypasses org-unit scoping. NB the
 *  bank_account/fints reads DIVERGE — they gate on isAuditor only. */
function seesAllFinance(scope: ScopeContext): boolean {
  return scope.isAuditor || scope.isSuperuser
}

/** Resolve the finance_unit ids the actor can see (mirror of read/access.ts
 *  #scopedFinanceUnitIds): seesAll → every finance_unit; empty scope → []; else the
 *  finance_units whose org_unit_id is in scope. Used by the expense/receipt reads. */
async function scopedFinanceUnitIds(sql: Sql, scope: ScopeContext): Promise<number[]> {
  if (seesAllFinance(scope)) {
    const rows = await sql<{ id: string }[]>`SELECT id FROM finance.finance_unit`
    return rows.map((r) => Number(r.id))
  }
  if (scope.scopedOrgUnitIds.length === 0) return []
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM finance.finance_unit WHERE org_unit_id = ANY(${scope.scopedOrgUnitIds as unknown as string[]})`
  return rows.map((r) => Number(r.id))
}

// ── bank_account read domain (#383 R10) ──────────────────────────────────────
// listBankAccounts — DTO mirrors read/dto-map.ts#toBankAccountDto (including the
// env-derived fintsRegistrationPending) AND the native oracle's per-actor row-
// scoping (read/bank-account.ts): an auditor sees ALL; a non-auditor sees only the
// bank accounts backing one of THEIR ledgers (ledger_account → finance_unit →
// org_unit ∈ scope); empty scope → []. DIVERGENCE: the gate is isAuditor ONLY (not
// seesAllFinance), so a superuser-not-auditor is STILL org-unit-scoped here.

export interface BankAccountDto {
  id: number
  name: string
  short: string
  iban: string
  last_sync: string
  current_balance: number
  fintsRegistrationPending: boolean
  fints_state?: 'pending_registration' | 'connected' | 'error'
}

interface RawBankAccountRow {
  id: string | number
  name: string
  iban: string
  current_balance_cents: string | number
  last_sync_at: Date | string | null
  fints_state?: 'pending_registration' | 'connected' | 'error'
}

/** True iff FINTS_PRODUCT_ID is unset/empty (ZKA registration pending) — mirror
 *  of money/bank-account.ts#isFintsRegistrationPending. Derived per-call so a
 *  deployment that flips the env updates the UI on the next request. */
function isFintsRegistrationPending(): boolean {
  return !process.env.FINTS_PRODUCT_ID
}

function toBankAccountDto(r: RawBankAccountRow): BankAccountDto {
  return {
    id: Number(r.id),
    name: r.name,
    short: r.name.slice(0, 8),
    iban: r.iban,
    last_sync: r.last_sync_at == null ? '' : toIsoZ(r.last_sync_at),
    current_balance: Number(r.current_balance_cents),
    fintsRegistrationPending: isFintsRegistrationPending(),
    fints_state: r.fints_state,
  }
}

export async function listBankAccounts(sql: Sql, scope: ScopeContext): Promise<BankAccountDto[]> {
  if (scope.isAuditor) {
    const rows = await sql<RawBankAccountRow[]>`
      SELECT id, name, iban, current_balance_cents, last_sync_at, fints_state
      FROM finance.bank_account ORDER BY id`
    return rows.map(toBankAccountDto)
  }
  if (scope.scopedOrgUnitIds.length === 0) return []
  const rows = await sql<RawBankAccountRow[]>`
    SELECT DISTINCT ba.id, ba.name, ba.iban, ba.current_balance_cents, ba.last_sync_at, ba.fints_state
    FROM finance.bank_account ba
    JOIN finance.ledger_account la ON la.bank_account_id = ba.id
    JOIN finance.finance_unit fu ON fu.id = la.finance_unit_id
    WHERE fu.org_unit_id = ANY(${scope.scopedOrgUnitIds as unknown as string[]})
    ORDER BY ba.id`
  return rows.map(toBankAccountDto)
}

// ── FinTS status read domain (#383 R10) ──────────────────────────────────────
// getFintsStatus — leaf-local (fints_config), scoped like listBankAccounts. The
// visibility gate (read/fints.ts) 404s (returns null → route 404) a bank account
// the actor cannot see: an auditor is gated only on existence; a non-auditor must
// own a ledger_account on the account (ledger → finance_unit → org_unit ∈ scope),
// else G-019 anti-probing 404 even for an EXISTING account; empty scope → 404. Once
// visible, no config row → { configured:false } (the native 200-with-empty-status).
// DIVERGENCE: like bank_account, the gate is isAuditor ONLY — a superuser-not-auditor
// is STILL org-unit-scoped here.

export interface FintsStatusDto {
  configured: boolean
  bank_code: string | null
  username: string | null
  last_sync_at: string | null
  last_sync_status: 'ok' | 'failed' | null
  last_sync_error: string | null
}

interface RawFintsConfigRow {
  bank_code: string | null
  username: string | null
  last_sync_at: Date | string | null
  last_sync_status: 'ok' | 'failed' | null
  last_sync_error: string | null
}

export async function getFintsStatus(
  sql: Sql,
  bankAccountId: string | number,
  scope: ScopeContext,
): Promise<FintsStatusDto | null> {
  // Visibility gate — auditor: existence only; non-auditor: must own a ledger on
  // the account (org_unit ∈ scope), else null (route 404). NB isAuditor-only gate.
  if (scope.isAuditor) {
    const ba = await sql<{ id: string }[]>`SELECT id FROM finance.bank_account WHERE id = ${bankAccountId}`
    if (ba.length === 0) return null
  } else {
    if (scope.scopedOrgUnitIds.length === 0) return null
    const visible = await sql<{ id: string }[]>`
      SELECT DISTINCT ba.id
      FROM finance.bank_account ba
      JOIN finance.ledger_account la ON la.bank_account_id = ba.id
      JOIN finance.finance_unit fu ON fu.id = la.finance_unit_id
      WHERE ba.id = ${bankAccountId}
        AND fu.org_unit_id = ANY(${scope.scopedOrgUnitIds as unknown as string[]})`
    if (visible.length === 0) return null
  }
  const rows = await sql<RawFintsConfigRow[]>`
    SELECT bank_code, username, last_sync_at, last_sync_status, last_sync_error
    FROM finance.fints_config WHERE bank_account_id = ${bankAccountId}`
  const r = rows[0]
  if (!r) {
    return { configured: false, bank_code: null, username: null, last_sync_at: null, last_sync_status: null, last_sync_error: null }
  }
  return {
    configured: true,
    bank_code: r.bank_code ?? null,
    username: r.username ?? null,
    last_sync_at: r.last_sync_at == null ? null : toIsoZ(r.last_sync_at),
    last_sync_status: r.last_sync_status ?? null,
    last_sync_error: r.last_sync_error ?? null,
  }
}

// ── receipt read domain (#383 R10) ───────────────────────────────────────────
// listReceipts — leaf-local (finance.receipt). Visibility flows from the parent
// expense (read/receipt.ts): null (→ route 404) when the expense does NOT EXIST OR
// (for a non-auditor) its finance_unit is out of the actor's scope — the G-019
// anti-probing 404 for an out-of-scope-but-EXISTING expense. Then lists its receipts.
// The live schema is leaner than the DTO; toReceiptDto emits '' / null for absent
// fields (mirror native). DIVERGENCE: scoping goes through scopedFinanceUnitIds,
// which honours seesAllFinance — a superuser-not-auditor sees ALL here.

export interface ReceiptDto {
  id: number
  expense_id: number
  filename: string
  mime_type: string
  nextcloud_path: string | null
  published_at: string | null
  uploaded_by_id: string
  created_at: string | null
}

interface RawReceiptRow {
  id: string | number
  expense_id: string | number
  filename?: string
  mime_type?: string | null
  nextcloud_path?: string | null
  published_at?: Date | string | null
  uploaded_by?: string | null
  created_at: Date | string | null
}

function toReceiptDto(r: RawReceiptRow): ReceiptDto {
  return {
    id: Number(r.id),
    expense_id: Number(r.expense_id),
    filename: r.filename ?? '',
    mime_type: r.mime_type ?? '',
    nextcloud_path: r.nextcloud_path ?? null,
    published_at: r.published_at == null ? null : toIsoZ(r.published_at),
    uploaded_by_id: r.uploaded_by ?? '',
    created_at: r.created_at == null ? null : toIsoZ(r.created_at),
  }
}

export async function listReceipts(
  sql: Sql,
  expenseId: string | number,
  scope: ScopeContext,
): Promise<ReceiptDto[] | null> {
  const exp = await sql<{ id: string; finance_unit_id: string }[]>`
    SELECT id, finance_unit_id FROM finance.expense WHERE id = ${expenseId}`
  if (exp.length === 0) return null
  if (!scope.isAuditor) {
    const scopeIds = await scopedFinanceUnitIds(sql, scope)
    if (!scopeIds.includes(Number(exp[0]!.finance_unit_id))) return null
  }
  const rows = await sql<RawReceiptRow[]>`
    SELECT * FROM finance.receipt WHERE expense_id = ${expenseId} ORDER BY id`
  return rows.map(toReceiptDto)
}

// ── receipt WRITE domain (#383 Lane E2 / R7 — uploadReceipt/deleteReceipt/publishReceipt) ─
// Port of the native oracle gremion-ui/.../services/write/receipt-storage.ts. The three
// ops act on finance.expense_attachment (the files-on-disk entity — NOT finance.receipt,
// the §3.4 paper-trail header the read domain above lists), all gated by the §11 write
// predicate (assertOrgUnitWritable) and serialised inside a single finance-pool
// transaction. The bytes ride the injected StorageBackend (../storage — STORAGE_BACKEND
// selects local-fs vs Nextcloud-WebDAV; the opaque handle is stored in storage_path and
// nextcloud_path stays NULL, exactly as native). The return DTO is the SAME Receipt shape
// the ACL client expects (toReceiptDto maps the attachment row — the read-side facade's
// ExpenseAttachment→Receipt mapping), byte-identical to native's write facade.
//
// HTTP mapping (native attachments route parity, surfaced by the leaf handler):
//   ReceiptTooLargeError → 413, ReceiptMimeError → 415, ReceiptNotFoundError → 404,
//   ReceiptImmutableError → 409 (published, immutable), AccessDeniedError → 403.

const RECEIPT_MAX_BYTES = 10 * 1024 * 1024 // 10 MiB (native cap)
const RECEIPT_ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png'] as const

/** Oversize upload (> 10 MiB). Route → 413. Message byte-identical to native. */
export class ReceiptTooLargeError extends Error {
  readonly httpStatus = 413
  constructor(size: number) {
    super(`receipt: file exceeds ${RECEIPT_MAX_BYTES} bytes (${size})`)
    this.name = 'ReceiptTooLargeError'
  }
}

/** Mime not in the allow-list (pdf/jpeg/png). Route → 415. Message byte-identical to native. */
export class ReceiptMimeError extends Error {
  readonly httpStatus = 415
  constructor(mime: string) {
    super(`receipt: mime type '${mime}' not in allow-list [${RECEIPT_ALLOWED_MIME.join(', ')}]`)
    this.name = 'ReceiptMimeError'
  }
}

/** Missing expense / attachment, or an attachment that does not belong to the given
 *  expense (anti-probing — indistinguishable from absent). Route → 404. */
export class ReceiptNotFoundError extends Error {
  readonly httpStatus = 404
  constructor(message: string) {
    super(message)
    this.name = 'ReceiptNotFoundError'
  }
}

/** deleteReceipt on a published (immutable audit trail) attachment. Route → 409. */
export class ReceiptImmutableError extends Error {
  readonly httpStatus = 409
  constructor(attachmentId: number) {
    super(`receipt: cannot delete a published attachment (id=${attachmentId})`)
    this.name = 'ReceiptImmutableError'
  }
}

/** A receipt filename that carries no usable basename ('', '.', '..', a bare path)
 *  or a control character. Route -> 400. F1-FIX-05-K (H05). */
export class InvalidReceiptFilenameError extends Error {
  readonly httpStatus = 400
  constructor(filename: string) {
    super(`receipt: filename ${JSON.stringify(filename)} has no usable basename`)
    this.name = 'InvalidReceiptFilenameError'
  }
}

/** The parsed multipart upload the leaf hands the store (the leaf never sees a `File`;
 *  the multipart parser yields the exact-size bytes + the part's filename / mime). */
export interface ReceiptUpload {
  filename: string
  mimeType: string | null
  bytes: Uint8Array
}

/** The finance.expense_attachment row shape (superset of RawReceiptRow — carries the
 *  extra storage_path/kind the DTO drops). toReceiptDto maps it to the Receipt DTO. */
interface RawAttachmentRow extends RawReceiptRow {
  storage_path: string
}

/** Storage extension per allow-listed mime (the key never carries client text). */
const RECEIPT_EXT: Record<(typeof RECEIPT_ALLOWED_MIME)[number], string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
}

/** A tenant id may enter a storage key only as one plain segment. */
const TENANT_KEY_SEGMENT = /^[A-Za-z0-9-]{1,64}$/

/** The display name kept in expense_attachment.filename: the client filename's
 *  basename (either separator), never a path. Refuses a name with no usable
 *  basename or with a control character. It is NEVER part of the storage key. */
export function receiptDisplayName(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  if (base === '' || base === '.' || base === '..' || /[\u0000-\u001f\u007f]/.test(base)) {
    throw new InvalidReceiptFilenameError(filename)
  }
  return base
}

/** F1-FIX-05-K (H05 leaf, K4#2 / K4#29): the storage key is built from
 *  server-controlled parts only -- finance/<tenantId>/expense/<expenseId>/<uuid><ext>.
 *  The tenant segment separates tenants on the shared Nextcloud / local root, the
 *  UUID makes every upload its own object (a same-name upload can no longer
 *  overwrite, and deleting one can no longer delete, another receipt's bytes), and
 *  no client text reaches the key (no '../' traversal across expense folders).
 *  Receipts written under the old key stay readable: read/delete act on the
 *  stored storage_path handle, which is never recomputed. */
export function receiptStorageKey(tenantId: string, expenseId: number, mimeType: string): string {
  if (!TENANT_KEY_SEGMENT.test(tenantId)) {
    throw new Error(`receipt: tenant id ${JSON.stringify(tenantId)} is not a plain key segment`)
  }
  if (!Number.isSafeInteger(expenseId) || expenseId <= 0) {
    throw new ReceiptNotFoundError(`expense ${expenseId} not found`)
  }
  const ext = RECEIPT_EXT[mimeType as (typeof RECEIPT_ALLOWED_MIME)[number]] ?? ''
  return `finance/${tenantId}/expense/${expenseId}/${randomUUID()}${ext}`
}

function assertReceiptAllowed(upload: ReceiptUpload): void {
  if (upload.bytes.byteLength > RECEIPT_MAX_BYTES) {
    throw new ReceiptTooLargeError(upload.bytes.byteLength)
  }
  const mime = upload.mimeType ?? ''
  if (!RECEIPT_ALLOWED_MIME.includes(mime as (typeof RECEIPT_ALLOWED_MIME)[number])) {
    throw new ReceiptMimeError(mime)
  }
}

/** Resolve the org unit that owns an expense (via its finance_unit) and assert the
 *  actor may write it (§11). Throws ReceiptNotFoundError (404) for an absent expense /
 *  finance_unit and AccessDeniedError (403) on a write-scope denial. */
async function assertExpenseWritable(sql: Sql, actor: ActorContext, expenseId: number, forUpdate: boolean): Promise<void> {
  const exp = forUpdate
    ? await sql<{ id: string; finance_unit_id: string }[]>`
        SELECT id, finance_unit_id FROM finance.expense WHERE id = ${expenseId} FOR UPDATE`
    : await sql<{ id: string; finance_unit_id: string }[]>`
        SELECT id, finance_unit_id FROM finance.expense WHERE id = ${expenseId}`
  if (exp.length === 0) throw new ReceiptNotFoundError(`expense ${expenseId} not found`)
  const fu = await sql<{ org_unit_id: string }[]>`
    SELECT org_unit_id FROM finance.finance_unit WHERE id = ${exp[0]!.finance_unit_id}`
  if (fu.length === 0) {
    throw new ReceiptNotFoundError(`finance_unit ${exp[0]!.finance_unit_id} not found for expense ${expenseId}`)
  }
  assertOrgUnitWritable(actor, fu[0]!.org_unit_id)
}

/**
 * Upload a receipt file: persist bytes via the storage backend, insert the matching
 * finance.expense_attachment row (kind='beleg'; storage_path=handle; nextcloud_path=NULL).
 * Mirror of receipt-storage.uploadReceipt: the §11 write-scope check fires BEFORE the
 * bytes hit storage so an unauthorised caller cannot create orphaned files, then re-checks
 * inside the tx under the expense row-lock (an admin could have moved the expense between
 * the pre-flight and the insert). On rollback after the write a dangling object may remain —
 * acceptable (the backend delete is idempotent; a future janitor can sweep).
 */
export async function uploadReceipt(
  sql: Sql,
  actor: ActorContext,
  expenseId: number,
  upload: ReceiptUpload,
  storage: StorageBackend,
  tenantId: string,
): Promise<ReceiptDto> {
  assertReceiptAllowed(upload)
  const displayName = receiptDisplayName(upload.filename)
  if (!TENANT_KEY_SEGMENT.test(tenantId)) {
    throw new Error(`receipt: tenant id ${JSON.stringify(tenantId)} is not a plain key segment`)
  }

  // Pre-flight access check OUTSIDE the storage write so we don't waste storage on
  // requests we're going to reject.
  await assertExpenseWritable(sql, actor, expenseId, false)

  const storagePath = await storage.put(
    receiptStorageKey(tenantId, expenseId, upload.mimeType ?? ''),
    upload.bytes,
  )

  return sql.begin(async (tx) => {
    const t = tx as unknown as Sql
    // Re-lock + re-check inside the tx (same row-lock semantics as expense.transition).
    await assertExpenseWritable(t, actor, expenseId, true)
    const rows = await t<RawAttachmentRow[]>`
      INSERT INTO finance.expense_attachment
        (expense_id, kind, filename, mime_type, storage_path, nextcloud_path, uploaded_by)
      VALUES (${expenseId}, 'beleg', ${displayName}, ${upload.mimeType},
              ${storagePath}, ${null}, ${actor.userId})
      RETURNING *`
    return toReceiptDto(rows[0]!)
  }) as Promise<ReceiptDto>
}

/**
 * Delete a receipt: refuse if already published (immutable audit trail), else remove the
 * storage object and the DB row inside one transaction. The expense-id argument is asserted
 * to match the attachment row to prevent an unauthorised caller from probing for the
 * existence of attachments on expenses they cannot access (→ 404, indistinguishable from
 * absent). Mirror of receipt-storage.deleteReceipt.
 */
export async function deleteReceipt(
  sql: Sql,
  actor: ActorContext,
  expenseId: number,
  attachmentId: number,
  storage: StorageBackend,
): Promise<void> {
  await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as Sql
    const att = await tx<RawAttachmentRow[]>`
      SELECT * FROM finance.expense_attachment WHERE id = ${attachmentId} FOR UPDATE`
    if (att.length === 0) throw new ReceiptNotFoundError(`expense_attachment ${attachmentId} not found`)
    const row = att[0]!
    if (Number(row.expense_id) !== expenseId) {
      throw new ReceiptNotFoundError(`receipt: attachment ${attachmentId} does not belong to expense ${expenseId}`)
    }
    if (row.published_at != null) throw new ReceiptImmutableError(attachmentId)
    await assertExpenseWritable(tx, actor, expenseId, true)
    await storage.delete(row.storage_path)
    await tx`DELETE FROM finance.expense_attachment WHERE id = ${attachmentId}`
  })
}

/**
 * Publish a receipt: stamp published_at = now() on the attachment row. Idempotent — a
 * second call returns the already-published row unchanged (no UPDATE issued). Publication
 * makes the attachment immutable (deleteReceipt refuses from here on). Same access-check
 * shape as deleteReceipt; no storage I/O. Mirror of receipt-storage.publishReceipt.
 */
export async function publishReceipt(
  sql: Sql,
  actor: ActorContext,
  expenseId: number,
  attachmentId: number,
): Promise<ReceiptDto> {
  return sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as Sql
    const att = await tx<RawAttachmentRow[]>`
      SELECT * FROM finance.expense_attachment WHERE id = ${attachmentId} FOR UPDATE`
    if (att.length === 0) throw new ReceiptNotFoundError(`expense_attachment ${attachmentId} not found`)
    const row = att[0]!
    if (Number(row.expense_id) !== expenseId) {
      throw new ReceiptNotFoundError(`receipt: attachment ${attachmentId} does not belong to expense ${expenseId}`)
    }
    await assertExpenseWritable(tx, actor, expenseId, true)
    if (row.published_at != null) return toReceiptDto(row) // idempotent — already published
    const updated = await tx<RawAttachmentRow[]>`
      UPDATE finance.expense_attachment SET published_at = ${new Date()} WHERE id = ${attachmentId} RETURNING *`
    return toReceiptDto(updated[0]!)
  }) as Promise<ReceiptDto>
}

// ── expense read domain (#383 R10) ───────────────────────────────────────────
// listExpenses (paginated, per_page=20, id DESC) + getExpense. DTO/coercion mirror
// read/dto-map.ts#toExpenseDto; quirk preserved from native: getExpense's SELECT
// does NOT sum receipts (detail amount_cents 0); only listExpenses sums.
//
// Row-scoping mirrors read/expense.ts: an auditor sees all; a non-auditor is scoped
// to expenses whose finance_unit is in scope (scopedFinanceUnitIds) — listExpenses
// filters the page + total (empty scope → empty page), getExpense 404s (null) an
// out-of-scope-but-EXISTING expense (G-019). DIVERGENCE: scopedFinanceUnitIds honours
// seesAllFinance, so a superuser-not-auditor sees ALL here (unlike bank_account/fints).

const EXPENSE_PER_PAGE = 20

export interface ExpenseDto {
  id: number
  projekt_id: number
  name_suffix: string
  state: string
  zahlung_iban: string | null
  zahlung_name: string
  zahlung_vwzk: string
  payed: string
  rejected: string
  created: string
  last_change: string
  amount_cents: number
}

export interface PaginatedExpensesDto {
  data: ExpenseDto[]
  meta: { current_page: number; last_page: number; per_page: number; total: number }
}

interface RawExpenseRow {
  id: string | number
  finance_unit_id: string | number
  project_id: string | number | null
  payee_name: string
  payee_iban: string | null
  payee_purpose: string | null
  payment_method: string
  state: string
  paid_at: Date | string | null
  created_at: Date | string
  amount_cents?: string | number | null
}

function toExpenseDto(r: RawExpenseRow): ExpenseDto {
  const created = toIsoZ(r.created_at)
  return {
    id: Number(r.id),
    projekt_id: r.project_id == null ? 0 : Number(r.project_id),
    name_suffix: r.payee_purpose ?? '',
    state: r.state,
    zahlung_iban: r.payee_iban,
    zahlung_name: r.payee_name,
    zahlung_vwzk: r.payee_purpose ?? '',
    payed: r.paid_at == null ? '' : toIsoZ(r.paid_at),
    rejected: r.state === 'rejected' ? created : '',
    created,
    last_change: created,
    amount_cents: r.amount_cents == null ? 0 : Number(r.amount_cents),
  }
}

export async function listExpenses(
  sql: Sql,
  page: number | undefined,
  scope: ScopeContext,
): Promise<PaginatedExpensesDto> {
  const p = Math.max(1, Number.isFinite(page) ? Math.floor(page as number) : 1)
  const offset = (p - 1) * EXPENSE_PER_PAGE
  const emptyMeta = { current_page: p, last_page: 1, per_page: EXPENSE_PER_PAGE, total: 0 }

  let rows: RawExpenseRow[]
  let total: number
  // Fast path is isAuditor ONLY (mirror read/expense.ts); a superuser-not-auditor
  // falls through to scopedFinanceUnitIds, which sees-all for it.
  if (scope.isAuditor) {
    rows = await sql<RawExpenseRow[]>`
      SELECT e.*, COALESCE((
        SELECT SUM(ri.amount_cents) FROM finance.receipt_item ri
        JOIN finance.receipt r ON r.id = ri.receipt_id
        WHERE r.expense_id = e.id
      ), 0)::bigint AS amount_cents
      FROM finance.expense e ORDER BY e.id DESC LIMIT ${EXPENSE_PER_PAGE} OFFSET ${offset}`
    const cnt = await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM finance.expense`
    total = cnt[0]?.c ?? 0
  } else {
    const scopeIds = await scopedFinanceUnitIds(sql, scope)
    if (scopeIds.length === 0) return { data: [], meta: emptyMeta }
    rows = await sql<RawExpenseRow[]>`
      SELECT e.*, COALESCE((
        SELECT SUM(ri.amount_cents) FROM finance.receipt_item ri
        JOIN finance.receipt r ON r.id = ri.receipt_id
        WHERE r.expense_id = e.id
      ), 0)::bigint AS amount_cents
      FROM finance.expense e WHERE e.finance_unit_id = ANY(${scopeIds as unknown as number[]})
      ORDER BY e.id DESC LIMIT ${EXPENSE_PER_PAGE} OFFSET ${offset}`
    const cnt = await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM finance.expense WHERE finance_unit_id = ANY(${scopeIds as unknown as number[]})`
    total = cnt[0]?.c ?? 0
  }
  return {
    data: rows.map(toExpenseDto),
    meta: {
      current_page: p,
      last_page: Math.max(1, Math.ceil(total / EXPENSE_PER_PAGE)),
      per_page: EXPENSE_PER_PAGE,
      total,
    },
  }
}

export async function getExpense(
  sql: Sql,
  id: string | number,
  scope: ScopeContext,
): Promise<ExpenseDto | null> {
  const rows = await sql<RawExpenseRow[]>`SELECT * FROM finance.expense WHERE id = ${id}`
  if (rows.length === 0) return null
  const e = rows[0]!
  if (!scope.isAuditor) {
    const scopeIds = await scopedFinanceUnitIds(sql, scope)
    if (!scopeIds.includes(Number(e.finance_unit_id))) return null
  }
  return toExpenseDto(e)
}

// ── expense write domain (#383 R9 — createExpense) ───────────────────────────
// Mirror of ExpenseServiceImpl.create + the write facade (write/index.ts#createExpense
// + write/dto-map.ts#fromCreateExpenseDto): resolve the project → its org_unit → the
// paired finance_unit (all LEAF-LOCAL: finance.project.org_unit_id +
// finance.finance_unit.org_unit_id — no kernel round-trip), gate the write on the
// actor's org-unit write scope (assertOrgUnitWritable — auditor refused, superuser
// bypasses), then INSERT the expense. state defaults to 'draft'; payment_method is
// fixed to 'bank_transfer' (as fromCreateExpenseDto injects); the StuFis-only DTO
// fields (name_suffix, address) are dropped exactly as the native mapper drops them.
// Returns the SAME toExpenseDto ExpenseDetail shape a subsequent getExpense yields —
// the detail read never sums receipts, so amount_cents is 0 for both (byte-match).

export interface CreateExpenseInput {
  projekt_id: number
  name_suffix?: string
  zahlung_name: string
  zahlung_iban?: string
  zahlung_vwzk?: string
  address?: string
}

export async function createExpense(
  sql: Sql,
  actor: ActorContext,
  input: CreateExpenseInput,
): Promise<ExpenseDto> {
  // Resolve project → org_unit (leaf-local finance.project) → finance_unit
  // (financeUnitDb.byOrgUnit analogue). Both reads stay inside the leaf DB.
  const proj = await sql<{ org_unit_id: string }[]>`
    SELECT org_unit_id FROM finance.project WHERE id = ${input.projekt_id}`
  if (proj.length === 0) throw new Error(`project ${input.projekt_id} not found`)
  const orgUnitId = proj[0]!.org_unit_id
  const fu = await sql<{ id: string }[]>`
    SELECT id FROM finance.finance_unit WHERE org_unit_id = ${orgUnitId}`
  if (fu.length === 0) {
    throw new Error(`finance_unit not found for org_unit ${orgUnitId} (project ${input.projekt_id})`)
  }
  // §11 write-scope backstop (mirror ExpenseServiceImpl.create).
  assertOrgUnitWritable(actor, orgUnitId)
  const rows = await sql<RawExpenseRow[]>`
    INSERT INTO finance.expense
      (finance_unit_id, project_id, payee_name, payee_iban, payee_purpose, payment_method)
    VALUES (${Number(fu[0]!.id)}, ${input.projekt_id}, ${input.zahlung_name},
            ${input.zahlung_iban ?? null}, ${input.zahlung_vwzk ?? null}, 'bank_transfer')
    RETURNING *`
  return toExpenseDto(rows[0]!)
}

// ═══════════════════════════════════════════════════════════════════════════════
// Vier-Augen approval family (#383 Lane C / R3) — port of
// services/write/approval-workflow.ts + approval-stages.ts + read/approval.ts.
//
// The largest single residual sub-lock. The leaf reproduces the native workflow
// EXACTLY except for the step-up LEVEL gate: the native #assertStepUp reads
// $lib/auth (financeStepUpEnforced / getActionPolicy / LOA), which the leaf cannot
// import. That gate stays in the ACL client (ServiceFinanceClient.signApproval /
// rejectApproval), which resolves step_up_loa/step_up_at and FORWARDS them; the leaf
// persists the forwarded values byte-identically (never generating its own now()).
// Everything else — org-scope guard, amount snapshot + tier, stage generation,
// per-stage eligibility + four-eyes, certifies-token payment_order signer map, and
// the finalise/reject state transitions — runs in the leaf store below.
// ═══════════════════════════════════════════════════════════════════════════════

export type ApprovableType = 'expense' | 'budget_plan' | 'project'
export type ApprovalMethod = 'manual' | 'helios'

/** One ordered signer stage from finanzordnung_profile.signer_stages (JSONB). */
export interface SignerStageDef {
  role: string
  required_group: string
  certifies: string[]
}

/** One decision-authority tier from finanzordnung_profile.decision_authority_tiers.
 *  `max_amount_cents === null` is the open-top tier (matches any amount). */
export interface Tier {
  max_amount_cents: number | null
  required_group: string
}

/** An insertable approval_stage (camelCase — mirror approval-stages.ts#BuiltStage). */
export interface BuiltStage {
  stageIndex: number
  role: string
  requiredGroup: string
  certifies: string[]
}

/** Map the profile's ordered signer stages to insertable rows. A decision-authority
 *  `tier` overrides the `required_group` of the ORDERING stage (the one whose
 *  `certifies` includes 'anordnung' — HV in the default KV→HV mode); Vier-Augen (the
 *  stage COUNT) is unaffected. Pure — mirror of approval-stages.ts#buildStages. */
export function buildStages(defs: SignerStageDef[], tier: Tier | undefined): BuiltStage[] {
  return defs.map((d, i) => ({
    stageIndex: i,
    role: d.role,
    requiredGroup:
      tier !== undefined && d.certifies.includes('anordnung') ? tier.required_group : d.required_group,
    certifies: d.certifies,
  }))
}

/** Resolve which tier governs an amount. Tiers sort ascending by max_amount_cents
 *  (null last); the first whose max is null or >= the amount matches. Empty → undefined
 *  (no override). Pure — mirror of approval-stages.ts#resolveTier. */
export function resolveTier(tiers: Tier[], amountCents: number): Tier | undefined {
  const sorted = [...tiers].sort((a, b) => {
    if (a.max_amount_cents === null) return 1
    if (b.max_amount_cents === null) return -1
    return a.max_amount_cents - b.max_amount_cents
  })
  return sorted.find((t) => t.max_amount_cents === null || amountCents <= t.max_amount_cents)
}

// ── internal row types + parsers ─────────────────────────────────────────────
interface ApprovalRecord {
  id: number
  approvable_type: ApprovableType
  approvable_id: number
  created_by: string
  amount_cents: number | null
  status: string
  current_stage_index: number
  method: ApprovalMethod
}
interface RawApprovalRow {
  id: string | number
  approvable_type: ApprovableType
  approvable_id: string | number
  created_by: string
  amount_cents: string | number | null
  status: string
  current_stage_index: number
  method: ApprovalMethod
}
function parseApproval(r: RawApprovalRow): ApprovalRecord {
  return {
    id: Number(r.id),
    approvable_type: r.approvable_type,
    approvable_id: Number(r.approvable_id),
    created_by: r.created_by,
    amount_cents: r.amount_cents === null ? null : Number(r.amount_cents),
    status: r.status,
    current_stage_index: r.current_stage_index,
    method: r.method,
  }
}

interface ApprovalStageRecord {
  id: number
  stage_index: number
  role: string
  required_group: string
  certifies: string[]
  state: string
  signer_user_id: string | null
}
interface RawApprovalStageRow {
  id: string | number
  stage_index: number
  role: string
  required_group: string
  certifies: string[]
  state: string
  signer_user_id: string | null
}
function parseApprovalStage(r: RawApprovalStageRow): ApprovalStageRecord {
  return {
    id: Number(r.id),
    stage_index: r.stage_index,
    role: r.role,
    required_group: r.required_group,
    certifies: r.certifies,
    state: r.state,
    signer_user_id: r.signer_user_id,
  }
}

// ── repo-boundary helpers (mirror bookkeeping-db / config-db) ─────────────────
async function approvalByIdForUpdate(tx: Sql, id: number): Promise<ApprovalRecord> {
  const rows = await tx<RawApprovalRow[]>`SELECT * FROM finance.approval WHERE id = ${id} FOR UPDATE`
  if (rows.length === 0) throw new Error(`approval ${id} not found`)
  return parseApproval(rows[0]!)
}

async function stagesForApproval(tx: Sql, approvalId: number): Promise<ApprovalStageRecord[]> {
  const rows = await tx<RawApprovalStageRow[]>`
    SELECT * FROM finance.approval_stage WHERE approval_id = ${approvalId} ORDER BY stage_index`
  return rows.map(parseApprovalStage)
}

interface StagePatch {
  state: 'approved' | 'rejected'
  signerUserId: string
  note: string | null
  stepUpLoa: number | null
  stepUpAt: string | null
}
async function updateStage(tx: Sql, stageId: number, patch: StagePatch): Promise<void> {
  await tx`
    UPDATE finance.approval_stage SET
      state = ${patch.state},
      signer_user_id = ${patch.signerUserId},
      acted_at = now(),
      note = ${patch.note},
      step_up_loa = ${patch.stepUpLoa},
      step_up_at = ${patch.stepUpAt}
    WHERE id = ${stageId}`
}

/** Decode a JSONB column value read through postgres-js into the JS shape the
 *  contract promises (TASK-009 fix round 5). postgres-js parses jsonb, so a proper
 *  row already arrives as an array/object — but the pre-fix backfill (and the
 *  pre-fix closeBudget statement write) stored JSON *strings* into jsonb, i.e. a
 *  jsonb STRING scalar ('"[{...}]"'), which postgres-js hands back as a JS string.
 *  Serving that verbatim put `"signerStages": "[{...}]"` on the wire and the
 *  finanzordnung page 500'd on `.map`. Migration 005 repairs such rows at rest;
 *  this is the read-boundary guarantee: unwrap one string layer, then REQUIRE the
 *  expected kind and fail loudly (naming the column) instead of letting a wrong
 *  shape travel to a consumer. */
export function decodeJsonbColumn<T>(value: unknown, kind: 'array' | 'object', column: string): T {
  let v = value
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      throw new Error(`[finance-store] ${column}: jsonb holds a non-JSON string scalar`)
    }
  }
  const ok = kind === 'array' ? Array.isArray(v) : typeof v === 'object' && v !== null && !Array.isArray(v)
  if (!ok) {
    const got = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
    throw new Error(`[finance-store] ${column}: expected a jsonb ${kind}, got ${got}`)
  }
  return v as T
}

/** Map a raw signer-config row to the contract shape (arrays guaranteed). */
function toSignerConfig(row: { signer_stages: unknown; decision_authority_tiers: unknown }): {
  signerStages: SignerStageDef[]
  decisionAuthorityTiers: Tier[]
} {
  return {
    signerStages: decodeJsonbColumn<SignerStageDef[]>(
      row.signer_stages, 'array', 'finanzordnung_profile.signer_stages'),
    decisionAuthorityTiers: decodeJsonbColumn<Tier[]>(
      row.decision_authority_tiers, 'array', 'finanzordnung_profile.decision_authority_tiers'),
  }
}

/** Read the active profile's Vier-Augen signer config (mirror config-db.ts#getSignerConfig).
 *  postgres-js returns JSONB already parsed; decodeJsonbColumn additionally unwraps a
 *  legacy double-encoded row and guarantees arrays. null when no profile row exists.
 *  Used internally by createApproval (within a transaction) AND exported as the
 *  R23-6 FinanceBackend#getSignerConfig route (plain sql, no transaction). */
export async function getSignerConfig(
  tx: Sql,
): Promise<{ signerStages: SignerStageDef[]; decisionAuthorityTiers: Tier[] } | null> {
  const rows = await tx<{ signer_stages: unknown; decision_authority_tiers: unknown }[]>`
    SELECT signer_stages, decision_authority_tiers FROM finance.finanzordnung_profile ORDER BY id LIMIT 1`
  if (!rows[0]) return null
  return toSignerConfig(rows[0])
}

/** Update the active profile's Vier-Augen signer config in place (mirror
 *  config-db.ts#updateSignerConfig — R23-6 / TASK-009 lane C). Targets the
 *  singleton row (lowest id); no row is inserted — null when there is none to
 *  update. The route re-checks the caller's forwarded groups (admin/it-admin)
 *  BEFORE calling this — this function itself performs no access check. */
export async function updateSignerConfig(
  sql: Sql,
  data: { signerStages: SignerStageDef[]; decisionAuthorityTiers: Tier[] },
): Promise<{ signerStages: SignerStageDef[]; decisionAuthorityTiers: Tier[] } | null> {
  const rows = await sql<{ signer_stages: unknown; decision_authority_tiers: unknown }[]>`
    UPDATE finance.finanzordnung_profile
       SET signer_stages = ${sql.json(data.signerStages as never) as never},
           decision_authority_tiers = ${sql.json(data.decisionAuthorityTiers as never) as never},
           updated_at = now()
     WHERE id = (SELECT id FROM finance.finanzordnung_profile ORDER BY id LIMIT 1)
    RETURNING signer_stages, decision_authority_tiers`
  if (!rows[0]) return null
  return toSignerConfig(rows[0])
}

/** The full finanzordnung_profile row (R23-6 / TASK-009 lane C) — the read-only
 *  rules-reference projection the finanzordnung page shows alongside the signer
 *  config editor. Mirror of config-db.ts#getFinanzordnungProfile/#parseProfile:
 *  numeric/bigint columns arrive as strings over postgres-js and are cast here. */
export interface FinanzordnungProfileDto {
  id: number
  bundesland: string
  deckungsfaehigkeit_pct: number
  reserve_base: 'contribution_income' | 'budget_volume'
  reserve_frei_amount_cents: number
  reserve_frei_bound: 'floor' | 'ceiling'
  reserve_betriebsmittel_amount_cents: number
  reserve_betriebsmittel_bound: 'floor' | 'ceiling'
  reserve_zweckgebunden_amount_cents: number
  reserve_zweckgebunden_bound: 'floor' | 'ceiling'
  carry_over_central: 'to_reserves' | 'carry_forward'
  carry_over_fachschaft: 'to_reserves' | 'carry_forward'
  retention_years: number
  retention_from: 'entlastung' | 'fiscal_year_end'
  inventar_threshold_cents: number
  handkasse_cap_cents: number | null
  majority_haushalt: string
  majority_nachtrag: string
  majority_entlastung: string
  created_at: string
  updated_at: string
}

interface RawFinanzordnungProfileRow {
  id: string
  bundesland: string
  deckungsfaehigkeit_pct: string
  reserve_base: 'contribution_income' | 'budget_volume'
  reserve_frei_amount_cents: string
  reserve_frei_bound: 'floor' | 'ceiling'
  reserve_betriebsmittel_amount_cents: string
  reserve_betriebsmittel_bound: 'floor' | 'ceiling'
  reserve_zweckgebunden_amount_cents: string
  reserve_zweckgebunden_bound: 'floor' | 'ceiling'
  carry_over_central: 'to_reserves' | 'carry_forward'
  carry_over_fachschaft: 'to_reserves' | 'carry_forward'
  retention_years: number
  retention_from: 'entlastung' | 'fiscal_year_end'
  inventar_threshold_cents: string
  handkasse_cap_cents: string | null
  majority_haushalt: string
  majority_nachtrag: string
  majority_entlastung: string
  created_at: Date | string
  updated_at: Date | string
}

function toFinanzordnungProfileDto(r: RawFinanzordnungProfileRow): FinanzordnungProfileDto {
  // Fix round 1 (review r1-finance-C1C2, LOW/lang:sql): field-by-field, not
  // `...r` — the query below now lists the DTO's own columns explicitly, but
  // building the DTO by spreading the raw row was the actual leak: it let
  // `signer_stages` / `decision_authority_tiers` (present on the row, absent
  // from FinanzordnungProfileDto) — and any FUTURE column — silently join
  // this route's public HTTP response.
  return {
    id: Number(r.id),
    bundesland: r.bundesland,
    deckungsfaehigkeit_pct: Number(r.deckungsfaehigkeit_pct),
    reserve_base: r.reserve_base,
    reserve_frei_amount_cents: Number(r.reserve_frei_amount_cents),
    reserve_frei_bound: r.reserve_frei_bound,
    reserve_betriebsmittel_amount_cents: Number(r.reserve_betriebsmittel_amount_cents),
    reserve_betriebsmittel_bound: r.reserve_betriebsmittel_bound,
    reserve_zweckgebunden_amount_cents: Number(r.reserve_zweckgebunden_amount_cents),
    reserve_zweckgebunden_bound: r.reserve_zweckgebunden_bound,
    carry_over_central: r.carry_over_central,
    carry_over_fachschaft: r.carry_over_fachschaft,
    retention_years: r.retention_years,
    retention_from: r.retention_from,
    inventar_threshold_cents: Number(r.inventar_threshold_cents),
    handkasse_cap_cents: r.handkasse_cap_cents === null ? null : Number(r.handkasse_cap_cents),
    majority_haushalt: r.majority_haushalt,
    majority_nachtrag: r.majority_nachtrag,
    majority_entlastung: r.majority_entlastung,
    created_at: toIsoZ(r.created_at),
    updated_at: toIsoZ(r.updated_at),
  }
}

/** The installation has at most one profile row — returns it or null. Fix
 *  round 1 (review r1-finance-C1C2, LOW/lang:sql): lists the DTO's own
 *  columns explicitly instead of `SELECT *` — the leaf's HTTP surface serves
 *  this row directly (getFinanzordnungProfileHandler), so a `SELECT *` here
 *  put every current AND FUTURE column (including the JSONB
 *  signer_stages/decision_authority_tiers, which are NOT part of
 *  FinanzordnungProfileDto) on the wire via the `...r` spread below. */
export async function getFinanzordnungProfile(sql: Sql): Promise<FinanzordnungProfileDto | null> {
  const rows = await sql<RawFinanzordnungProfileRow[]>`
    SELECT id, bundesland, deckungsfaehigkeit_pct, reserve_base,
           reserve_frei_amount_cents, reserve_frei_bound,
           reserve_betriebsmittel_amount_cents, reserve_betriebsmittel_bound,
           reserve_zweckgebunden_amount_cents, reserve_zweckgebunden_bound,
           carry_over_central, carry_over_fachschaft,
           retention_years, retention_from, inventar_threshold_cents, handkasse_cap_cents,
           majority_haushalt, majority_nachtrag, majority_entlastung,
           created_at, updated_at
    FROM finance.finanzordnung_profile ORDER BY id LIMIT 1`
  return rows[0] ? toFinanzordnungProfileDto(rows[0]) : null
}

/** Resolve the org_unit an approval is scoped to (mirror #resolveApprovableOrgUnit):
 *  expense → its finance_unit's org_unit; project → the project's org_unit; budget_plan
 *  → the central finance_unit's org_unit. LEAF-LOCAL (no kernel round-trip). */
async function resolveApprovableOrgUnit(tx: Sql, type: ApprovableType, approvableId: number): Promise<string> {
  if (type === 'project') {
    const rows = await tx<{ org_unit_id: string }[]>`
      SELECT org_unit_id FROM finance.project WHERE id = ${approvableId} FOR UPDATE`
    if (rows.length === 0) throw new Error(`project ${approvableId} not found`)
    return rows[0]!.org_unit_id
  }
  if (type === 'budget_plan') {
    const rows = await tx<{ org_unit_id: string }[]>`
      SELECT org_unit_id FROM finance.finance_unit WHERE kind = 'central'`
    if (rows.length === 0) throw new Error('central finance_unit not found')
    return rows[0]!.org_unit_id
  }
  const exp = await tx<{ finance_unit_id: string }[]>`
    SELECT finance_unit_id FROM finance.expense WHERE id = ${approvableId} FOR UPDATE`
  if (exp.length === 0) throw new Error(`expense ${approvableId} not found`)
  const unit = await tx<{ org_unit_id: string }[]>`
    SELECT org_unit_id FROM finance.finance_unit WHERE id = ${exp[0]!.finance_unit_id}`
  if (unit.length === 0) {
    throw new Error(`finance_unit ${exp[0]!.finance_unit_id} not found for expense ${approvableId}`)
  }
  return unit[0]!.org_unit_id
}

/** Amount snapshot for tier resolution (mirror #resolveAmount): expense = Σ
 *  receipt_item.amount_cents; non-expense → null (tiers apply to expenses only). */
async function resolveApprovalAmount(tx: Sql, type: ApprovableType, approvableId: number): Promise<number | null> {
  if (type !== 'expense') return null
  const rows = await tx<{ total: string | null }[]>`
    SELECT COALESCE(SUM(ri.amount_cents), 0)::text AS total
    FROM finance.receipt_item ri
    JOIN finance.receipt r ON r.id = ri.receipt_id
    WHERE r.expense_id = ${approvableId}`
  return rows[0]?.total != null ? Number(rows[0].total) : 0
}

/** Per-stage eligibility + four-eyes guards (mirror #assertSignerEligible). Order
 *  matters: group eligibility, then no-self-approval, then distinct-signers. */
function assertSignerEligible(
  actor: ActorContext,
  stage: ApprovalStageRecord,
  approval: ApprovalRecord,
  stages: readonly ApprovalStageRecord[],
): void {
  const groups = actor.groups ?? []
  if (!groups.includes(stage.required_group)) {
    throw new NotEligibleForStage(actor.userId, stage.required_group)
  }
  if (actor.userId === approval.created_by) {
    throw new SelfApprovalForbidden(actor.userId)
  }
  if (stages.some((s) => s.id !== stage.id && s.signer_user_id === actor.userId)) {
    throw new DuplicateSignerForbidden(actor.userId)
  }
}

/** The signer of the (single) completed stage whose `certifies` includes `token`
 *  (mirror #signerFor). Resolution is by token, independent of stage order. */
function signerFor(stages: readonly ApprovalStageRecord[], token: string): string {
  const stage = stages.find((s) => s.certifies.includes(token) && s.signer_user_id !== null)
  if (stage === undefined || stage.signer_user_id === null) {
    throw new Error(`finaliseApproved: no signer certifies '${token}'`)
  }
  return stage.signer_user_id
}

/** Void any still-pending payment_order on an expense (mirror #voidPendingPaymentOrders). */
async function voidPendingPaymentOrders(tx: Sql, expenseId: number): Promise<void> {
  const orders = await tx<{ id: string; state: string }[]>`
    SELECT id, state FROM finance.payment_order WHERE expense_id = ${expenseId} ORDER BY id`
  for (const o of orders) {
    if (o.state === 'pending') {
      await tx`UPDATE finance.payment_order SET state = 'voided' WHERE id = ${o.id}`
    }
  }
}

/** Finalise an approval whose last stage just signed (mirror #finaliseApproved). For
 *  an expense, maps the completed stages' signers onto the payment_order columns by
 *  `certifies` token and creates + authorises it, then flips the expense to approved.
 *  For budget_plan / project, flips the approvable to approved. Then marks the approval
 *  approved + decided. Re-reads stages so the just-signed final stage is included. */
async function finaliseApproved(tx: Sql, approval: ApprovalRecord): Promise<void> {
  const stages = await stagesForApproval(tx, approval.id)
  if (approval.approvable_type === 'expense') {
    // F1-FIX-05-K (H20): one expense, one live payment_order. The partial unique
    // index payment_order_one_live_per_expense_idx is the backstop; this check turns
    // the common case into a typed 409 instead of a constraint error.
    const live = await tx<{ id: string }[]>`
      SELECT id FROM finance.payment_order
      WHERE expense_id = ${approval.approvable_id} AND state <> 'voided' LIMIT 1`
    if (live.length > 0) throw new PaymentOrderExistsError(`expense ${approval.approvable_id}`)
    const order = await tx<{ id: string }[]>`
      INSERT INTO finance.payment_order
        (expense_id, anordnung_by, feststellung_sachlich_by, feststellung_rechnerisch_by)
      VALUES (${approval.approvable_id}, ${signerFor(stages, 'anordnung')},
              ${signerFor(stages, 'sachlich')}, ${signerFor(stages, 'rechnerisch')})
      RETURNING id`
    await tx`UPDATE finance.payment_order SET state = 'authorised' WHERE id = ${order[0]!.id}`
    await tx`UPDATE finance.expense SET state = 'approved' WHERE id = ${approval.approvable_id}`
  } else if (approval.approvable_type === 'budget_plan') {
    await tx`UPDATE finance.budget_plan SET state = 'approved' WHERE id = ${approval.approvable_id}`
  } else {
    await tx`UPDATE finance.project SET state = 'approved' WHERE id = ${approval.approvable_id}`
  }
  await tx`
    UPDATE finance.approval SET
      status = 'approved', current_stage_index = ${approval.current_stage_index + 1},
      rejected_by = NULL, rejection_reason = NULL, decided_at = now()
    WHERE id = ${approval.id}`
}

/** The step-up proof the ACL client resolves + forwards (never leaf-generated).
 *  Below the step-up threshold both are null; at/above, loa + an ISO-Z anchor. */
export interface ForwardedStepUp {
  stepUpLoa: number | null
  stepUpAt: string | null
}

/** Open a pending approval against an approvable (mirror ApprovalWorkflowService
 *  .createApproval). Resolves the org-scope guard + amount snapshot + tier, loads the
 *  active signer config, and inserts the approval + its per-stage rows (all pending).
 *  No payment_order is created here. Returns { approval_id }. */
export async function createApproval(
  sql: Sql,
  actor: ActorContext,
  input: { approvableType: ApprovableType; approvableId: number; method?: ApprovalMethod },
): Promise<{ approval_id: number }> {
  try {
    return await openApprovalTx(sql, actor, input)
  } catch (err) {
    // Two requests that raced past the pending check (possible only where no row
    // lock serialises them, e.g. a budget_plan) meet the partial unique index.
    if (isUniqueViolationOn(err, 'approval_one_open_per_approvable_idx')) {
      throw new ApprovalAlreadyOpenError(input.approvableType, input.approvableId)
    }
    throw err
  }
}

/** Expense states from which no new approval may be opened (H20): an approved or
 *  paid expense already has its payment_order. */
const EXPENSE_STATES_CLOSED_FOR_APPROVAL = new Set(['approved', 'paid'])

async function openApprovalTx(
  sql: Sql,
  actor: ActorContext,
  input: { approvableType: ApprovableType; approvableId: number; method?: ApprovalMethod },
): Promise<{ approval_id: number }> {
  return sql.begin(async (tx) => {
    const t = tx as unknown as Sql
    // §11 create-time write-scope guard — runs FIRST so an unauthorised actor never
    // materialises an approval row. For an expense / project it also takes the
    // approvable's row lock, which serialises concurrent requests for it.
    const orgUnitId = await resolveApprovableOrgUnit(t, input.approvableType, input.approvableId)
    assertOrgUnitWritable(actor, orgUnitId)

    // F1-FIX-05-K (H20): one open approval per approvable, and no new approval for an
    // expense that is already approved / paid. Checked under the row lock above; the
    // partial unique index approval_one_open_per_approvable_idx is the backstop.
    if (input.approvableType === 'expense') {
      const st = await t<{ state: string }[]>`
        SELECT state FROM finance.expense WHERE id = ${input.approvableId}`
      const state = st[0]?.state
      if (state !== undefined && EXPENSE_STATES_CLOSED_FOR_APPROVAL.has(state)) {
        throw new ApprovableNotRequestableError('expense', input.approvableId, state)
      }
    }
    const open = await t<{ id: string }[]>`
      SELECT id FROM finance.approval
      WHERE approvable_type = ${input.approvableType} AND approvable_id = ${input.approvableId}
        AND status = 'pending'
      LIMIT 1`
    if (open.length > 0) throw new ApprovalAlreadyOpenError(input.approvableType, input.approvableId)

    const amountCents = await resolveApprovalAmount(t, input.approvableType, input.approvableId)
    const config = await getSignerConfig(t)
    if (config === null) throw new NoActiveProfileError()

    const tier = amountCents === null ? undefined : resolveTier(config.decisionAuthorityTiers, amountCents)
    const stages = buildStages(config.signerStages, tier)

    const appr = await t<RawApprovalRow[]>`
      INSERT INTO finance.approval (approvable_type, approvable_id, created_by, amount_cents, method)
      VALUES (${input.approvableType}, ${input.approvableId}, ${actor.userId}, ${amountCents},
              ${input.method ?? 'manual'})
      RETURNING *`
    const approvalId = Number(appr[0]!.id)
    for (const s of stages) {
      await t`
        INSERT INTO finance.approval_stage (approval_id, stage_index, role, required_group, certifies)
        VALUES (${approvalId}, ${s.stageIndex}, ${s.role}, ${s.requiredGroup}, ${s.certifies})`
    }
    return { approval_id: approvalId }
  }) as Promise<{ approval_id: number }>
}

/** Sign the current stage as `actor` (mirror ApprovalWorkflowService.signStage).
 *  Locks the approval, runs the eligibility + four-eyes guards, records the sign-off
 *  (persisting the FORWARDED step_up_loa/step_up_at verbatim), and either advances to
 *  the next stage or — on the final stage — finalises the approvable. Returns the
 *  refreshed status ('pending' while stages remain, 'approved' once the final signs). */
export async function signApproval(
  sql: Sql,
  actor: ActorContext,
  approvalId: number,
  opts: { note?: string } & ForwardedStepUp,
): Promise<string> {
  try {
    return await signApprovalTx(sql, actor, approvalId, opts)
  } catch (err) {
    // Backstop for finaliseApproved's live-order check (a concurrent finalisation).
    if (isUniqueViolationOn(err, 'payment_order_one_live_per_expense_idx')) {
      throw new PaymentOrderExistsError(`the expense of approval ${approvalId}`)
    }
    throw err
  }
}

async function signApprovalTx(
  sql: Sql,
  actor: ActorContext,
  approvalId: number,
  opts: { note?: string } & ForwardedStepUp,
): Promise<string> {
  return sql.begin(async (tx) => {
    const t = tx as unknown as Sql
    const approval = await approvalByIdForUpdate(t, approvalId)
    if (approval.status !== 'pending') throw new AlreadyDecidedError(approval.id, approval.status)
    if (approval.method === 'helios') throw new HeliosApprovalNotManuallySignable(approval.id)
    const stages = await stagesForApproval(t, approval.id)
    const current = stages.find((s) => s.stage_index === approval.current_stage_index)
    if (current === undefined || current.state !== 'pending') {
      throw new WrongStageError(
        `approval ${approval.id} has no pending stage at index ${approval.current_stage_index}`,
      )
    }
    assertSignerEligible(actor, current, approval, stages)

    await updateStage(t, current.id, {
      state: 'approved',
      signerUserId: actor.userId,
      note: opts.note ?? null,
      stepUpLoa: opts.stepUpLoa,
      stepUpAt: opts.stepUpAt,
    })

    const isFinalStage = approval.current_stage_index >= stages.length - 1
    if (!isFinalStage) {
      await t`
        UPDATE finance.approval SET
          status = 'pending', current_stage_index = ${approval.current_stage_index + 1},
          rejected_by = NULL, rejection_reason = NULL, decided_at = NULL
        WHERE id = ${approval.id}`
      return 'pending'
    }
    await finaliseApproved(t, approval)
    return 'approved'
  }) as Promise<string>
}

/** Reject the current stage as `actor` with a mandatory note (mirror rejectStage).
 *  Same eligibility guards as signApproval; sets the stage + approval to rejected. For
 *  an expense, voids any pending payment_order and flips the expense to rejected;
 *  budget_plan / project flip to rejected. Returns the 'rejected' status. */
export async function rejectApproval(
  sql: Sql,
  actor: ActorContext,
  approvalId: number,
  opts: { note: string } & ForwardedStepUp,
): Promise<string> {
  const note = opts.note?.trim() ?? ''
  if (note.length === 0) throw new RejectionNoteRequired()
  return sql.begin(async (tx) => {
    const t = tx as unknown as Sql
    const approval = await approvalByIdForUpdate(t, approvalId)
    if (approval.status !== 'pending') throw new AlreadyDecidedError(approval.id, approval.status)
    if (approval.method === 'helios') throw new HeliosApprovalNotManuallySignable(approval.id)
    const stages = await stagesForApproval(t, approval.id)
    const current = stages.find((s) => s.stage_index === approval.current_stage_index)
    if (current === undefined || current.state !== 'pending') {
      throw new WrongStageError(
        `approval ${approval.id} has no pending stage at index ${approval.current_stage_index}`,
      )
    }
    assertSignerEligible(actor, current, approval, stages)

    await updateStage(t, current.id, {
      state: 'rejected',
      signerUserId: actor.userId,
      note,
      stepUpLoa: opts.stepUpLoa,
      stepUpAt: opts.stepUpAt,
    })

    if (approval.approvable_type === 'expense') {
      await voidPendingPaymentOrders(t, approval.approvable_id)
      await t`UPDATE finance.expense SET state = 'rejected' WHERE id = ${approval.approvable_id}`
    } else if (approval.approvable_type === 'budget_plan') {
      await t`UPDATE finance.budget_plan SET state = 'rejected' WHERE id = ${approval.approvable_id}`
    } else {
      await t`UPDATE finance.project SET state = 'rejected' WHERE id = ${approval.approvable_id}`
    }

    await t`
      UPDATE finance.approval SET
        status = 'rejected', current_stage_index = ${approval.current_stage_index},
        rejected_by = ${actor.userId}, rejection_reason = ${note}, decided_at = now()
      WHERE id = ${approval.id}`
    return 'rejected'
  }) as Promise<string>
}

/** Whether budget approvals should open as method='helios' (mirror the write facade's
 *  requestBudgetApproval): reads the singleton finance_helios_settings.enabled. */
export async function heliosBudgetApprovalEnabled(sql: Sql): Promise<boolean> {
  const rows = await sql<{ enabled: boolean }[]>`
    SELECT enabled FROM finance.finance_helios_settings ORDER BY id LIMIT 1`
  return rows[0]?.enabled === true
}

// ── pending-approval read (mirror read/approval.ts + dto-map.ts#toPendingApprovalDto) ─
// Returns pending approvals of ALL approvable types, each with its per-stage sign-off
// steps (from finance.approval_signers_v), amount snapshot + current-stage group.
// Scoped: expense via expense.finance_unit_id, budget_plan via budget_section
// .finance_unit_id, project via project.org_unit_id. seesAll (auditor OR superuser)
// sees every pending approval. ORDER BY a.id (native parity).

export interface PendingApprovalStageDto {
  stage_index: number
  role: string
  required_group: string
  user_id: string | null
  state: string
  at: string | null
  note: string | null
}
export interface PendingApprovalDto {
  id: number
  approvable_type: string
  approvable_id: number
  approvable_title: string | null
  created_by_id: string
  status: string
  created_at: string | null
  amount_cents: number | null
  current_stage_index: number
  current_required_group: string | null
  stages: PendingApprovalStageDto[]
  // TASK-009-FU3: 'manual' | 'helios' — lets gremion-ui mirror this leaf's own
  // HELIOS_NOT_MANUALLY_SIGNABLE refusal (signApproval/rejectApproval below)
  // client-side instead of offering a Freigeben it will always reject.
  // Narrowed via parseApprovalMethod below (house review FU3 round 2, HIGH) —
  // this field's declared type is the DB-enforced contract (migration 001's
  // CHECK (method IN ('manual','helios'))), not a runtime guarantee about
  // what the driver actually handed back.
  method: ApprovalMethod
}

interface RawPendingApprovalRow {
  id: string | number
  approvable_type: string
  approvable_id: string | number
  approvable_title: string | null
  created_by: string
  status: string
  created_at: Date | string | null
  amount_cents: string | number | null
  current_stage_index: number
  method: ApprovalMethod
  stages: Array<{
    stage_index: number
    role: string
    required_group: string
    user_id: string | null
    state: string
    at: Date | string | null
    note: string | null
  }>
}

/** House review (FU3 round 2, HIGH): `finance.approval.method` is TEXT with a
 *  migration-001 CHECK (method IN ('manual','helios')) constraint, but
 *  postgres-js's `sql<RawPendingApprovalRow[]>` generic is compile-time-only —
 *  it does not runtime-validate the driver's actual return value. Typing the
 *  row's `method` as `ApprovalMethod` above documents the expected DB-enforced
 *  contract; this function is the only place that can actually catch a
 *  violation of it (a dropped/altered CHECK constraint, a direct SQL edit, or
 *  a future migration adding a third value before this mapper is updated).
 *  Fails CLOSED as 'helios' rather than 'manual': 'manual' is what gates an
 *  enabled Freigeben on the gremion-ui side (approvals-eligibility.ts's
 *  isHeliosDecided), so silently defaulting an unrecognised value to it would
 *  be the dangerous direction. Logs loudly, naming the context and the bad
 *  value so an operator can find the corrupt row. */
export function parseApprovalMethod(raw: string, context: string): ApprovalMethod {
  if (raw === 'manual' || raw === 'helios') return raw
  console.error(
    `[finance] approval.method: unexpected value ${JSON.stringify(raw)} for ${context} — ` +
      "migration 001's CHECK (method IN ('manual','helios')) should make this impossible; " +
      "failing closed as 'helios' (hides Freigeben) rather than silently defaulting to 'manual'.",
  )
  return 'helios'
}

/** Mirror of dto-map.ts#toPendingApprovalDto: 'budget_plan' → 'budget' for StuFis
 *  parity; builds the ordered stages, resolves the current stage's required_group. */
export function toPendingApprovalDto(row: RawPendingApprovalRow): PendingApprovalDto {
  const t = row.approvable_type === 'budget_plan' ? 'budget' : row.approvable_type
  const stages = row.stages.map((s) => ({
    stage_index: s.stage_index,
    role: s.role,
    required_group: s.required_group,
    user_id: s.user_id,
    state: s.state,
    at: s.at == null ? null : s.at instanceof Date ? s.at.toISOString() : String(s.at),
    note: s.note,
  }))
  const current = stages.find((s) => s.stage_index === row.current_stage_index)
  return {
    id: Number(row.id),
    approvable_type: t,
    approvable_id: Number(row.approvable_id),
    approvable_title: row.approvable_title,
    created_by_id: row.created_by,
    status: row.status,
    created_at: row.created_at == null ? null : toIsoZ(row.created_at),
    amount_cents: row.amount_cents == null ? null : Number(row.amount_cents),
    current_stage_index: row.current_stage_index,
    current_required_group: current?.required_group ?? null,
    stages,
    method: parseApprovalMethod(row.method, `approval ${row.id}`),
  }
}

export async function listPendingApprovals(sql: Sql, scope: ScopeContext): Promise<PendingApprovalDto[]> {
  if (seesAllFinance(scope)) {
    const rows = await sql<RawPendingApprovalRow[]>`
      SELECT a.id, a.approvable_type, a.approvable_id, a.created_by, a.status, a.created_at,
             a.amount_cents, a.current_stage_index, a.method,
             CASE a.approvable_type
               WHEN 'expense' THEN (SELECT COALESCE(NULLIF(e.payee_purpose, ''), e.payee_name) FROM finance.expense e WHERE e.id = a.approvable_id)
               WHEN 'project' THEN (SELECT p.name FROM finance.project p WHERE p.id = a.approvable_id)
               WHEN 'budget_plan' THEN (SELECT bp.name FROM finance.budget_plan bp WHERE bp.id = a.approvable_id)
             END AS approvable_title,
             COALESCE(
               json_agg(
                 json_build_object(
                   'stage_index', s.stage_index, 'role', s.role,
                   'required_group', s.required_group, 'user_id', s.user_id,
                   'state', s.state, 'at', s.at, 'note', s.note
                 ) ORDER BY s.stage_index
               ) FILTER (WHERE s.stage_index IS NOT NULL),
               '[]'
             ) AS stages
      FROM finance.approval a
      LEFT JOIN finance.approval_signers_v s ON s.approval_id = a.id
      WHERE a.status = 'pending'
      GROUP BY a.id
      ORDER BY a.id`
    return rows.map(toPendingApprovalDto)
  }
  if (scope.scopedOrgUnitIds.length === 0) return []
  const fuScope = await scopedFinanceUnitIds(sql, scope)
  if (fuScope.length === 0) return []
  const rows = await sql<RawPendingApprovalRow[]>`
    SELECT a.id, a.approvable_type, a.approvable_id, a.created_by, a.status, a.created_at,
           a.amount_cents, a.current_stage_index, a.method,
           CASE a.approvable_type
             WHEN 'expense' THEN (SELECT COALESCE(NULLIF(e.payee_purpose, ''), e.payee_name) FROM finance.expense e WHERE e.id = a.approvable_id)
             WHEN 'project' THEN (SELECT p.name FROM finance.project p WHERE p.id = a.approvable_id)
             WHEN 'budget_plan' THEN (SELECT bp.name FROM finance.budget_plan bp WHERE bp.id = a.approvable_id)
           END AS approvable_title,
           COALESCE(
             json_agg(
               json_build_object(
                 'stage_index', s.stage_index, 'role', s.role,
                 'required_group', s.required_group, 'user_id', s.user_id,
                 'state', s.state, 'at', s.at, 'note', s.note
               ) ORDER BY s.stage_index
             ) FILTER (WHERE s.stage_index IS NOT NULL),
             '[]'
           ) AS stages
    FROM finance.approval a
    LEFT JOIN finance.approval_signers_v s ON s.approval_id = a.id
    WHERE a.status = 'pending'
      AND (
        (a.approvable_type = 'budget_plan' AND EXISTS (
          SELECT 1 FROM finance.budget_section bs
          WHERE bs.budget_plan_id = a.approvable_id
            AND bs.finance_unit_id = ANY(${fuScope as unknown as number[]})
        ))
        OR
        (a.approvable_type = 'project' AND EXISTS (
          SELECT 1 FROM finance.project p
          WHERE p.id = a.approvable_id
            AND p.org_unit_id = ANY(${scope.scopedOrgUnitIds as unknown as string[]})
        ))
        OR
        (a.approvable_type = 'expense' AND EXISTS (
          SELECT 1 FROM finance.expense e
          WHERE e.id = a.approvable_id
            AND e.finance_unit_id = ANY(${fuScope as unknown as number[]})
        ))
      )
    GROUP BY a.id
    ORDER BY a.id`
  return rows.map(toPendingApprovalDto)
}

// ── budget actuals helper (#383 Lane B) ──────────────────────────────────────
// Mirror of repositories/bookkeeping-db.ts#actualsForPlan (§5.3 Kameralistik): the
// Σ of POSTED bookings per budget_titel for the plan's OWN fiscal year (a struck /
// draft booking does NOT count; a booking corrected into another year is excluded by
// the fiscal_year_id match). Underpins the budget-detail `booked` and the interim
// statement `ist`. Returns titel_id → booked cents.
//
// #410 FIN-3 sign convention: booking.amount_cents is bank-signed (an expense
// booking is NEGATIVE, an income booking POSITIVE) while `booked` is consumed as
// budget-consumption cents (positive = consumed). Sum with a budget_type-aware
// sign — NOT ABS, which would double-count a struck(-X)+rebooked(+Y) correction
// pair instead of netting it. Keep in LOCKSTEP with
// gremion-ui/src/lib/server/finance/repositories/bookkeeping-db.ts#actualsForPlan.
async function actualsForPlan(sql: Sql, planId: string | number): Promise<Map<number, number>> {
  const rows = await sql<{ budget_titel_id: string; booked: string }[]>`
    SELECT b.budget_titel_id,
           SUM(CASE WHEN bg.budget_type = 'income' THEN b.amount_cents ELSE -b.amount_cents END)::text AS booked
    FROM finance.booking b
    JOIN finance.budget_titel bt ON bt.id = b.budget_titel_id
    JOIN finance.budget_group bg ON bg.id = bt.budget_group_id
    JOIN finance.budget_section bs ON bs.id = bg.budget_section_id
    JOIN finance.budget_plan bp ON bp.id = bs.budget_plan_id
    WHERE bp.id = ${planId}
      AND b.state = 'posted'
      AND b.fiscal_year_id = bp.fiscal_year_id
    GROUP BY b.budget_titel_id`
  return new Map(rows.map((r) => [Number(r.budget_titel_id), Number(r.booked)]))
}

// ── budget read domain (#383 Lane B) ─────────────────────────────────────────
// getBudget (list) + getBudgetPlan (detail). DTO/coercion mirror read/budget.ts +
// dto-map.ts (BudgetPlan / BudgetPlanDetail / BudgetGroupDetail / BudgetItem):
//   BudgetPlan       = { id, von, bis, state, groups:[] }   (list ships an empty groups)
//   BudgetPlanDetail = { id, name, von, bis, state, fiscal_year_id, approved_by,
//                        approved_at, groups:[{ id, name, budget_type, items:[…] }] }
//   BudgetItem       = { id, titel_nr, titel_name, value=planned, booked=actuals,
//                        remaining=planned−booked }
// von/bis come from finance.fiscal_year.{start_date,end_date} (DATE → YYYY-MM-DD).
//
// Row-scoping mirrors read/budget.ts: an auditor sees all; a non-auditor is scoped via
// scopedFinanceUnitIds (which honours seesAllFinance) — getBudget DISTINCT-filters the
// list over budget_section.finance_unit_id ∈ scope (empty scope → []), getBudgetPlan
// 404s (null) an out-of-scope-but-EXISTING plan (G-019 anti-probing via the section
// EXISTS visibility check). DIVERGENCE: a superuser-not-auditor SEES ALL here (the
// scopedFinanceUnitIds see-all branch), like expense/receipt.

export interface BudgetPlanDto {
  id: number
  von: string
  bis: string
  state: string
  groups: []
}

export interface BudgetItemDto {
  id: number
  titel_nr: string
  titel_name: string
  value: number
  booked: number
  remaining: number
}

export interface BudgetGroupDetailDto {
  id: number
  name: string
  budget_type: string
  items: BudgetItemDto[]
}

export interface BudgetPlanDetailDto {
  id: number
  name: string | null
  von: string
  bis: string
  state: string
  fiscal_year_id: number | null
  approved_by: string | null
  approved_at: string | null
  groups: BudgetGroupDetailDto[]
}

interface RawBudgetPlanRow {
  id: string | number
  name: string
  state: string
  fiscal_year_id: string | number
  fy_start: Date | string
  fy_end: Date | string
  approved_by: string | null
  approved_at: Date | string | null
}

interface RawBudgetGroupRow {
  id: string | number
  name: string
  budget_type: string
  budget_section_id: string | number
}

interface RawBudgetTitelRow {
  id: string | number
  budget_group_id: string | number
  titel_nr: string | null
  titel_name: string
  planned_cents: string | number
}

function toBudgetPlanDto(r: RawBudgetPlanRow): BudgetPlanDto {
  return { id: Number(r.id), von: toDateStr(r.fy_start), bis: toDateStr(r.fy_end), state: r.state, groups: [] }
}

function toBudgetItemDto(r: RawBudgetTitelRow, booked: number): BudgetItemDto {
  const planned = Number(r.planned_cents)
  return {
    id: Number(r.id),
    titel_nr: r.titel_nr ?? '',
    titel_name: r.titel_name,
    value: planned,
    booked,
    remaining: planned - booked,
  }
}

export async function getBudget(sql: Sql, scope: ScopeContext): Promise<BudgetPlanDto[]> {
  if (scope.isAuditor) {
    const rows = await sql<RawBudgetPlanRow[]>`
      SELECT bp.id, bp.name, bp.state, bp.fiscal_year_id, bp.approved_by, bp.approved_at,
             fy.name AS fy_name, fy.start_date AS fy_start, fy.end_date AS fy_end
      FROM finance.budget_plan bp
      JOIN finance.fiscal_year fy ON fy.id = bp.fiscal_year_id
      ORDER BY bp.id DESC`
    return rows.map(toBudgetPlanDto)
  }
  const scopeIds = await scopedFinanceUnitIds(sql, scope)
  if (scopeIds.length === 0) return []
  const rows = await sql<RawBudgetPlanRow[]>`
    SELECT DISTINCT bp.id, bp.name, bp.state, bp.fiscal_year_id, bp.approved_by, bp.approved_at,
           fy.name AS fy_name, fy.start_date AS fy_start, fy.end_date AS fy_end
    FROM finance.budget_plan bp
    JOIN finance.fiscal_year fy ON fy.id = bp.fiscal_year_id
    JOIN finance.budget_section bs ON bs.budget_plan_id = bp.id
    WHERE bs.finance_unit_id = ANY(${scopeIds as unknown as number[]})
    ORDER BY bp.id DESC`
  return rows.map(toBudgetPlanDto)
}

export async function getBudgetPlan(
  sql: Sql,
  id: string | number,
  scope: ScopeContext,
): Promise<BudgetPlanDetailDto | null> {
  const planRows = await sql<RawBudgetPlanRow[]>`
    SELECT bp.id, bp.name, bp.state, bp.fiscal_year_id, bp.approved_by, bp.approved_at,
           fy.name AS fy_name, fy.start_date AS fy_start, fy.end_date AS fy_end
    FROM finance.budget_plan bp
    JOIN finance.fiscal_year fy ON fy.id = bp.fiscal_year_id
    WHERE bp.id = ${id}`
  if (planRows.length === 0) return null
  const plan = planRows[0]!

  if (!scope.isAuditor) {
    const scopeIds = await scopedFinanceUnitIds(sql, scope)
    const visibility = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(
        SELECT 1 FROM finance.budget_section
        WHERE budget_plan_id = ${id}
          AND finance_unit_id = ANY(${scopeIds as unknown as number[]})
      ) AS exists`
    if (!visibility[0]?.exists) return null
  }

  const groups = await sql<RawBudgetGroupRow[]>`
    SELECT bg.id, bg.name, bg.budget_type, bg.budget_section_id
    FROM finance.budget_group bg
    JOIN finance.budget_section bs ON bs.id = bg.budget_section_id
    WHERE bs.budget_plan_id = ${id}
    ORDER BY bg.id`
  const titel = await sql<RawBudgetTitelRow[]>`
    SELECT bt.id, bt.budget_group_id, bt.titel_nr, bt.titel_name, bt.planned_cents
    FROM finance.budget_titel bt
    JOIN finance.budget_group bg ON bg.id = bt.budget_group_id
    JOIN finance.budget_section bs ON bs.id = bg.budget_section_id
    WHERE bs.budget_plan_id = ${id}
    ORDER BY bt.id`
  const actuals = await actualsForPlan(sql, id)

  const titelByGroup = new Map<number, RawBudgetTitelRow[]>()
  for (const t of titel) {
    const gid = Number(t.budget_group_id)
    const list = titelByGroup.get(gid) ?? []
    list.push(t)
    titelByGroup.set(gid, list)
  }
  return {
    id: Number(plan.id),
    name: plan.name,
    von: toDateStr(plan.fy_start),
    bis: toDateStr(plan.fy_end),
    state: plan.state,
    fiscal_year_id: Number(plan.fiscal_year_id),
    approved_by: plan.approved_by,
    approved_at: plan.approved_at == null ? null : toIsoZ(plan.approved_at),
    groups: groups.map((g) => ({
      id: Number(g.id),
      name: g.name,
      budget_type: g.budget_type,
      items: (titelByGroup.get(Number(g.id)) ?? []).map((t) => toBudgetItemDto(t, actuals.get(Number(t.id)) ?? 0)),
    })),
  }
}

// ── budget-statement read domain (#383 Lane B) ───────────────────────────────
// getBudgetStatement — mirror of read/statement.ts#getBudgetStatement:
//   * state='closed' + persisted budget_plan.statement jsonb → returned VERBATIM via
//     toStatementDto (plan_id → number, closed_at ISO-or-null, surplus → number, extra
//     keys pass through — the native Statement schema is .passthrough()).
//   * else → interim on-the-fly: surplus = Σ(planned) − Σ(ist) over the plan's Titel,
//     closed_at null (StuFis parity).
// Visibility mirrors getBudgetPlan (auditor bypass / scoped budget_section EXISTS /
// out-of-scope → null → route 404). BOUNDARY: this leaf serves ONLY the statement READ;
// the PDF/xlsx byte exports stay 501-locked (R5), so NO exceljs / pdf renderer is imported.

export type StatementDto = { plan_id: number; closed_at: string | null; surplus: number | null } & Record<string, unknown>

/** Mirror of dto-map.ts#toStatementDto: coerce plan_id → number, closed_at Date→ISO
 *  (undefined → null), surplus → number (undefined → null); every other key survives. */
function toStatementDto(row: Record<string, unknown>): StatementDto {
  const out: Record<string, unknown> = { ...row }
  if (out.plan_id != null) out.plan_id = Number(out.plan_id)
  if (out.closed_at instanceof Date) out.closed_at = out.closed_at.toISOString()
  if (out.closed_at === undefined) out.closed_at = null
  if (out.surplus !== undefined && out.surplus !== null) out.surplus = Number(out.surplus)
  if (out.surplus === undefined) out.surplus = null
  return out as StatementDto
}

interface RawStatementPlanRow {
  id: string | number
  name: string
  state: string
  statement: unknown
  closed_at: Date | string | null
}

/** Resolve + visibility-gate a budget_plan for the statement read. Returns the plan row
 *  (id/name/state/statement/closed_at) or null when absent OR out-of-scope (G-019). */
async function assertBudgetPlanVisible(
  sql: Sql,
  id: string | number,
  scope: ScopeContext,
): Promise<RawStatementPlanRow | null> {
  const rows = await sql<RawStatementPlanRow[]>`
    SELECT id, name, state, statement, closed_at
    FROM finance.budget_plan WHERE id = ${id}`
  if (rows.length === 0) return null
  if (!scope.isAuditor) {
    const scopeIds = await scopedFinanceUnitIds(sql, scope)
    const visibility = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(
        SELECT 1 FROM finance.budget_section
        WHERE budget_plan_id = ${id}
          AND finance_unit_id = ANY(${scopeIds as unknown as number[]})
      ) AS exists`
    if (!visibility[0]?.exists) return null
  }
  return rows[0]!
}

export async function getBudgetStatement(
  sql: Sql,
  id: string | number,
  scope: ScopeContext,
): Promise<StatementDto | null> {
  const plan = await assertBudgetPlanVisible(sql, id, scope)
  if (plan === null) return null
  if (plan.state === 'closed' && plan.statement != null) {
    return toStatementDto(
      decodeJsonbColumn<Record<string, unknown>>(plan.statement, 'object', 'budget_plan.statement'),
    )
  }
  // Interim: Σ(planned) − Σ(posted actuals) over the plan's Titel (StuFis parity).
  const titel = await sql<{ id: string | number; planned_cents: string | number }[]>`
    SELECT bt.id, bt.planned_cents
    FROM finance.budget_titel bt
    JOIN finance.budget_group bg ON bg.id = bt.budget_group_id
    JOIN finance.budget_section bs ON bs.id = bg.budget_section_id
    WHERE bs.budget_plan_id = ${id}`
  const actuals = await actualsForPlan(sql, id)
  let totalPlanned = 0
  let totalBooked = 0
  for (const t of titel) {
    totalPlanned += Number(t.planned_cents)
    totalBooked += actuals.get(Number(t.id)) ?? 0
  }
  return toStatementDto({ plan_id: Number(id), closed_at: null, surplus: totalPlanned - totalBooked })
}

// ── statement projection for the byte exports (#383 Lane E3) ──────────────────
// getStatementProjection — the visibility-gated per-Titel projection that BOTH byte
// exports (getBudgetStatementPdf / exportBudget) render. Mirror of
// read/statement.ts#projectPlan + assertPlanVisible: same auditor-bypass / scoped
// budget_section EXISTS gate as getBudgetStatement (out-of-scope-but-EXISTING → null →
// route 404, G-019), then the flat Titel lines (ansatz = planned_cents, ist = posted
// actuals) ORDER BY section, group, titel. PURE SQL — this stays in store/index.ts so
// the byte-generation deps (exceljs / the pdf renderer) live ONLY in src/exports/*
// and never drag into the JSON store module (statement.store.test.ts boundary).

export interface StatementLine {
  titel_id: number
  titel_nr: string
  titel_name: string
  ansatz: number
  ist: number
  section_id: number
  group_id: number
}

export interface StatementProjection {
  plan: { id: number; name: string; state: string }
  lines: StatementLine[]
}

export async function getStatementProjection(
  sql: Sql,
  id: string | number,
  scope: ScopeContext,
): Promise<StatementProjection | null> {
  const plan = await assertBudgetPlanVisible(sql, id, scope)
  if (plan === null) return null
  const rows = await sql<{
    id: string
    budget_group_id: string
    budget_section_id: string
    titel_nr: string | null
    titel_name: string
    planned_cents: string
  }[]>`
    SELECT bt.id, bg.id AS budget_group_id, bs.id AS budget_section_id,
           bt.titel_nr, bt.titel_name, bt.planned_cents
    FROM finance.budget_titel bt
    JOIN finance.budget_group bg ON bg.id = bt.budget_group_id
    JOIN finance.budget_section bs ON bs.id = bg.budget_section_id
    WHERE bs.budget_plan_id = ${id}
    ORDER BY bs.id, bg.id, bt.id`
  const actuals = await actualsForPlan(sql, id)
  const lines: StatementLine[] = rows.map((r) => {
    const titelId = Number(r.id)
    return {
      titel_id: titelId,
      titel_nr: r.titel_nr ?? '',
      titel_name: r.titel_name,
      ansatz: Number(r.planned_cents),
      ist: actuals.get(titelId) ?? 0,
      section_id: Number(r.budget_section_id),
      group_id: Number(r.budget_group_id),
    }
  })
  return { plan: { id: Number(plan.id), name: plan.name, state: plan.state }, lines }
}

// ── booking read domain (#383 Lane B) ────────────────────────────────────────
// listBookings — mirror of read/booking.ts + dto-map.ts#toBookingDto. Paginated
// (per_page=50, sort booking_date DESC then id DESC); the dynamic WHERE (finance-unit
// scope + optional account_id / date_from / date_to) is built with $N placeholders and
// run via sql.unsafe(sql, args) — LIMIT/OFFSET are bound params too, so a non-numeric /
// absent page clamps to page 1 (offset 0) and NEVER string-interpolates `OFFSET NaN`.
//
// Row-scoping mirrors read/booking.ts: an auditor gets NO finance-unit filter (scope
// null); a non-auditor filters WHERE la.finance_unit_id = ANY(scope) (empty scope →
// empty page, short-circuit). DIVERGENCE: a superuser-not-auditor SEES ALL (the
// scopedFinanceUnitIds see-all branch resolves ALL finance_unit ids into the filter).

const BOOKING_PER_PAGE = 50

export interface BookingDto {
  id: number
  account_id: number
  date: string
  valuta: string
  type: string
  empf_name: string
  empf_iban: string
  value: number
  saldo: number
  zweck: string
}

export interface PaginatedBookingsDto {
  data: BookingDto[]
  meta: { current_page: number; last_page: number; per_page: number; total: number }
}

export interface ListBookingsParams {
  account_id?: number
  date_from?: string
  date_to?: string
  page?: number
}

interface RawBookingListRow {
  id: string | number
  ledger_account_id: string | number
  amount_cents: string | number
  booking_date: Date | string
  payment_type: string
  la_name: string
  titel_name: string
}

function toBookingDto(r: RawBookingListRow): BookingDto {
  const date = toDateStr(r.booking_date)
  return {
    id: Number(r.id),
    account_id: Number(r.ledger_account_id),
    date,
    valuta: date,
    type: r.payment_type,
    empf_name: r.titel_name,
    empf_iban: '',
    value: Number(r.amount_cents),
    saldo: 0,
    zweck: r.la_name,
  }
}

export async function listBookings(
  sql: Sql,
  params: ListBookingsParams,
  scope: ScopeContext,
): Promise<PaginatedBookingsDto> {
  const page = Number.isFinite(params.page) ? Math.max(1, Math.floor(params.page as number)) : 1
  const offset = (page - 1) * BOOKING_PER_PAGE
  const accountId = params.account_id ?? null
  const dateFrom = params.date_from ?? null
  const dateTo = params.date_to ?? null

  // Auditor → no finance-unit filter (scope null); otherwise resolve the actor's
  // finance_unit ids (see-all for a superuser). An empty scope → empty page.
  const fuScope = scope.isAuditor ? null : await scopedFinanceUnitIds(sql, scope)
  if (fuScope !== null && fuScope.length === 0) {
    return { data: [], meta: { current_page: page, last_page: 1, per_page: BOOKING_PER_PAGE, total: 0 } }
  }

  const whereClauses: string[] = []
  const args: unknown[] = []
  if (fuScope !== null) {
    args.push(fuScope as unknown as number[])
    whereClauses.push(`la.finance_unit_id = ANY($${args.length})`)
  }
  if (accountId !== null) {
    args.push(accountId)
    whereClauses.push(`b.ledger_account_id = $${args.length}`)
  }
  if (dateFrom !== null) {
    args.push(dateFrom)
    whereClauses.push(`b.booking_date >= $${args.length}`)
  }
  if (dateTo !== null) {
    args.push(dateTo)
    whereClauses.push(`b.booking_date <= $${args.length}`)
  }
  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''

  const cntArgs = args
  const listArgs = [...args, BOOKING_PER_PAGE, offset]
  const limitPlaceholder = listArgs.length - 1
  const offsetPlaceholder = listArgs.length

  const listSql = `
    SELECT b.id, b.ledger_account_id, b.amount_cents,
           b.booking_date, b.payment_type, b.state,
           la.name AS la_name, bt.titel_name
    FROM finance.booking b
    JOIN finance.ledger_account la ON la.id = b.ledger_account_id
    JOIN finance.budget_titel bt ON bt.id = b.budget_titel_id
    ${whereSql}
    ORDER BY b.booking_date DESC, b.id DESC
    LIMIT $${limitPlaceholder} OFFSET $${offsetPlaceholder}`
  const cntSql = `
    SELECT COUNT(*)::int AS c
    FROM finance.booking b
    JOIN finance.ledger_account la ON la.id = b.ledger_account_id
    JOIN finance.budget_titel bt ON bt.id = b.budget_titel_id
    ${whereSql}`

  type UnsafeArgs = Parameters<Sql['unsafe']>[1]
  const rows = (await sql.unsafe(listSql, listArgs as unknown as UnsafeArgs)) as unknown as RawBookingListRow[]
  const cntRows = (await sql.unsafe(cntSql, cntArgs as unknown as UnsafeArgs)) as unknown as { c: number }[]
  const total = cntRows[0]?.c ?? 0
  const last_page = Math.max(1, Math.ceil(total / BOOKING_PER_PAGE))
  return {
    data: rows.map(toBookingDto),
    meta: { current_page: page, last_page, per_page: BOOKING_PER_PAGE, total },
  }
}

export type DeleteSubOrgResult =
  | { status: 'deleted'; orgUnitId: string }
  | { status: 'blocked'; counts: Record<string, number> }
  | { status: 'not_found' }

/** deleteSubOrg finance side: resolve the pair, refuse (blocked) when finance
 *  rows still reference it (RESTRICT-equivalent), else delete the finance_unit
 *  and return its org_unit_id so the kernel can drop the org_unit. Atomic. */
export async function deleteFinanceUnitForSubOrg(sql: Sql, id: string | number): Promise<DeleteSubOrgResult> {
  return sql.begin(async (tx) => {
    const fu = await tx<{ org_unit_id: string }[]>`
      SELECT org_unit_id FROM finance.finance_unit WHERE id = ${id}`
    if (fu.length === 0) return { status: 'not_found' as const }
    const orgUnitId = fu[0]!.org_unit_id
    const counts = await countOrgUnitFinanceRefs(tx as unknown as Sql, orgUnitId)
    if (blockingRefCount(counts) > 0) return { status: 'blocked' as const, counts }
    await tx`DELETE FROM finance.finance_unit WHERE id = ${id}`
    return { status: 'deleted' as const, orgUnitId }
  }) as Promise<DeleteSubOrgResult>
}

// ═══════════════════════════════════════════════════════════════════════════════
// Budget WRITE domain (#383 Lane D) — port of services/write/budget.ts + the write
// facade's DTO assembly (services/write/index.ts). budget_plan / budget_section /
// budget_group / budget_titel are ALL leaf-local; the §11 write-scope gate resolves
// the target org unit from finance_unit.org_unit_id (the leaf owns it — NO org_units
// join, so these DO NOT carry the projects/sub-org-read kernel coupling).
//
// DTO parity with the ACL client (backend/service-client.ts) + read/dto-map.ts:
//   createBudgetPlan / updateBudgetPlan / activateBudget / assignBudgetFiscalYear
//     → BudgetPlanDetailDto. FACADE QUIRK reproduced EXACTLY: create/update ship an
//       EMPTY actuals map (every item booked=0); activate/assign ship the REAL
//       actualsForPlan booked map. The detail is assembled WITHOUT the read-path
//       visibility gate (the write-scope check already ran) — mirrors the facade's
//       DELIBERATE local assembly (a fresh section-less plan would 404 through
//       getBudgetPlan's visibility predicate).
//   createBudgetGroup / updateBudgetGroup → BudgetGroupDetailDto (items:[])
//   createBudgetItem / updateBudgetItem   → BudgetItemDto (booked:0 — facade parity)
//   deleteBudgetGroup / deleteBudgetItem  → void
//
// createBudgetPlan.name = `HH ${fiscal_year_id}` (fromCreateBudgetPlanDto); a group's
// parent section is the plan's CENTRAL section, find-or-created on first write
// (resolveCentralSectionId). activateBudget enforces the §4.1 approved→active edge.
// assignBudgetFiscalYear rejects a null fiscal year (budget_plan.fiscal_year_id is
// NOT NULL) with a 400.
// ═══════════════════════════════════════════════════════════════════════════════

/** An illegal budget-plan state transition (mirror services/write/state-machine.ts
 *  IllegalTransitionError). The route maps it to HTTP 409 (conflict). */
export class FinanceStateError extends Error {
  readonly httpStatus = 409
  constructor(message: string) {
    super(message)
    this.name = 'FinanceStateError'
  }
}

const BUDGET_TYPES = new Set(['income', 'expense'])

/** Resolve the singleton central finance_unit (kind='central') + its org_unit_id
 *  (mirror financeUnitDb.findCentral). budget_plan writes are gated on this
 *  org unit (§11 defence-in-depth: the statutory plan is central-scoped). */
async function findCentral(sql: Sql): Promise<{ id: number; orgUnitId: string }> {
  const rows = await sql<{ id: string; org_unit_id: string }[]>`
    SELECT id, org_unit_id FROM finance.finance_unit WHERE kind = 'central'`
  if (rows.length === 0) throw new Error('central finance_unit not found')
  return { id: Number(rows[0]!.id), orgUnitId: rows[0]!.org_unit_id }
}

/** Find (or lazily create) the plan's central budget_section — the single implicit
 *  "statutory" section every StuFis plan carried (mirror
 *  write/index.ts#resolveCentralSectionId). Deterministic: first by id. */
async function resolveCentralSection(sql: Sql, planId: number, centralFuId: number): Promise<number> {
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM finance.budget_section
    WHERE budget_plan_id = ${planId} AND finance_unit_id = ${centralFuId}
    ORDER BY id LIMIT 1`
  if (existing.length > 0) return Number(existing[0]!.id)
  const created = await sql<{ id: string }[]>`
    INSERT INTO finance.budget_section (budget_plan_id, finance_unit_id)
    VALUES (${planId}, ${centralFuId}) RETURNING id`
  return Number(created[0]!.id)
}

/** Resolve the org_unit a budget_group is scoped to (group → section → finance_unit).
 *  Returns null when the group does not exist (→ route 404). */
async function orgUnitForGroup(sql: Sql, groupId: number): Promise<string | null> {
  const rows = await sql<{ org_unit_id: string }[]>`
    SELECT fu.org_unit_id
    FROM finance.budget_group bg
    JOIN finance.budget_section bs ON bs.id = bg.budget_section_id
    JOIN finance.finance_unit fu ON fu.id = bs.finance_unit_id
    WHERE bg.id = ${groupId}`
  return rows[0]?.org_unit_id ?? null
}

/** Resolve the org_unit a budget_titel is scoped to (titel → group → section →
 *  finance_unit). Returns null when the titel does not exist (→ route 404). */
async function orgUnitForTitel(sql: Sql, titelId: number): Promise<string | null> {
  const rows = await sql<{ org_unit_id: string }[]>`
    SELECT fu.org_unit_id
    FROM finance.budget_titel bt
    JOIN finance.budget_group bg ON bg.id = bt.budget_group_id
    JOIN finance.budget_section bs ON bs.id = bg.budget_section_id
    JOIN finance.finance_unit fu ON fu.id = bs.finance_unit_id
    WHERE bt.id = ${titelId}`
  return rows[0]?.org_unit_id ?? null
}

/** Assemble the BudgetPlanDetail DTO for a just-written plan WITHOUT the read-path
 *  visibility gate (mirror the write facade's local assembly). `withActuals` reproduces
 *  the facade quirk: create/update pass an empty booked map, activate/assign pass the
 *  real actualsForPlan map. */
async function assembleBudgetPlanDetail(
  sql: Sql,
  planId: number,
  withActuals: boolean,
): Promise<BudgetPlanDetailDto> {
  const planRows = await sql<RawBudgetPlanRow[]>`
    SELECT bp.id, bp.name, bp.state, bp.fiscal_year_id, bp.approved_by, bp.approved_at,
           fy.name AS fy_name, fy.start_date AS fy_start, fy.end_date AS fy_end
    FROM finance.budget_plan bp
    JOIN finance.fiscal_year fy ON fy.id = bp.fiscal_year_id
    WHERE bp.id = ${planId}`
  if (planRows.length === 0) throw new Error(`budget_plan ${planId} not found after write`)
  const plan = planRows[0]!
  const groups = await sql<RawBudgetGroupRow[]>`
    SELECT bg.id, bg.name, bg.budget_type, bg.budget_section_id
    FROM finance.budget_group bg
    JOIN finance.budget_section bs ON bs.id = bg.budget_section_id
    WHERE bs.budget_plan_id = ${planId}
    ORDER BY bg.id`
  const titel = await sql<RawBudgetTitelRow[]>`
    SELECT bt.id, bt.budget_group_id, bt.titel_nr, bt.titel_name, bt.planned_cents
    FROM finance.budget_titel bt
    JOIN finance.budget_group bg ON bg.id = bt.budget_group_id
    JOIN finance.budget_section bs ON bs.id = bg.budget_section_id
    WHERE bs.budget_plan_id = ${planId}
    ORDER BY bt.id`
  const actuals = withActuals ? await actualsForPlan(sql, planId) : new Map<number, number>()
  const titelByGroup = new Map<number, RawBudgetTitelRow[]>()
  for (const t of titel) {
    const gid = Number(t.budget_group_id)
    const list = titelByGroup.get(gid) ?? []
    list.push(t)
    titelByGroup.set(gid, list)
  }
  return {
    id: Number(plan.id),
    name: plan.name,
    von: toDateStr(plan.fy_start),
    bis: toDateStr(plan.fy_end),
    state: plan.state,
    fiscal_year_id: Number(plan.fiscal_year_id),
    approved_by: plan.approved_by,
    approved_at: plan.approved_at == null ? null : toIsoZ(plan.approved_at),
    groups: groups.map((g) => ({
      id: Number(g.id),
      name: g.name,
      budget_type: g.budget_type,
      items: (titelByGroup.get(Number(g.id)) ?? []).map((t) => toBudgetItemDto(t, actuals.get(Number(t.id)) ?? 0)),
    })),
  }
}

/** createBudgetPlan: insert a draft plan (name `HH ${fyId}`) after the central
 *  write-scope gate; return the BudgetPlanDetail with empty groups (facade parity). */
export async function createBudgetPlan(
  sql: Sql,
  actor: ActorContext,
  input: { fiscalYearId: number },
): Promise<BudgetPlanDetailDto> {
  const central = await findCentral(sql)
  assertOrgUnitWritable(actor, central.orgUnitId)
  const rows = await sql<{ id: string }[]>`
    INSERT INTO finance.budget_plan (fiscal_year_id, name)
    VALUES (${input.fiscalYearId}, ${`HH ${input.fiscalYearId}`})
    RETURNING id`
  return assembleBudgetPlanDetail(sql, Number(rows[0]!.id), false)
}

/** updateBudgetPlan: patch the plan name (von/bis are dropped — they live on the
 *  joined fiscal_year). Central write-scope gate. Returns null (→404) when absent.
 *  The re-read detail ships EMPTY actuals (booked=0), mirroring the facade. */
export async function updateBudgetPlan(
  sql: Sql,
  actor: ActorContext,
  id: string | number,
  patch: { name?: string },
): Promise<BudgetPlanDetailDto | null> {
  const exists = await sql<{ id: string }[]>`SELECT id FROM finance.budget_plan WHERE id = ${id}`
  if (exists.length === 0) return null
  const central = await findCentral(sql)
  assertOrgUnitWritable(actor, central.orgUnitId)
  if (patch.name !== undefined) {
    await sql`UPDATE finance.budget_plan SET name = ${patch.name} WHERE id = ${id}`
  }
  return assembleBudgetPlanDetail(sql, Number(id), false)
}

/** createBudgetGroup: append a group to the plan's central section (find-or-create).
 *  Central write-scope gate. Returns the BudgetGroupDetail with items:[]. */
export async function createBudgetGroup(
  sql: Sql,
  actor: ActorContext,
  planId: string | number,
  input: { name: string; budget_type: string },
): Promise<BudgetGroupDetailDto> {
  if (!BUDGET_TYPES.has(input.budget_type)) {
    throw new FinanceValidationError(`invalid budget_type: ${input.budget_type}`)
  }
  const central = await findCentral(sql)
  assertOrgUnitWritable(actor, central.orgUnitId)
  const sectionId = await resolveCentralSection(sql, Number(planId), central.id)
  const rows = await sql<{ id: string; name: string; budget_type: string }[]>`
    INSERT INTO finance.budget_group (budget_section_id, name, budget_type)
    VALUES (${sectionId}, ${input.name}, ${input.budget_type})
    RETURNING id, name, budget_type`
  const g = rows[0]!
  return { id: Number(g.id), name: g.name, budget_type: g.budget_type, items: [] }
}

/** updateBudgetGroup: patch a group's name/budget_type (per-section write-scope gate
 *  via group→section→finance_unit→org_unit). Returns null (→404) when absent; an
 *  empty patch is a read-back. items:[] (the patch never touches titel). */
export async function updateBudgetGroup(
  sql: Sql,
  actor: ActorContext,
  groupId: string | number,
  patch: { name?: string; budget_type?: string },
): Promise<BudgetGroupDetailDto | null> {
  if (patch.budget_type !== undefined && !BUDGET_TYPES.has(patch.budget_type)) {
    throw new FinanceValidationError(`invalid budget_type: ${patch.budget_type}`)
  }
  const orgUnitId = await orgUnitForGroup(sql, Number(groupId))
  if (orgUnitId === null) return null
  assertOrgUnitWritable(actor, orgUnitId)
  if (patch.name !== undefined) {
    await sql`UPDATE finance.budget_group SET name = ${patch.name} WHERE id = ${groupId}`
  }
  if (patch.budget_type !== undefined) {
    await sql`UPDATE finance.budget_group SET budget_type = ${patch.budget_type} WHERE id = ${groupId}`
  }
  const rows = await sql<{ id: string; name: string; budget_type: string }[]>`
    SELECT id, name, budget_type FROM finance.budget_group WHERE id = ${groupId}`
  const g = rows[0]!
  return { id: Number(g.id), name: g.name, budget_type: g.budget_type, items: [] }
}

/** deleteBudgetGroup: per-section write-scope gate, then DELETE (budget_titel cascades
 *  in the leaf schema). Idempotent — a missing group is a no-op (facade parity). */
export async function deleteBudgetGroup(sql: Sql, actor: ActorContext, groupId: string | number): Promise<void> {
  const orgUnitId = await orgUnitForGroup(sql, Number(groupId))
  if (orgUnitId === null) return
  assertOrgUnitWritable(actor, orgUnitId)
  await sql`DELETE FROM finance.budget_group WHERE id = ${groupId}`
}

/** createBudgetItem: append a Titel to a group (titel_nr ''→null, deckungsfaehig=false,
 *  deckungs_group=null — fromCreateBudgetItemDto). Per-section write-scope gate. Returns
 *  BudgetItem with booked=0. Returns null (→404) when the group does not exist. */
export async function createBudgetItem(
  sql: Sql,
  actor: ActorContext,
  groupId: string | number,
  input: { titel_nr: string; titel_name: string; value: number },
): Promise<BudgetItemDto | null> {
  const orgUnitId = await orgUnitForGroup(sql, Number(groupId))
  if (orgUnitId === null) return null
  assertOrgUnitWritable(actor, orgUnitId)
  const rows = await sql<RawBudgetTitelRow[]>`
    INSERT INTO finance.budget_titel (budget_group_id, titel_nr, titel_name, planned_cents, deckungsfaehig, deckungs_group)
    VALUES (${groupId}, ${input.titel_nr || null}, ${input.titel_name}, ${input.value}, false, null)
    RETURNING id, budget_group_id, titel_nr, titel_name, planned_cents`
  return toBudgetItemDto(rows[0]!, 0)
}

/** updateBudgetItem: patch a Titel (titel_nr ''→null when present; absent keys
 *  untouched — fromUpdateBudgetItemDto). Per-section write-scope gate. Returns
 *  BudgetItem with booked=0 (facade parity); null (→404) when the Titel is absent. */
export async function updateBudgetItem(
  sql: Sql,
  actor: ActorContext,
  itemId: string | number,
  patch: { titel_nr?: string; titel_name?: string; value?: number },
): Promise<BudgetItemDto | null> {
  const orgUnitId = await orgUnitForTitel(sql, Number(itemId))
  if (orgUnitId === null) return null
  assertOrgUnitWritable(actor, orgUnitId)
  if (patch.titel_nr !== undefined) {
    await sql`UPDATE finance.budget_titel SET titel_nr = ${patch.titel_nr || null} WHERE id = ${itemId}`
  }
  if (patch.titel_name !== undefined) {
    await sql`UPDATE finance.budget_titel SET titel_name = ${patch.titel_name} WHERE id = ${itemId}`
  }
  if (patch.value !== undefined) {
    await sql`UPDATE finance.budget_titel SET planned_cents = ${patch.value} WHERE id = ${itemId}`
  }
  const rows = await sql<RawBudgetTitelRow[]>`
    SELECT id, budget_group_id, titel_nr, titel_name, planned_cents FROM finance.budget_titel WHERE id = ${itemId}`
  return toBudgetItemDto(rows[0]!, 0)
}

/** deleteBudgetItem: per-section write-scope gate, then DELETE the Titel. Idempotent
 *  — a missing Titel is a no-op (facade parity). */
export async function deleteBudgetItem(sql: Sql, actor: ActorContext, itemId: string | number): Promise<void> {
  const orgUnitId = await orgUnitForTitel(sql, Number(itemId))
  if (orgUnitId === null) return
  assertOrgUnitWritable(actor, orgUnitId)
  await sql`DELETE FROM finance.budget_titel WHERE id = ${itemId}`
}

/** activateBudget: the §4.1 approved→active edge (central write-scope gate), stamping
 *  activated_by/activated_at (budgetDb.activatePlan). Returns the BudgetPlanDetail with
 *  REAL actuals; null (→404) when the plan is absent; FinanceStateError (→409) when the
 *  plan is not in 'approved'. */
export async function activateBudget(
  sql: Sql,
  actor: ActorContext,
  id: string | number,
): Promise<BudgetPlanDetailDto | null> {
  return sql.begin(async (tx) => {
    const t = tx as unknown as Sql
    const plan = await t<{ id: string; state: string }[]>`
      SELECT id, state FROM finance.budget_plan WHERE id = ${id} FOR UPDATE`
    if (plan.length === 0) return null
    const central = await findCentral(t)
    assertOrgUnitWritable(actor, central.orgUnitId)
    const from = plan[0]!.state
    if (from !== 'approved') {
      throw new FinanceStateError(`budget_plan ${id}: illegal transition ${from} → active (only approved→active)`)
    }
    await t`
      UPDATE finance.budget_plan
         SET state = 'active', activated_by = ${actor.userId}, activated_at = now()
       WHERE id = ${id}`
    return assembleBudgetPlanDetail(t, Number(id), true)
  }) as Promise<BudgetPlanDetailDto | null>
}

/** assignBudgetFiscalYear: re-point a plan's fiscal_year_id (central write-scope gate).
 *  A null fiscal year is rejected with 400 (budget_plan.fiscal_year_id is NOT NULL —
 *  mirror IllegalArgumentError). Returns the BudgetPlanDetail with REAL actuals; null
 *  (→404) when the plan is absent. */
export async function assignBudgetFiscalYear(
  sql: Sql,
  actor: ActorContext,
  id: string | number,
  fiscalYearId: number | null,
): Promise<BudgetPlanDetailDto | null> {
  if (fiscalYearId === null) {
    throw new FinanceValidationError(
      'assignBudgetFiscalYear: fiscal_year_id is required (budget_plan.fiscal_year_id is NOT NULL)',
    )
  }
  return sql.begin(async (tx) => {
    const t = tx as unknown as Sql
    const plan = await t<{ id: string }[]>`SELECT id FROM finance.budget_plan WHERE id = ${id} FOR UPDATE`
    if (plan.length === 0) return null
    const central = await findCentral(t)
    assertOrgUnitWritable(actor, central.orgUnitId)
    await t`UPDATE finance.budget_plan SET fiscal_year_id = ${fiscalYearId} WHERE id = ${id}`
    return assembleBudgetPlanDetail(t, Number(id), true)
  }) as Promise<BudgetPlanDetailDto | null>
}

// ═══════════════════════════════════════════════════════════════════════════════
// closeBudget (#383 / FIN-52) — the WP-YearEnd Jahresabschluss, ported LEAF-LOCAL.
// The 52nd/final finance op + the LAST kernel-coupling residual retired. The native
// oracle (services/yearend/service.ts#closePlan) delegates to the ~13-module WP-YearEnd
// orchestrator; the leaf reproduces the SAME composition entirely against its own
// `finance` schema (budget_plan/section/group/titel + fiscal_year + finance_unit +
// org_unit_mirror + inventory_item + finanzordnung_profile + reserve + booking + discharge)
// so it carries NO kernel `org_units` join — the inventar Vermögensnachweis walks the
// leaf-local org_unit_mirror subtree exactly as the native walks org_units. closePlan's
// shape (compose → persist statement jsonb → reserve deltas → retention markers → state
// flip) is preserved; the surplus/deficit reserve rules (§3.5) + HGB/Finanzordnung
// retention horizons (§5.2) are ported verbatim.
// ═══════════════════════════════════════════════════════════════════════════════

/** The consolidated Jahresabschluss the leaf composes + persists on budget_plan.statement.
 *  Mirror of services/yearend/types.ts#Statement + archive.ts#renderStatementJson (Dates
 *  flattened to ISO). kassenbestand_reconciliation is the zero-zero placeholder the native
 *  surfaces until the Phase-3 bank-balance integration lands. */
interface ClosedStatement {
  meta: {
    fiscal_year_id: number
    fiscal_year_name: string
    budget_plan_id: number
    finance_unit_name: string
    generated_at: string
  }
  titel_actuals: Array<{ budget_titel_id: number; ansatz_cents: number; ist_cents: number; diff_cents: number }>
  carry_over: { carry_amount_cents: number; reserve_delta_cents: number } | null
  reserve_deltas: Array<{ type: ReserveType; delta_cents: number }>
  inventar: {
    fy_end: string
    items: Array<{ inventory_no: string; acquisition_value_cents: number; disposed_at: string | null }>
    total_value_cents: number
  }
  kassenbestand_reconciliation: { opening_cents: number; closing_cents: number; diff_cents: number }
}

export type ReserveType = 'frei' | 'betriebsmittel' | 'zweckgebunden'
export interface ReserveDelta {
  type: ReserveType
  delta_cents: number
}

/** The finanzordnung_profile fields the reserve + retention rules read. */
export interface ReserveProfileRow {
  reserve_frei_bound: 'ceiling' | 'floor'
  reserve_frei_amount_cents: string | number
  reserve_betriebsmittel_amount_cents: string | number
  reserve_zweckgebunden_amount_cents: string | number
  retention_years: number
  retention_from: 'entlastung' | 'fiscal_year_end'
}

/** Compose the Jahresabschluss statement (mirror of service.ts#composeStatement): read
 *  the fiscal_year, the plan's central budget_section → its finance_unit, the per-Titel
 *  ansatz/ist reconciliation, and the year-end standing inventory over the finance_unit's
 *  org_unit_mirror subtree. carry_over records the plan-level Σdiff summary; reserve_deltas
 *  stays [] (the deltas are applied to finance.reserve, not embedded in the statement). */
async function composeClosingStatement(
  sql: Sql,
  plan: { id: string | number; fiscal_year_id: string | number; name: string },
): Promise<{ statement: ClosedStatement; fyEnd: Date; fiscalYearId: number }> {
  const planId = Number(plan.id)
  const fyRows = await sql<{ id: string; name: string; end_date: Date | string }[]>`
    SELECT id, name, end_date FROM finance.fiscal_year WHERE id = ${plan.fiscal_year_id}`
  if (fyRows.length === 0) throw new Error(`fiscal_year ${plan.fiscal_year_id} not found`)
  const fy = fyRows[0]!
  const fyEnd = fy.end_date instanceof Date ? fy.end_date : new Date(fy.end_date)

  const sectionRows = await sql<{ finance_unit_id: string }[]>`
    SELECT finance_unit_id FROM finance.budget_section
    WHERE budget_plan_id = ${planId} ORDER BY id LIMIT 1`
  const financeUnitId = sectionRows[0] ? Number(sectionRows[0].finance_unit_id) : 0
  const unitRows = financeUnitId
    ? await sql<{ id: string; org_unit_id: string }[]>`
        SELECT id, org_unit_id FROM finance.finance_unit WHERE id = ${financeUnitId}`
    : []
  const unit = unitRows[0] ?? null

  const titelRows = await sql<{ id: string; planned_cents: string }[]>`
    SELECT bt.id, bt.planned_cents
    FROM finance.budget_titel bt
    JOIN finance.budget_group bg ON bg.id = bt.budget_group_id
    JOIN finance.budget_section bs ON bs.id = bg.budget_section_id
    WHERE bs.budget_plan_id = ${planId}`
  const actuals = await actualsForPlan(sql, planId)
  const titel_actuals = titelRows.map((row) => {
    const ansatz = Number(row.planned_cents)
    const ist = actuals.get(Number(row.id)) ?? 0
    return { budget_titel_id: Number(row.id), ansatz_cents: ansatz, ist_cents: ist, diff_cents: ist - ansatz }
  })

  let inventar: ClosedStatement['inventar']
  if (unit) {
    const invRows = await sql<{ inventory_no: string; acquisition_value_cents: string; disposed_at: Date | string | null }[]>`
      WITH RECURSIVE subtree AS (
        SELECT id FROM finance.org_unit_mirror WHERE id = ${unit.org_unit_id} AND NOT deleted
        UNION ALL
        SELECT o.id FROM finance.org_unit_mirror o
        JOIN subtree s ON o.parent_id = s.id
        WHERE NOT o.deleted
      )
      SELECT i.inventory_no, i.acquisition_value_cents::text AS acquisition_value_cents, i.disposed_at
      FROM finance.inventory_item i
      JOIN subtree s ON s.id = i.org_unit_id
      WHERE i.disposed_at IS NULL OR i.disposed_at > ${fyEnd}
      ORDER BY i.inventory_no`
    const items = invRows.map((r) => ({
      inventory_no: r.inventory_no,
      acquisition_value_cents: Number(r.acquisition_value_cents),
      disposed_at: r.disposed_at == null ? null : toIsoZ(r.disposed_at),
    }))
    inventar = { fy_end: toIsoZ(fyEnd), items, total_value_cents: items.reduce((s, i) => s + i.acquisition_value_cents, 0) }
  } else {
    inventar = { fy_end: toIsoZ(fyEnd), items: [], total_value_cents: 0 }
  }

  const totalDiffCents = titel_actuals.reduce((s, r) => s + r.diff_cents, 0)
  const statement: ClosedStatement = {
    meta: {
      fiscal_year_id: Number(fy.id),
      fiscal_year_name: fy.name,
      budget_plan_id: planId,
      finance_unit_name: plan.name, // best-effort label (mirror composeStatement)
      generated_at: new Date().toISOString(),
    },
    titel_actuals,
    carry_over: { carry_amount_cents: 0, reserve_delta_cents: totalDiffCents },
    reserve_deltas: [],
    inventar,
    kassenbestand_reconciliation: { opening_cents: 0, closing_cents: 0, diff_cents: 0 },
  }
  return { statement, fyEnd, fiscalYearId: Number(fy.id) }
}

/** Load the single-row finanzordnung_profile (null when unseeded). */
async function loadFinanzordnungProfile(sql: Sql): Promise<ReserveProfileRow | null> {
  const rows = await sql<ReserveProfileRow[]>`
    SELECT reserve_frei_bound, reserve_frei_amount_cents,
           reserve_betriebsmittel_amount_cents, reserve_zweckgebunden_amount_cents,
           retention_years, retention_from
    FROM finance.finanzordnung_profile ORDER BY id LIMIT 1`
  return rows[0] ?? null
}

/** Plan reserve mutations from a year-end surplus/deficit (mirror reserves.ts#
 *  planReserveAdjustment, master spec §3.5): a surplus credits frei (ceiling bound) or
 *  betriebsmittel (floor bound); a deficit dissolves reserves frei→betriebsmittel→
 *  zweckgebunden, each capped at its available balance.
 *
 *  EXPORTED for the #435 parity guard ONLY (test/yearend-parity.test.ts drives this and
 *  the gremion-ui original over one fixture matrix). Not part of the store's op surface —
 *  the HTTP layer reaches it exclusively through closeBudget. */
export function planReserveAdjustment(surplusCents: number, profile: ReserveProfileRow): ReserveDelta[] {
  if (surplusCents === 0) return []
  if (surplusCents > 0) {
    const target: ReserveType = profile.reserve_frei_bound === 'ceiling' ? 'frei' : 'betriebsmittel'
    return [{ type: target, delta_cents: surplusCents }]
  }
  let remaining = -surplusCents
  const deltas: ReserveDelta[] = []
  const buckets: ReadonlyArray<readonly [ReserveType, number]> = [
    ['frei', Number(profile.reserve_frei_amount_cents)],
    ['betriebsmittel', Number(profile.reserve_betriebsmittel_amount_cents)],
    ['zweckgebunden', Number(profile.reserve_zweckgebunden_amount_cents)],
  ]
  for (const [type, available] of buckets) {
    if (remaining <= 0) break
    const consume = Math.min(remaining, Math.max(0, available))
    if (consume > 0) {
      deltas.push({ type, delta_cents: -consume })
      remaining -= consume
    }
  }
  return deltas
}

/** Apply the planned reserve deltas to finance.reserve (one UPDATE per delta keyed by
 *  reserve.type — mirror reserves.ts#applyReserveDeltas). */
async function applyReserveDeltas(sql: Sql, deltas: readonly ReserveDelta[]): Promise<void> {
  for (const d of deltas) {
    await sql`UPDATE finance.reserve SET amount_cents = amount_cents + ${d.delta_cents} WHERE type = ${d.type}`
  }
}

const HGB_RETENTION_YEARS = 10

function addYears(d: Date, years: number): Date {
  const r = new Date(d.getTime())
  r.setUTCFullYear(r.getUTCFullYear() + years)
  return r
}

/** The later of (fy_end + 10y HGB floor) and the Finanzordnung horizon anchored at the
 *  discharge date OR fy_end per profile (mirror retention.ts#computeRetentionUntil).
 *
 *  EXPORTED for the #435 parity guard ONLY (test/yearend-parity.test.ts) — see the note
 *  on planReserveAdjustment above. */
export function computeRetentionUntil(
  profile: Pick<ReserveProfileRow, 'retention_years' | 'retention_from'>,
  dischargeDate: Date,
  fyEnd: Date,
): Date {
  const hgbFloor = addYears(fyEnd, HGB_RETENTION_YEARS)
  const anchor = profile.retention_from === 'fiscal_year_end' ? fyEnd : dischargeDate
  const finanzordnung = addYears(anchor, profile.retention_years)
  return finanzordnung.getTime() > hgbFloor.getTime() ? finanzordnung : hgbFloor
}

/** Stamp retention_until on every not-yet-marked booking in the closed fiscal year
 *  (mirror retention.ts#markRetentionForClosedYear). Reuses the already-loaded fy_end;
 *  a granted discharge (if any) anchors the Finanzordnung horizon, else fy_end. */
async function markRetentionForClosedYear(
  sql: Sql,
  fiscalYearId: number,
  fyEnd: Date,
  profile: Pick<ReserveProfileRow, 'retention_years' | 'retention_from'>,
): Promise<void> {
  const discharge = await sql<{ approved_at: Date | null }[]>`
    SELECT approved_at FROM finance.discharge
    WHERE fiscal_year_id = ${fiscalYearId} AND state = 'granted'
    ORDER BY approved_at DESC LIMIT 1`
  const dischargeDate = discharge[0]?.approved_at ?? fyEnd
  const until = computeRetentionUntil(profile, dischargeDate, fyEnd)
  await sql`
    UPDATE finance.booking SET retention_until = ${until}
    WHERE fiscal_year_id = ${fiscalYearId} AND retention_until IS NULL`
}

/** closeBudget: the §4.1 active→closed year-end edge (central write-scope gate). Composes
 *  + persists the Jahresabschluss statement jsonb, applies the reserve deltas + retention
 *  markers, stamps state='closed' + closed_at, then re-reads through getBudgetStatement so
 *  the returned StatementDto IS the persisted jsonb round-tripped. Returns null (→404) when
 *  the plan is absent; AccessDeniedError (→403) out-of-scope; FinanceStateError (→409) when
 *  the plan is not in 'active'. Atomic: the whole close runs in one FOR UPDATE transaction. */
export async function closeBudget(
  sql: Sql,
  actor: ActorContext,
  id: string | number,
): Promise<StatementDto | null> {
  return sql.begin(async (tx) => {
    const t = tx as unknown as Sql
    const planRows = await t<{ id: string; fiscal_year_id: string; name: string; state: string }[]>`
      SELECT id, fiscal_year_id, name, state FROM finance.budget_plan WHERE id = ${id} FOR UPDATE`
    if (planRows.length === 0) return null
    const plan = planRows[0]!
    const central = await findCentral(t)
    assertOrgUnitWritable(actor, central.orgUnitId)
    if (plan.state !== 'active') {
      throw new FinanceStateError(
        `budget_plan ${id}: illegal transition ${plan.state} → closed (only active→closed)`,
      )
    }
    const { statement, fyEnd, fiscalYearId } = await composeClosingStatement(t, plan)
    // TASK-009 fix round 5: bind the JSON text as TEXT and cast — a bare string into
    // a jsonb parameter is JSON.stringify'd AGAIN by postgres-js and lands as a jsonb
    // STRING scalar (the read then spread it into {0:'{',1:'"',...}).
    await t`UPDATE finance.budget_plan SET statement = ${JSON.stringify(statement)}::text::jsonb WHERE id = ${id}`
    const profile = await loadFinanzordnungProfile(t)
    if (profile !== null) {
      const surplus = -statement.titel_actuals.reduce((acc, r) => acc + r.diff_cents, 0)
      await applyReserveDeltas(t, planReserveAdjustment(surplus, profile))
      await markRetentionForClosedYear(t, fiscalYearId, fyEnd, profile)
    }
    await t`UPDATE finance.budget_plan SET state = 'closed', closed_at = now() WHERE id = ${id}`
    return getBudgetStatement(t, id, actor)
  }) as Promise<StatementDto | null>
}

// ═══════════════════════════════════════════════════════════════════════════════
// Project (R1) + sub-org-read / sub_org_type (R2) domain (#383 Lane E1) — the last
// KERNEL-coupling residual. The native oracle JOINs the kernel `org_units` table for
// the org NAME/KIND (services/read/{project,sub-org}.ts) and writes the governance
// `sub_org_type` catalog (services/write/sub-org.ts) — both cross the boundary. The
// leaf now reads its OWN `finance.org_unit_mirror` (kept in sync by the kernel
// org-unit event pipeline + the id-preserving backfill) and owns `finance.sub_org_type`,
// so all 9 ops resolve LEAF-LOCAL with the SAME per-actor scoping as the oracle:
//   - listProjects / getProject / listSubOrgs / getSubOrgSummary gate on isAuditor
//     ONLY (a superuser-not-auditor is STILL org-unit-scoped — read/access.ts uses
//     isAuditor, not seesAllFinance, for these), 404/[] out-of-scope (G-019).
//   - createProject / updateProjectState gate the WRITE on assertOrgUnitWritable.
//   - listSubOrgTypes derives the types from DISTINCT org_unit_mirror.kind (the legacy
//     StuFis quirk — it does NOT read the catalog table).
//   - createSubOrgType / deleteSubOrgType write the leaf-owned finance.sub_org_type
//     (no org-unit scope — a per-instance catalog gated at the ACL/route layer).
// ═══════════════════════════════════════════════════════════════════════════════

/** Legacy StuFis SubOrg.type_id synthesised from org_unit.kind (mirror of
 *  read/sub-org.ts#KIND_TO_TYPE_ID). Unknown kinds → 0. */
const KIND_TO_TYPE_ID: Record<string, number> = { council: 1, committee: 2, group: 3 }

const PROJECT_PER_PAGE = 20

// ── project state machine (mirror write/state-machine.ts §4.4) ────────────────
type ProjectStateName =
  | 'draft' | 'submitted' | 'approved' | 'disbursed'
  | 'verwendungsnachweis_pending' | 'completed' | 'rejected'

const PROJECT_STATE_VALUES: readonly ProjectStateName[] = [
  'draft', 'submitted', 'approved', 'disbursed', 'verwendungsnachweis_pending', 'completed', 'rejected',
]

const projectInternalTransitions: Record<ProjectStateName, readonly ProjectStateName[]> = {
  draft: ['submitted'],
  submitted: ['approved', 'rejected'],
  approved: ['completed'],
  disbursed: [],
  verwendungsnachweis_pending: [],
  completed: [],
  rejected: [],
}
const projectExternalGrantTransitions: Record<ProjectStateName, readonly ProjectStateName[]> = {
  draft: ['submitted'],
  submitted: ['approved', 'rejected'],
  approved: ['disbursed'],
  disbursed: ['verwendungsnachweis_pending'],
  verwendungsnachweis_pending: ['completed'],
  completed: [],
  rejected: [],
}

// ── DTOs (mirror read/dto-map.ts toProject*/toSubOrg*) ────────────────────────
export interface ProjectListItemDto {
  id: number
  name: string
  state: string
  org: string
  responsible: string | null
  date_start: string | null
  date_end: string | null
  createdat: string
  spent_cents: number
}
export interface PaginatedProjectsDto {
  data: ProjectListItemDto[]
  meta: { current_page: number; last_page: number; per_page: number; total: number }
}
export interface ProjectDetailDto {
  id: number
  name: string
  state: string
  org: string
  responsible: string | null
  date_start: string | null
  date_end: string | null
  beschreibung: string | null
  createdat: string
  expenses_count: number
}
export interface SubOrgTypeDto {
  id: number
  name: string
  description: string | null
}
export interface SubOrgDto {
  id: number
  name: string
  type_id: number
  type: string | null
  payment_method: string
  allocation_amount: number
  budget_plan_id: number | null
  contact_email: string | null
  notes: string | null
  bookkeeping_mode: 'own' | 'central'
}
export interface SubOrgSummaryDto {
  id: number
  name: string
  allocated: number
  spent: number
  remaining: number
}

interface RawProjectListRow {
  id: string | number
  name: string
  state: string
  ou_name: string
  responsible: string | null
  date_start: Date | string | null
  date_end: Date | string | null
  created_at: Date | string
  spent_cents?: string | number | null
}
interface RawProjectDetailRow extends RawProjectListRow {
  description: string | null
  expenses_count: number
}

function toProjectListItemDto(r: RawProjectListRow): ProjectListItemDto {
  return {
    id: Number(r.id),
    name: r.name,
    state: r.state,
    org: r.ou_name,
    responsible: r.responsible,
    date_start: r.date_start == null ? null : toDateStr(r.date_start),
    date_end: r.date_end == null ? null : toDateStr(r.date_end),
    createdat: toIsoZ(r.created_at),
    spent_cents: r.spent_cents == null ? 0 : Number(r.spent_cents),
  }
}
function toProjectDetailDto(r: RawProjectDetailRow): ProjectDetailDto {
  return {
    id: Number(r.id),
    name: r.name,
    state: r.state,
    org: r.ou_name,
    responsible: r.responsible,
    date_start: r.date_start == null ? null : toDateStr(r.date_start),
    date_end: r.date_end == null ? null : toDateStr(r.date_end),
    beschreibung: r.description,
    createdat: toIsoZ(r.created_at),
    expenses_count: r.expenses_count,
  }
}
function toSubOrgTypeDto(kind: string): SubOrgTypeDto {
  return { id: KIND_TO_TYPE_ID[kind] ?? 0, name: kind, description: null }
}

// ── org_unit_mirror resolve helper ───────────────────────────────────────────
/** Resolve a live (non-tombstoned) org_unit_mirror row by id — the leaf-local
 *  analogue of governance getOrgUnit(id). null when absent OR tombstoned. */
async function getOrgUnitMirror(sql: Sql, id: string): Promise<{ id: string; name: string; kind: string } | null> {
  const rows = await sql<{ id: string; name: string; kind: string }[]>`
    SELECT id, name, kind FROM finance.org_unit_mirror WHERE id = ${id} AND NOT deleted`
  return rows[0] ?? null
}

// ── createProject (mirror write/index.ts facade createProject) ────────────────
export interface CreateProjectDto {
  name: string
  responsible?: string
  org?: string
  beschreibung?: string
  date_start?: string
  date_end?: string
}

export async function createProject(
  sql: Sql,
  actor: ActorContext,
  dto: CreateProjectDto,
): Promise<ProjectDetailDto> {
  // resolveProjectOrgUnitId: dto.org matching a live mirror row wins; else the
  // actor's first scoped org unit; empty scope + no match → validation error.
  let orgUnitId: string | undefined
  if (dto.org !== undefined && dto.org !== '') {
    const hit = await getOrgUnitMirror(sql, dto.org)
    if (hit !== null) orgUnitId = hit.id
  }
  if (orgUnitId === undefined) {
    if (actor.scopedOrgUnitIds.length === 0) {
      throw new FinanceValidationError(
        'createProject: cannot resolve org_unit — actor has no scoped org units and dto.org did not match a known id',
      )
    }
    orgUnitId = actor.scopedOrgUnitIds[0]!
  }
  // §11 write-scope gate (mirror ProjectServiceImpl.create).
  assertOrgUnitWritable(actor, orgUnitId)
  const rows = await sql<RawProjectDetailRow[]>`
    INSERT INTO finance.project (org_unit_id, type, name, responsible, description, date_start, date_end)
    VALUES (${orgUnitId}, 'internal', ${dto.name}, ${dto.responsible || null},
            ${dto.beschreibung ?? null}, ${dto.date_start ?? null}, ${dto.date_end ?? null})
    RETURNING id, name, state, responsible, description, date_start, date_end, created_at`
  const p = rows[0]!
  // ou_name from the mirror (resolveProjectOrgUnitId already proved it resolves).
  const ou = await sql<{ name: string }[]>`SELECT name FROM finance.org_unit_mirror WHERE id = ${orgUnitId}`
  return toProjectDetailDto({ ...p, ou_name: ou[0]?.name ?? '', expenses_count: 0 })
}

// ── listProjects (mirror read/project.ts) ─────────────────────────────────────
export async function listProjects(
  sql: Sql,
  scope: ScopeContext,
  params: { state?: string; page?: number },
): Promise<PaginatedProjectsDto> {
  const page = Math.max(1, Number.isFinite(params.page) ? Math.floor(params.page as number) : 1)
  const offset = (page - 1) * PROJECT_PER_PAGE
  const state = params.state ?? null
  // Auditor-only see-all (read/project.ts uses isAuditor, NOT seesAllFinance).
  const scopeIds = scope.isAuditor ? null : (scope.scopedOrgUnitIds as readonly string[])
  if (scopeIds !== null && scopeIds.length === 0) {
    return { data: [], meta: { current_page: page, last_page: 1, per_page: PROJECT_PER_PAGE, total: 0 } }
  }

  let rows: RawProjectListRow[]
  let total: number
  if (scopeIds === null && state === null) {
    rows = await sql<RawProjectListRow[]>`
      SELECT p.id, p.name, p.state, p.responsible, p.date_start, p.date_end, p.created_at,
             ou.name AS ou_name,
             COALESCE((SELECT SUM(ri.amount_cents) FROM finance.expense e
               JOIN finance.receipt r ON r.expense_id = e.id
               JOIN finance.receipt_item ri ON ri.receipt_id = r.id
               WHERE e.project_id = p.id), 0)::bigint AS spent_cents
      FROM finance.project p
      JOIN finance.org_unit_mirror ou ON ou.id = p.org_unit_id
      ORDER BY p.id DESC LIMIT ${PROJECT_PER_PAGE} OFFSET ${offset}`
    const c = await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM finance.project`
    total = c[0]?.c ?? 0
  } else if (scopeIds === null && state !== null) {
    rows = await sql<RawProjectListRow[]>`
      SELECT p.id, p.name, p.state, p.responsible, p.date_start, p.date_end, p.created_at,
             ou.name AS ou_name,
             COALESCE((SELECT SUM(ri.amount_cents) FROM finance.expense e
               JOIN finance.receipt r ON r.expense_id = e.id
               JOIN finance.receipt_item ri ON ri.receipt_id = r.id
               WHERE e.project_id = p.id), 0)::bigint AS spent_cents
      FROM finance.project p
      JOIN finance.org_unit_mirror ou ON ou.id = p.org_unit_id
      WHERE p.state = ${state}
      ORDER BY p.id DESC LIMIT ${PROJECT_PER_PAGE} OFFSET ${offset}`
    const c = await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM finance.project WHERE state = ${state}`
    total = c[0]?.c ?? 0
  } else if (scopeIds !== null && state === null) {
    rows = await sql<RawProjectListRow[]>`
      SELECT p.id, p.name, p.state, p.responsible, p.date_start, p.date_end, p.created_at,
             ou.name AS ou_name,
             COALESCE((SELECT SUM(ri.amount_cents) FROM finance.expense e
               JOIN finance.receipt r ON r.expense_id = e.id
               JOIN finance.receipt_item ri ON ri.receipt_id = r.id
               WHERE e.project_id = p.id), 0)::bigint AS spent_cents
      FROM finance.project p
      JOIN finance.org_unit_mirror ou ON ou.id = p.org_unit_id
      WHERE p.org_unit_id = ANY(${scopeIds as unknown as string[]})
      ORDER BY p.id DESC LIMIT ${PROJECT_PER_PAGE} OFFSET ${offset}`
    const c = await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM finance.project WHERE org_unit_id = ANY(${scopeIds as unknown as string[]})`
    total = c[0]?.c ?? 0
  } else {
    rows = await sql<RawProjectListRow[]>`
      SELECT p.id, p.name, p.state, p.responsible, p.date_start, p.date_end, p.created_at,
             ou.name AS ou_name,
             COALESCE((SELECT SUM(ri.amount_cents) FROM finance.expense e
               JOIN finance.receipt r ON r.expense_id = e.id
               JOIN finance.receipt_item ri ON ri.receipt_id = r.id
               WHERE e.project_id = p.id), 0)::bigint AS spent_cents
      FROM finance.project p
      JOIN finance.org_unit_mirror ou ON ou.id = p.org_unit_id
      WHERE p.state = ${state!} AND p.org_unit_id = ANY(${scopeIds as unknown as string[]})
      ORDER BY p.id DESC LIMIT ${PROJECT_PER_PAGE} OFFSET ${offset}`
    const c = await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM finance.project WHERE state = ${state!} AND org_unit_id = ANY(${scopeIds as unknown as string[]})`
    total = c[0]?.c ?? 0
  }
  return {
    data: rows.map(toProjectListItemDto),
    meta: {
      current_page: page,
      last_page: Math.max(1, Math.ceil(total / PROJECT_PER_PAGE)),
      per_page: PROJECT_PER_PAGE,
      total,
    },
  }
}

// ── getProject (mirror read/project.ts) ───────────────────────────────────────
export async function getProject(
  sql: Sql,
  scope: ScopeContext,
  id: string | number,
): Promise<ProjectDetailDto | null> {
  const rows = await sql<(RawProjectDetailRow & { org_unit_id: string })[]>`
    SELECT p.id, p.name, p.state, p.org_unit_id, p.responsible, p.description,
           p.date_start, p.date_end, p.created_at, ou.name AS ou_name,
           (SELECT COUNT(*)::int FROM finance.expense WHERE project_id = p.id) AS expenses_count
    FROM finance.project p
    JOIN finance.org_unit_mirror ou ON ou.id = p.org_unit_id
    WHERE p.id = ${id}`
  if (rows.length === 0) return null
  const p = rows[0]!
  // Auditor bypass; else out-of-scope → 404 (null) — G-019 anti-probing.
  if (!scope.isAuditor && !scope.scopedOrgUnitIds.includes(p.org_unit_id)) return null
  return toProjectDetailDto(p)
}

// ── updateProjectState (mirror write/index.ts facade + ProjectServiceImpl.transition) ─
export async function updateProjectState(
  sql: Sql,
  actor: ActorContext,
  id: string | number,
  state: string,
): Promise<ProjectDetailDto | null> {
  if (!(PROJECT_STATE_VALUES as readonly string[]).includes(state)) {
    throw new FinanceValidationError(
      `updateProjectState: invalid state '${state}' (allowed: ${PROJECT_STATE_VALUES.join(', ')})`,
    )
  }
  const to = state as ProjectStateName
  const notFound = await sql.begin(async (tx) => {
    const t = tx as unknown as Sql
    const rows = await t<{ org_unit_id: string; type: string; state: string }[]>`
      SELECT org_unit_id, type, state FROM finance.project WHERE id = ${id} FOR UPDATE`
    if (rows.length === 0) return true
    const proj = rows[0]!
    assertOrgUnitWritable(actor, proj.org_unit_id)
    const table = proj.type === 'external_grant' ? projectExternalGrantTransitions : projectInternalTransitions
    const allowed = table[proj.state as ProjectStateName]
    if (allowed === undefined || !allowed.includes(to)) {
      throw new FinanceStateError(
        `project ${proj.type === 'external_grant' ? 'project_external_grant' : 'project_internal'}: ` +
          `illegal transition ${proj.state} → ${to}`,
      )
    }
    await t`UPDATE finance.project SET state = ${to} WHERE id = ${id}`
    return false
  })
  if (notFound) return null
  // Re-read through the scope-checked read path (write scope already proven → passes).
  return getProject(sql, actor, id)
}

// ── listSubOrgTypes (mirror read/sub-org.ts — DISTINCT org_unit kind) ─────────
export async function listSubOrgTypes(sql: Sql): Promise<SubOrgTypeDto[]> {
  const rows = await sql<{ kind: string }[]>`
    SELECT DISTINCT ou.kind
    FROM finance.org_unit_mirror ou
    JOIN finance.finance_unit fu ON fu.org_unit_id = ou.id
    ORDER BY ou.kind`
  return rows.map((r) => toSubOrgTypeDto(r.kind))
}

// ── listSubOrgs (mirror read/sub-org.ts) ──────────────────────────────────────
interface RawSubOrgRow {
  id: string | number
  name: string
  org_unit_id: string
  kind: string
  bookkeeping_mode: string
}
function toSubOrgDto(r: RawSubOrgRow): SubOrgDto {
  return {
    id: Number(r.id),
    name: r.name,
    type_id: KIND_TO_TYPE_ID[r.kind] ?? 0,
    type: r.kind ?? null,
    payment_method: 'standard',
    allocation_amount: 0,
    budget_plan_id: null,
    contact_email: null,
    notes: null,
    bookkeeping_mode: r.bookkeeping_mode === 'own' ? 'own' : 'central',
  }
}

export async function listSubOrgs(sql: Sql, scope: ScopeContext): Promise<SubOrgDto[]> {
  if (scope.isAuditor) {
    const rows = await sql<RawSubOrgRow[]>`
      SELECT fu.id, ou.name, fu.org_unit_id, ou.kind, fu.bookkeeping_mode
      FROM finance.finance_unit fu
      JOIN finance.org_unit_mirror ou ON ou.id = fu.org_unit_id
      ORDER BY fu.id`
    return rows.map(toSubOrgDto)
  }
  if (scope.scopedOrgUnitIds.length === 0) return []
  const rows = await sql<RawSubOrgRow[]>`
    SELECT fu.id, ou.name, fu.org_unit_id, ou.kind, fu.bookkeeping_mode
    FROM finance.finance_unit fu
    JOIN finance.org_unit_mirror ou ON ou.id = fu.org_unit_id
    WHERE fu.org_unit_id = ANY(${scope.scopedOrgUnitIds as unknown as string[]})
    ORDER BY fu.id`
  return rows.map(toSubOrgDto)
}

// ── getSubOrgSummary (mirror read/sub-org.ts) ─────────────────────────────────
export async function getSubOrgSummary(
  sql: Sql,
  scope: ScopeContext,
  id: string | number,
): Promise<SubOrgSummaryDto | null> {
  const fuRows = await sql<{ id: string; name: string; org_unit_id: string }[]>`
    SELECT fu.id, ou.name, fu.org_unit_id
    FROM finance.finance_unit fu
    JOIN finance.org_unit_mirror ou ON ou.id = fu.org_unit_id
    WHERE fu.id = ${id}`
  if (fuRows.length === 0) return null
  const fu = fuRows[0]!
  if (!scope.isAuditor && !scope.scopedOrgUnitIds.includes(fu.org_unit_id)) return null
  const planned = await sql<{ s: string | null }[]>`
    SELECT COALESCE(SUM(bt.planned_cents), 0)::text AS s
    FROM finance.budget_titel bt
    JOIN finance.budget_group bg ON bg.id = bt.budget_group_id
    JOIN finance.budget_section bs ON bs.id = bg.budget_section_id
    WHERE bs.finance_unit_id = ${id}`
  const booked = await sql<{ s: string | null }[]>`
    SELECT COALESCE(SUM(CASE WHEN bg.budget_type = 'income' THEN b.amount_cents ELSE -b.amount_cents END), 0)::text AS s
    FROM finance.booking b
    JOIN finance.budget_titel bt ON bt.id = b.budget_titel_id
    JOIN finance.budget_group bg ON bg.id = bt.budget_group_id
    JOIN finance.budget_section bs ON bs.id = bg.budget_section_id
    WHERE bs.finance_unit_id = ${id}
      AND b.state = 'posted'`
  const allocated = Number(planned[0]?.s ?? 0)
  const spent = Number(booked[0]?.s ?? 0)
  return { id: Number(fu.id), name: fu.name, allocated, spent, remaining: allocated - spent }
}

// ── sub_org_type catalog writes (mirror write/sub-org.ts) ─────────────────────
// The leaf OWNS finance.sub_org_type post-cutover. No org-unit scope (per-instance
// catalog gated at the ACL/route layer — the native writes skip assertOrgUnitWritable).
export async function createSubOrgType(
  sql: Sql,
  input: { name: string; description?: string | null },
): Promise<SubOrgTypeDto> {
  const rows = await sql<{ id: string; name: string; description: string | null }[]>`
    INSERT INTO finance.sub_org_type (name, description)
    VALUES (${input.name}, ${input.description ?? null})
    RETURNING id, name, description`
  const r = rows[0]!
  return { id: Number(r.id), name: r.name, description: r.description }
}

export async function deleteSubOrgType(sql: Sql, id: string | number): Promise<void> {
  await sql`DELETE FROM finance.sub_org_type WHERE id = ${id}`
}

// ═══════════════════════════════════════════════════════════════════════════════
// R23-7 (TASK-009 lane C) — the six BankServiceImpl money routes, ported onto the
// leaf's own finance schema: payment-order payouts (manual + cash-box), split
// allocation, SEPA export, cash-box reconciliation, and PO-match suggestion.
// Mirrors gremion-ui/.../services/money/{manual-payout-recorder,split-allocator,
// sepa-export-orchestrator,cash-box-reconciler,payment-order-matcher}.ts SQL shape
// for SQL shape, FOR UPDATE locking order and error semantics — same tables
// (finance.payment_order/booking/ledger_account/bank_transaction), same
// write-scope gate (assertOrgUnitWritable), same running_no allocator. Operator
// R23-7 (2026-09-24) chose to port these now rather than lock them 501, extending
// the FinanceBackend contract to 61 ops.
// ═══════════════════════════════════════════════════════════════════════════════

/** A domain-conflict the DB accepts syntactically but the business rule rejects
 *  (mirror native's 422 errors: SplitAllocationOverflowError,
 *  CashBoxDiscrepancyError, SepaSchemaValidationError). The route maps it to
 *  HTTP 422. Distinct from FinanceStateError (409 — an illegal STATE
 *  transition) because these are arithmetic/schema failures, not state races. */
export class FinanceUnprocessableError extends Error {
  readonly httpStatus = 422
  constructor(message: string) {
    super(message)
    this.name = 'FinanceUnprocessableError'
  }
}

export interface MoneyBookingDto {
  id: number
  ledger_account_id: number
  budget_titel_id: number
  fiscal_year_id: number
  amount_cents: number
  booking_date: string
  running_no: number
  payment_type: string
  receipt_id: number | null
  bank_transaction_id: number | null
  state: string
  supersedes: number | null
  correction_fiscal_year_id: number | null
}

export interface MoneyPaymentOrderDto {
  id: number
  expense_id: number | null
  anordnung_by: string
  feststellung_sachlich_by: string
  feststellung_rechnerisch_by: string
  dual_signature_attested: boolean
  state: string
}

export interface SplitPartDto {
  ledgerAccountId: number
  budgetTitelId: number
  fiscalYearId: number
  amountCents: number
}

export interface PaymentOrderMatchCandidateDto {
  paymentOrderId: number
  score: number
  reasons: readonly string[]
}

export type CashBoxReconciliationStatusDto = 'IN_BALANCE' | 'OVER_COUNT' | 'UNDER_COUNT'
export interface CashBoxReconciliationReportDto {
  ledgerAccountId: number
  status: CashBoxReconciliationStatusDto
  expectedCents: number
  countedCents: number
  discrepancyCents: number
  countedByUserId: string
  countedAt: string
}

interface RawMoneyBookingRow {
  id: string; ledger_account_id: string; budget_titel_id: string; fiscal_year_id: string
  amount_cents: string; booking_date: string | Date; running_no: string
  payment_type: string; receipt_id: string | null; bank_transaction_id: string | null
  state: string; supersedes: string | null; correction_fiscal_year_id: string | null
}
function parseMoneyBooking(r: RawMoneyBookingRow): MoneyBookingDto {
  return {
    id: Number(r.id), ledger_account_id: Number(r.ledger_account_id),
    budget_titel_id: Number(r.budget_titel_id), fiscal_year_id: Number(r.fiscal_year_id),
    amount_cents: Number(r.amount_cents), booking_date: toDateStr(r.booking_date),
    running_no: Number(r.running_no), payment_type: r.payment_type,
    receipt_id: r.receipt_id === null ? null : Number(r.receipt_id),
    bank_transaction_id: r.bank_transaction_id === null ? null : Number(r.bank_transaction_id),
    state: r.state,
    supersedes: r.supersedes === null ? null : Number(r.supersedes),
    correction_fiscal_year_id:
      r.correction_fiscal_year_id === null ? null : Number(r.correction_fiscal_year_id),
  }
}

interface RawMoneyPaymentOrderRow {
  id: string; expense_id: string | null; anordnung_by: string
  feststellung_sachlich_by: string; feststellung_rechnerisch_by: string
  dual_signature_attested: boolean; state: string
}
function parseMoneyPaymentOrder(r: RawMoneyPaymentOrderRow): MoneyPaymentOrderDto {
  return {
    id: Number(r.id), expense_id: r.expense_id === null ? null : Number(r.expense_id),
    anordnung_by: r.anordnung_by, feststellung_sachlich_by: r.feststellung_sachlich_by,
    feststellung_rechnerisch_by: r.feststellung_rechnerisch_by,
    dual_signature_attested: r.dual_signature_attested, state: r.state,
  }
}

/** Gap-free per-Kassenbuch running_no allocator (mirror
 *  services/write/running-no.ts#allocateRunningNo). Must run inside an open
 *  transaction; the head-row sentinel (finance.booking_running_no_head) is
 *  INSERT...ON CONFLICT DO UPDATE'd first purely to acquire its row lock —
 *  the MAX-derived value, not the upsert, is the return value. */
async function allocateMoneyRunningNo(
  tx: Sql, ledgerAccountId: number, fiscalYearId: number,
): Promise<number> {
  await tx`
    INSERT INTO finance.booking_running_no_head (ledger_account_id, fiscal_year_id)
    VALUES (${ledgerAccountId}, ${fiscalYearId})
    ON CONFLICT (ledger_account_id, fiscal_year_id) DO UPDATE
      SET fiscal_year_id = EXCLUDED.fiscal_year_id`
  const rows = await tx<{ max: string | null }[]>`
    SELECT MAX(running_no) AS max FROM finance.booking
    WHERE ledger_account_id = ${ledgerAccountId} AND fiscal_year_id = ${fiscalYearId}`
  const max = rows[0]?.max == null ? 0 : Number(rows[0].max)
  return max + 1
}

interface MoneyLedgerRow { id: string; finance_unit_id: string; type: string; bank_account_id: string | null }

/** Resolve a ledger_account's finance_unit org_unit_id and assert the actor may
 *  write it (mirror of the native recorders' ledger→finance_unit→assertOrgUnitWritable
 *  chain). Throws a plain Error on a dangling FK (should be unreachable — DB
 *  enforces it), AccessDeniedError on a write-scope denial.
 *
 *  R2-C3 LOW: renamed from lockMoneyLedger — this function takes NO row lock
 *  (no FOR UPDATE/FOR SHARE on either SELECT); callers that need one still take
 *  their own (e.g. doRecordPayout's payment_order FOR UPDATE, allocateSplit's
 *  bank_transaction FOR UPDATE). The old name implied a lock this never had. */
async function resolveMoneyLedger(tx: Sql, actor: ActorContext, ledgerAccountId: number): Promise<MoneyLedgerRow> {
  const rows = await tx<MoneyLedgerRow[]>`
    SELECT id, finance_unit_id, type, bank_account_id FROM finance.ledger_account WHERE id = ${ledgerAccountId}`
  if (rows.length === 0) throw new Error(`ledger_account#${ledgerAccountId} not found`)
  const ledger = rows[0]!
  const unitRows = await tx<{ org_unit_id: string }[]>`
    SELECT org_unit_id FROM finance.finance_unit WHERE id = ${ledger.finance_unit_id}`
  if (unitRows.length === 0) throw new Error(`finance_unit#${ledger.finance_unit_id} not found`)
  assertOrgUnitWritable(actor, unitRows[0]!.org_unit_id)
  return ledger
}

/** R2-C3 MEDIUM: assert the actor may write AT LEAST ONE finance_unit whose
 *  ledger_account backs this bank_transaction's bank_account (a bank_account
 *  can back more than one ledger_account/finance_unit — e.g. central + sub_fund
 *  ledgers on the same physical account — so this is an ANY-of-scope check, not
 *  a single-owner one). Mirrors the visibility check suggestPaymentOrderMatches
 *  already runs, but ASSERTS instead of merely filtering. Callers must run this
 *  BEFORE any other check that could echo the transaction's amount/state in an
 *  error message, so an out-of-scope id is refused before it can leak anything. */
async function assertBankTransactionOwnScopeWritable(
  tx: Sql, actor: ActorContext, bankAccountId: string,
): Promise<void> {
  const rows = await tx<{ org_unit_id: string }[]>`
    SELECT DISTINCT fu.org_unit_id
    FROM finance.ledger_account la
    JOIN finance.finance_unit fu ON fu.id = la.finance_unit_id
    WHERE la.bank_account_id = ${bankAccountId}`
  if (rows.length === 0) throw new Error(`no ledger_account backs bank_account#${bankAccountId}`)
  let lastDenial: AccessDeniedError | undefined
  for (const row of rows) {
    try {
      assertOrgUnitWritable(actor, row.org_unit_id)
      return
    } catch (err) {
      if (err instanceof AccessDeniedError) { lastDenial = err; continue }
      throw err
    }
  }
  throw lastDenial ?? new Error(`bank_account#${bankAccountId}: no writable org unit`)
}

// ── F1-FIX-05-K: write scope for the sub-org sagas and the bank-account ops ──────
// (H15 / S1b#27; H14 leaf twin / K4#34). These handlers used to run with no actor at
// all: any caller holding the internal secret -- i.e. any Finance user behind the ACL
// -- could create / rename / delete any sub-org and reconfigure, sync or inject CSV
// transactions into any bank account. The actor rides the ACL headers like every
// other write op; an absent actor is the fail-closed deny scope.

/** Create gate (native parity: services/write/sub-org.ts gates createSubOrg on the
 *  PARENT org unit, since the new sub-org has no id yet). The parent is the explicit
 *  `parentOrgUnitId` when the caller sends one, else the central finance_unit's org
 *  unit (every StuFis-era sub-org is parented under central, which is what the
 *  service-mode saga does). No resolvable parent -> only a superuser may create. */
export async function assertSubOrgCreateAllowed(
  sql: Sql, actor: ActorContext, parentOrgUnitId: string | undefined,
): Promise<void> {
  if (actor.isSuperuser) return
  let parent = parentOrgUnitId
  if (parent === undefined) {
    const rows = await sql<{ org_unit_id: string }[]>`
      SELECT org_unit_id FROM finance.finance_unit WHERE kind = 'central' LIMIT 1`
    parent = rows[0]?.org_unit_id
  }
  if (parent === undefined) throw new AccessDeniedError(actor.userId, 'central')
  assertOrgUnitWritable(actor, parent)
}

/** Update / delete gate (native parity: updateSubOrg / deleteSubOrg gate on the
 *  sub-org's OWN org unit). Returns false when the finance_unit does not exist (the
 *  handler keeps its 404); throws AccessDeniedError (403) on a scope denial. */
export async function assertFinanceUnitWritable(
  sql: Sql, actor: ActorContext, financeUnitId: string | number,
): Promise<boolean> {
  const rows = await sql<{ org_unit_id: string }[]>`
    SELECT org_unit_id FROM finance.finance_unit WHERE id = ${financeUnitId}`
  if (rows.length === 0) return false
  assertOrgUnitWritable(actor, rows[0]!.org_unit_id)
  return true
}

/** configureFints / syncFints / csvImport gate: the actor must be able to write at
 *  least one finance_unit whose ledger_account is backed by the bank account (the
 *  same ANY-of predicate the split allocation uses; native read/fints.ts shape). A
 *  superuser passes; an account no ledger backs is refused for everyone else (so an
 *  unknown id is indistinguishable from an out-of-scope one). */
export async function assertBankAccountWritable(
  sql: Sql, actor: ActorContext, bankAccountId: string | number,
): Promise<void> {
  if (actor.isSuperuser) return
  if (actor.isAuditor) throw new AccessDeniedError(actor.userId, `bank_account#${bankAccountId}`)
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM finance.ledger_account WHERE bank_account_id = ${bankAccountId}`
  if ((rows[0]?.n ?? 0) === 0) throw new AccessDeniedError(actor.userId, `bank_account#${bankAccountId}`)
  await assertBankTransactionOwnScopeWritable(sql, actor, String(bankAccountId))
}

/** TASK-009 verifier item 5b: lock a payment_order FOR UPDATE and assert the
 *  actor may write its owning org unit (PO -> expense -> finance_unit) BEFORE
 *  anything about it — existence, state, expense link — is revealed. A
 *  missing PO, a PO with no expense (non-superuser), a dangling expense/unit
 *  and an out-of-scope PO all raise the SAME AccessDeniedError (same 403,
 *  same message), so an out-of-scope caller cannot probe ids or states.
 *  A superuser may see a PO with no expense (the caller then reports
 *  no_expense as a 409). */
async function lockMoneyPaymentOrderInScope(
  tx: Sql, actor: ActorContext, paymentOrderId: number,
): Promise<{
  po: MoneyPaymentOrderDto
  exp: { finance_unit_id: string; payee_name: string; payee_iban: string | null; payee_purpose: string | null } | null
}> {
  // TASK-009 item 4: `orgUnitId` here is a masking LABEL, not an org unit —
  // give AccessDeniedError its own honest message via the optional override
  // rather than the base class's "cannot write to org_unit=payment_order#N".
  const hidden = () => new AccessDeniedError(
    actor.userId, `payment_order#${paymentOrderId}`,
    `access denied: actor=${actor.userId} cannot access payment_order#${paymentOrderId}`
  )
  const poRows = await tx<RawMoneyPaymentOrderRow[]>`
    SELECT id, expense_id, anordnung_by, feststellung_sachlich_by, feststellung_rechnerisch_by,
           dual_signature_attested, state
    FROM finance.payment_order WHERE id = ${paymentOrderId} FOR UPDATE`
  if (poRows.length === 0) throw hidden()
  const po = parseMoneyPaymentOrder(poRows[0]!)
  if (po.expense_id === null) {
    if (actor.isSuperuser) return { po, exp: null }
    throw hidden()
  }
  const expRows = await tx<{
    finance_unit_id: string; payee_name: string; payee_iban: string | null; payee_purpose: string | null
  }[]>`
    SELECT finance_unit_id, payee_name, payee_iban, payee_purpose
    FROM finance.expense WHERE id = ${po.expense_id}`
  if (expRows.length === 0) {
    // TASK-009 item 3: a payment_order pointing at an expense row that no
    // longer exists is a data-integrity problem, not a normal access-scope
    // refusal — it must stay visible in the logs even though the API
    // response is the same generic bodiless 403 as every other case here.
    console.error(
      `[finance] lockMoneyPaymentOrderInScope: payment_order#${paymentOrderId} references ` +
        `dangling expense#${po.expense_id} (no such row) — data-integrity problem`
    )
    throw hidden()
  }
  const unitRows = await tx<{ org_unit_id: string }[]>`
    SELECT org_unit_id FROM finance.finance_unit WHERE id = ${expRows[0]!.finance_unit_id}`
  if (unitRows.length === 0) {
    console.error(
      `[finance] lockMoneyPaymentOrderInScope: payment_order#${paymentOrderId}'s expense#${po.expense_id} ` +
        `references dangling finance_unit#${expRows[0]!.finance_unit_id} (no such row) — data-integrity problem`
    )
    throw hidden()
  }
  try {
    assertOrgUnitWritable(actor, unitRows[0]!.org_unit_id)
  } catch (err) {
    if (err instanceof AccessDeniedError) throw hidden()
    throw err
  }
  return { po, exp: expRows[0]! }
}

/** F1-FIX-05-K (K4#35): a booking's Titel must be one the actor may write (Titel ->
 *  group -> section -> finance_unit -> org_unit) and must belong to the plan of the
 *  booked fiscal year. Before this, payout and split bookings accepted any Titel id
 *  and any fiscal year id, so a writer of unit A could charge unit B's budget or book
 *  into a year the Titel does not belong to. Unknown Titel -> 422. */
async function assertTitelBookable(
  tx: Sql, actor: ActorContext, budgetTitelId: number, fiscalYearId: number,
): Promise<void> {
  const rows = await tx<{ org_unit_id: string; fiscal_year_id: string }[]>`
    SELECT fu.org_unit_id, bp.fiscal_year_id
    FROM finance.budget_titel bt
    JOIN finance.budget_group bg ON bg.id = bt.budget_group_id
    JOIN finance.budget_section bs ON bs.id = bg.budget_section_id
    JOIN finance.budget_plan bp ON bp.id = bs.budget_plan_id
    JOIN finance.finance_unit fu ON fu.id = bs.finance_unit_id
    WHERE bt.id = ${budgetTitelId}`
  if (rows.length === 0) throw new FinanceUnprocessableError(`budget_titel#${budgetTitelId} not found`)
  assertOrgUnitWritable(actor, rows[0]!.org_unit_id)
  if (Number(rows[0]!.fiscal_year_id) !== fiscalYearId) {
    throw new FinanceUnprocessableError(
      `budget_titel#${budgetTitelId} belongs to fiscal_year#${rows[0]!.fiscal_year_id}, not fiscal_year#${fiscalYearId}`,
    )
  }
}

/** F1-FIX-05-K (K4#17): the amount a payment order authorises -- the amount snapshot
 *  of the expense's latest APPROVED approval (what the Vier-Augen signers signed off),
 *  else the sum of the expense's receipt items (a payment order created outside the
 *  approval workflow, e.g. migrated data). */
async function authorisedPayoutCents(tx: Sql, expenseId: number): Promise<number> {
  const snap = await tx<{ amount_cents: string | null }[]>`
    SELECT amount_cents FROM finance.approval
    WHERE approvable_type = 'expense' AND approvable_id = ${expenseId} AND status = 'approved'
      AND amount_cents IS NOT NULL
    ORDER BY id DESC LIMIT 1`
  if (snap.length > 0 && snap[0]!.amount_cents !== null) return Number(snap[0]!.amount_cents)
  const sum = await tx<{ total: string }[]>`
    SELECT COALESCE(SUM(ri.amount_cents), 0)::text AS total
    FROM finance.receipt_item ri
    JOIN finance.receipt r ON r.id = ri.receipt_id
    WHERE r.expense_id = ${expenseId}`
  return Number(sum[0]?.total ?? 0)
}

interface RecordPayoutParams {
  paymentOrderId: number
  ledgerAccountId: number
  budgetTitelId: number
  fiscalYearId: number
  amountCents: number
  paidAt: string
  enforceCashBox: boolean
  paymentType: 'bargeldlos' | 'bar'
}

/** Shared body for recordManualPayout/recordCashPayout (mirror
 *  manual-payout-recorder.ts#doRecord). Locks the PO, resolves + type-checks the
 *  ledger, asserts write scope, finds a Belegprinzip-satisfying receipt, then
 *  drafts+posts the booking and walks the PO authorised -> exported -> settled. */
async function doRecordPayout(
  tx: Sql, actor: ActorContext, p: RecordPayoutParams,
): Promise<{ booking: MoneyBookingDto; paymentOrder: MoneyPaymentOrderDto }> {
  // R2-C3 MEDIUM: the PO's OWN finance_unit (via its expense) is scope-gated,
  // not only the TARGET ledger's — otherwise a writer scoped to ledger-owning
  // unit A could settle unit B's payment order through A's Kassenbuch.
  // TASK-009 item 5b: and that gate now runs BEFORE the state checks, so an
  // out-of-scope caller learns nothing about the PO's existence or state.
  const { po } = await lockMoneyPaymentOrderInScope(tx, actor, p.paymentOrderId)
  if (po.state !== 'authorised') {
    throw new FinanceStateError(`payment_order: ${po.state} -> settled is not a valid transition`)
  }
  if (po.expense_id === null) {
    throw new FinanceStateError('payment_order: no_expense -> settled is not a valid transition')
  }

  const ledger = await resolveMoneyLedger(tx, actor, p.ledgerAccountId)
  if (p.enforceCashBox && ledger.type !== 'cash_box') {
    throw new FinanceStateError(`ledger_account: ${ledger.type} -> cash_box is not a valid transition`)
  }
  if (!p.enforceCashBox && ledger.type === 'cash_box') {
    throw new FinanceStateError('ledger_account: cash_box -> manual-payout is not a valid transition')
  }

  // F1-FIX-05-K (K4#35, K4#17): the Titel is in scope and in the booked year, and the
  // payout moves exactly the authorised amount (never a caller-chosen one).
  await assertTitelBookable(tx, actor, p.budgetTitelId, p.fiscalYearId)
  const authorised = await authorisedPayoutCents(tx, po.expense_id)
  if (p.amountCents !== authorised) {
    throw new FinanceUnprocessableError(
      `payment_order#${p.paymentOrderId}: payout amount does not match the authorised amount`,
    )
  }

  const receiptRows = await tx<{ id: string }[]>`
    SELECT id FROM finance.receipt WHERE expense_id = ${po.expense_id} ORDER BY id LIMIT 1`
  if (receiptRows.length === 0) {
    throw new FinanceStateError('payment_order: no_receipt -> settled is not a valid transition')
  }
  const receiptId = Number(receiptRows[0]!.id)

  const runningNo = await allocateMoneyRunningNo(tx, p.ledgerAccountId, p.fiscalYearId)
  const draftRows = await tx<RawMoneyBookingRow[]>`
    INSERT INTO finance.booking (
      ledger_account_id, budget_titel_id, fiscal_year_id, amount_cents, booking_date,
      running_no, payment_type, receipt_id, bank_transaction_id, supersedes,
      correction_fiscal_year_id
    ) VALUES (
      ${p.ledgerAccountId}, ${p.budgetTitelId}, ${p.fiscalYearId}, ${p.amountCents},
      ${p.paidAt}, ${runningNo}, ${p.paymentType}, ${receiptId}, NULL, NULL, NULL
    ) RETURNING id, ledger_account_id, budget_titel_id, fiscal_year_id, amount_cents, booking_date,
              running_no, payment_type, receipt_id, bank_transaction_id, state, supersedes,
              correction_fiscal_year_id`
  const postedRows = await tx<RawMoneyBookingRow[]>`
    UPDATE finance.booking SET state = 'posted' WHERE id = ${draftRows[0]!.id}
    RETURNING id, ledger_account_id, budget_titel_id, fiscal_year_id, amount_cents, booking_date,
              running_no, payment_type, receipt_id, bank_transaction_id, state, supersedes,
              correction_fiscal_year_id`
  if (postedRows.length === 0) throw new Error(`booking#${draftRows[0]!.id} disappeared mid-transaction`)
  const booking = parseMoneyBooking(postedRows[0]!)

  await tx`UPDATE finance.payment_order SET state = 'exported' WHERE id = ${p.paymentOrderId}`
  const settledRows = await tx<RawMoneyPaymentOrderRow[]>`
    UPDATE finance.payment_order SET state = 'settled' WHERE id = ${p.paymentOrderId}
    RETURNING id, expense_id, anordnung_by, feststellung_sachlich_by, feststellung_rechnerisch_by,
              dual_signature_attested, state`
  if (settledRows.length === 0) throw new Error(`payment_order#${p.paymentOrderId} disappeared during settle`)
  const paymentOrder = parseMoneyPaymentOrder(settledRows[0]!)

  return { booking, paymentOrder }
}

/** Out-of-band payout (paper SEPA upload / ad-hoc bank transfer). `input.reference`
 *  is accepted for API parity but NOT persisted — the native recorder discards it
 *  too (no `reference` column on finance.booking); preserved here byte-for-byte. */
export async function recordManualPayout(
  sql: Sql, actor: ActorContext,
  input: {
    paymentOrderId: number; ledgerAccountId: number; budgetTitelId: number
    fiscalYearId: number; amountCents: number; paidAt: string; reference: string
  },
): Promise<{ booking: MoneyBookingDto; paymentOrder: MoneyPaymentOrderDto }> {
  return sql.begin((tx) => doRecordPayout(tx as unknown as Sql, actor, {
    paymentOrderId: input.paymentOrderId, ledgerAccountId: input.ledgerAccountId,
    budgetTitelId: input.budgetTitelId, fiscalYearId: input.fiscalYearId,
    amountCents: input.amountCents, paidAt: input.paidAt,
    enforceCashBox: false, paymentType: 'bargeldlos',
  })) as Promise<{ booking: MoneyBookingDto; paymentOrder: MoneyPaymentOrderDto }>
}

/** Cash-box withdrawal payout — same shape as recordManualPayout but the target
 *  ledger MUST be type='cash_box'. */
export async function recordCashPayout(
  sql: Sql, actor: ActorContext,
  input: {
    paymentOrderId: number; cashBoxLedgerId: number; budgetTitelId: number
    fiscalYearId: number; amountCents: number; paidAt: string
  },
): Promise<{ booking: MoneyBookingDto; paymentOrder: MoneyPaymentOrderDto }> {
  return sql.begin((tx) => doRecordPayout(tx as unknown as Sql, actor, {
    paymentOrderId: input.paymentOrderId, ledgerAccountId: input.cashBoxLedgerId,
    budgetTitelId: input.budgetTitelId, fiscalYearId: input.fiscalYearId,
    amountCents: input.amountCents, paidAt: input.paidAt,
    enforceCashBox: true, paymentType: 'bar',
  })) as Promise<{ booking: MoneyBookingDto; paymentOrder: MoneyPaymentOrderDto }>
}

/** Multi-Titel split allocation (mirror split-allocator.ts#allocateSplit). Locks
 *  the bank_transaction, validates the sum invariant + re-allocation refusal,
 *  type/scope-checks every part's ledger, then drafts+posts N bookings sharing
 *  the transaction as Beleg. Whole op is one transaction so partial allocation
 *  never leaks. */
export async function allocateSplit(
  sql: Sql, actor: ActorContext,
  input: { bankTransactionId: number; parts: readonly SplitPartDto[] },
): Promise<readonly MoneyBookingDto[]> {
  if (input.parts.length === 0) {
    // R2-C3 LOW: reworded — the transaction is never fetched/locked at this
    // point, so the old "!= txn 0" phrasing asserted a real amount ("0") that
    // was never actually checked. State the real reason instead.
    throw new FinanceUnprocessableError(
      `split allocation on bank_transaction#${input.bankTransactionId}: no parts supplied`,
    )
  }
  const seenLedgers = new Set<number>()
  for (const part of input.parts) {
    if (seenLedgers.has(part.ledgerAccountId)) {
      throw new FinanceStateError(
        `split_allocation: duplicate_ledger -> ledger#${part.ledgerAccountId} is not a valid transition`,
      )
    }
    seenLedgers.add(part.ledgerAccountId)
  }

  return sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as Sql
    const lockedRows = await tx<{
      id: string; amount_cents: string; allocated_ledger_account_id: string | null; bank_account_id: string
    }[]>`
      SELECT id, amount_cents, allocated_ledger_account_id, bank_account_id
      FROM finance.bank_transaction WHERE id = ${input.bankTransactionId} FOR UPDATE`
    if (lockedRows.length === 0) throw new Error(`bank_transaction#${input.bankTransactionId} not found`)
    const txn = lockedRows[0]!
    const txAmountCents = Number(txn.amount_cents)

    // R2-C3 MEDIUM: scope-gate the bank_transaction itself BEFORE the
    // sum-invariant check below (which otherwise echoes the real amount in its
    // 422 body to anyone who can guess/enumerate a bankTransactionId) and
    // before the re-allocation state checks. Only the PART ledgers were
    // scope-checked before this fix; the transaction's own backing bank
    // account was never checked at all.
    await assertBankTransactionOwnScopeWritable(tx, actor, txn.bank_account_id)

    const sum = input.parts.reduce((s, p) => s + p.amountCents, 0)
    if (sum !== txAmountCents) {
      // TASK-009 item 5a: the 422 body names NO amounts — neither the parts'
      // sum nor the transaction's real amount (the caller already knows what
      // it sent; the transaction amount is not theirs to learn from an error).
      throw new FinanceUnprocessableError(
        `split allocation overflow on bank_transaction#${input.bankTransactionId}: ` +
          `${input.parts.length} parts do not sum to the transaction amount`,
      )
    }
    // TASK-009 verifier item 4: every part carries the transaction's own sign
    // (credit -> positive parts, debit -> negative parts). A mixed-sign split
    // that happens to sum correctly would book a phantom counter-movement.
    const txSign = Math.sign(txAmountCents)
    if (input.parts.some((p) => p.amountCents === 0 || Math.sign(p.amountCents) !== txSign)) {
      throw new FinanceUnprocessableError(
        `split allocation on bank_transaction#${input.bankTransactionId}: ` +
          'every part must be non-zero with the same sign as the transaction',
      )
    }

    if (txn.allocated_ledger_account_id !== null) {
      throw new FinanceStateError('bank_transaction: single-allocated -> split-allocation is not a valid transition')
    }
    const priorBookings = await tx<{ id: string }[]>`
      SELECT id FROM finance.booking WHERE bank_transaction_id = ${input.bankTransactionId} LIMIT 1`
    if (priorBookings.length > 0) {
      throw new FinanceStateError('bank_transaction: multi-allocated -> split-allocation is not a valid transition')
    }

    for (const part of input.parts) {
      const ledger = await resolveMoneyLedger(tx, actor, part.ledgerAccountId)
      if (ledger.type === 'cash_box') {
        throw new FinanceStateError('bank_transaction: bank-source -> cash_box-split is not a valid transition')
      }
      // R2-C3 MEDIUM: a part's ledger must actually be backed by THIS
      // transaction's bank account — otherwise an in-scope ledger on a
      // wholly unrelated bank account could absorb another account's txn.
      if (ledger.bank_account_id !== txn.bank_account_id) {
        throw new FinanceStateError(
          `ledger_account#${part.ledgerAccountId}: bank_account mismatch -> split-allocation is not a valid transition`,
        )
      }
      // F1-FIX-05-K (K4#35): each part's Titel is in scope and in the part's year.
      await assertTitelBookable(tx, actor, part.budgetTitelId, part.fiscalYearId)
    }

    const dateRows = await tx<{ booking_date: Date | string }[]>`
      SELECT booking_date FROM finance.bank_transaction WHERE id = ${input.bankTransactionId}`
    const bookingDateIso = toDateStr(dateRows[0]!.booking_date)

    // R2-C3 LOW: running_no head-row locks are acquired one part at a time;
    // two concurrent splits touching ledgers {A,B} in opposite orders could
    // deadlock (40P01) waiting on each other's head row. Allocate in a fixed
    // (ledgerAccountId, fiscalYearId) order regardless of input order, but
    // keep the RETURNED bookings in the caller's original part order.
    const orderedParts = input.parts
      .map((part, originalIndex) => ({ part, originalIndex }))
      .sort((a, b) =>
        a.part.ledgerAccountId - b.part.ledgerAccountId || a.part.fiscalYearId - b.part.fiscalYearId)

    const bookings: MoneyBookingDto[] = Array.from({ length: input.parts.length })
    for (const { part, originalIndex } of orderedParts) {
      const runningNo = await allocateMoneyRunningNo(tx, part.ledgerAccountId, part.fiscalYearId)
      const insertedRows = await tx<RawMoneyBookingRow[]>`
        INSERT INTO finance.booking (
          ledger_account_id, budget_titel_id, fiscal_year_id, amount_cents, booking_date,
          running_no, payment_type, receipt_id, bank_transaction_id, supersedes,
          correction_fiscal_year_id
        ) VALUES (
          ${part.ledgerAccountId}, ${part.budgetTitelId}, ${part.fiscalYearId}, ${part.amountCents},
          ${bookingDateIso}, ${runningNo}, 'bargeldlos', NULL, ${input.bankTransactionId}, NULL, NULL
        ) RETURNING id, ledger_account_id, budget_titel_id, fiscal_year_id, amount_cents, booking_date,
                  running_no, payment_type, receipt_id, bank_transaction_id, state, supersedes,
                  correction_fiscal_year_id`
      const postedRows = await tx<RawMoneyBookingRow[]>`
        UPDATE finance.booking SET state = 'posted' WHERE id = ${insertedRows[0]!.id}
        RETURNING id, ledger_account_id, budget_titel_id, fiscal_year_id, amount_cents, booking_date,
                  running_no, payment_type, receipt_id, bank_transaction_id, state, supersedes,
                  correction_fiscal_year_id`
      if (postedRows.length === 0) throw new Error(`booking#${insertedRows[0]!.id} disappeared mid-transaction`)
      bookings[originalIndex] = parseMoneyBooking(postedRows[0]!)
    }
    return bookings
  }) as Promise<readonly MoneyBookingDto[]>
}

/** Cash-box reconciliation (mirror cash-box-reconciler.ts#reconcileCashBox).
 *  Value-not-throw on a discrepancy: the report's `status`/`discrepancyCents`
 *  carry it. Only a non-cash_box ledger or a write-scope denial throws. */
export async function reconcileCashBox(
  sql: Sql, actor: ActorContext,
  input: { cashBoxLedgerId: number; countedCents: number; countedAt: string },
): Promise<CashBoxReconciliationReportDto> {
  return sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as Sql
    const ledger = await resolveMoneyLedger(tx, actor, input.cashBoxLedgerId)
    if (ledger.type !== 'cash_box') {
      throw new FinanceStateError(`ledger_account: ${ledger.type} -> cash_box-reconcile is not a valid transition`)
    }
    const balanceRows = await tx<{ total: string | null }[]>`
      SELECT SUM(amount_cents)::TEXT AS total FROM finance.booking
      WHERE ledger_account_id = ${input.cashBoxLedgerId} AND state = 'posted'`
    const expectedCents = Number(balanceRows[0]?.total ?? 0)
    const discrepancyCents = input.countedCents - expectedCents
    const status: CashBoxReconciliationStatusDto =
      discrepancyCents === 0 ? 'IN_BALANCE' : discrepancyCents > 0 ? 'OVER_COUNT' : 'UNDER_COUNT'
    return {
      ledgerAccountId: input.cashBoxLedgerId, status, expectedCents,
      countedCents: input.countedCents, discrepancyCents,
      countedByUserId: actor.userId, countedAt: input.countedAt,
    }
  }) as Promise<CashBoxReconciliationReportDto>
}

const MONEY_MATCH_FLOOR = 0.30
const MONEY_W_AMOUNT = 0.40
const MONEY_W_BANK_REF = 0.25
const MONEY_W_IBAN = 0.20
const MONEY_W_NAME = 0.15

/** Iterative two-row Levenshtein distance (mirror
 *  payment-order-matcher.ts#levenshtein). */
function moneyLevenshtein(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from<number>({ length: n + 1 })
  let cur = Array.from<number>({ length: n + 1 })
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost)
    }
    const swap = prev
    prev = cur
    cur = swap
  }
  return prev[n]!
}

/** Score a candidate PO against a bank_transaction (mirror
 *  payment-order-matcher.ts#scoreCandidate — same weights, same floor). */
function scoreMoneyMatch(
  txn: {
    amountCents: number; counterpartyIban: string | null
    counterpartyName: string | null; bankReference: string | null; purpose: string | null
  },
  po: {
    paymentOrderId: number; expenseAmountCents: number | null
    payeeName: string; payeeIban: string | null; payeePurpose: string | null
  },
): PaymentOrderMatchCandidateDto | null {
  let score = 0
  const reasons: string[] = []
  if (po.expenseAmountCents !== null && Math.abs(po.expenseAmountCents) === Math.abs(txn.amountCents)) {
    score += MONEY_W_AMOUNT
    reasons.push('amount_eq')
  }
  if (
    txn.bankReference !== null && txn.bankReference.length > 0 &&
    ((po.payeePurpose !== null && po.payeePurpose.includes(txn.bankReference)) ||
      (txn.purpose !== null && txn.purpose.includes(txn.bankReference)))
  ) {
    score += MONEY_W_BANK_REF
    reasons.push('bank_reference_eq')
  }
  if (
    txn.counterpartyIban !== null && po.payeeIban !== null &&
    txn.counterpartyIban.replace(/\s+/g, '').toUpperCase() === po.payeeIban.replace(/\s+/g, '').toUpperCase()
  ) {
    score += MONEY_W_IBAN
    reasons.push('iban_eq')
  }
  if (
    txn.counterpartyName !== null && po.payeeName !== null &&
    moneyLevenshtein(txn.counterpartyName.trim().toLowerCase(), po.payeeName.trim().toLowerCase()) <= 2
  ) {
    score += MONEY_W_NAME
    reasons.push('name_fuzzy')
  }
  const clamped = Math.min(1, score)
  if (clamped < MONEY_MATCH_FLOOR) return null
  return { paymentOrderId: po.paymentOrderId, score: clamped, reasons }
}

/** Suggest candidate payment_orders for a bank_transaction (mirror
 *  payment-order-matcher.ts#suggestPaymentOrderMatches). Suggest-only, never
 *  mutates state. Scope-guards on the transaction's backing bank_account
 *  (ledger_account -> finance_unit ∈ scope) before scoring — an out-of-scope
 *  transaction returns [] exactly like a non-existent id. */
export async function suggestPaymentOrderMatches(
  sql: Sql, scope: ScopeContext,
  input: { bankTransactionId: number; topN?: number },
): Promise<readonly PaymentOrderMatchCandidateDto[]> {
  const topN = input.topN ?? 5
  const fuScope = await scopedFinanceUnitIds(sql, scope)
  if (fuScope.length === 0) return []

  const txnRows = await sql<{
    id: string; amount_cents: string; counterparty_iban: string | null
    counterparty_name: string | null; bank_reference: string | null
    purpose: string | null; bank_account_id: string
  }[]>`
    SELECT id, amount_cents, counterparty_iban, counterparty_name,
           bank_reference, purpose, bank_account_id
    FROM finance.bank_transaction WHERE id = ${input.bankTransactionId}`
  if (txnRows.length === 0) return []
  const txn = txnRows[0]!

  const visible = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM finance.ledger_account la
    WHERE la.bank_account_id = ${txn.bank_account_id}
      AND la.finance_unit_id = ANY(${fuScope as unknown as number[]})
    LIMIT 1`
  if (visible.length === 0) return []

  const txnView = {
    amountCents: Number(txn.amount_cents), counterpartyIban: txn.counterparty_iban,
    counterpartyName: txn.counterparty_name, bankReference: txn.bank_reference, purpose: txn.purpose,
  }

  const candidates = await sql<{
    po_id: string; payee_name: string; payee_iban: string | null
    payee_purpose: string | null; expense_amount_cents: string | null
  }[]>`
    SELECT po.id AS po_id, e.payee_name AS payee_name, e.payee_iban AS payee_iban,
           e.payee_purpose AS payee_purpose,
           (SELECT SUM(ri.amount_cents)::TEXT FROM finance.receipt r
            JOIN finance.receipt_item ri ON ri.receipt_id = r.id
            WHERE r.expense_id = e.id) AS expense_amount_cents
    FROM finance.payment_order po
    JOIN finance.expense e ON e.id = po.expense_id
    WHERE po.state IN ('authorised', 'exported')
      AND e.finance_unit_id = ANY(${fuScope as unknown as number[]})`

  const scored: PaymentOrderMatchCandidateDto[] = []
  for (const row of candidates) {
    const candidate = scoreMoneyMatch(txnView, {
      paymentOrderId: Number(row.po_id),
      expenseAmountCents: row.expense_amount_cents === null ? null : Number(row.expense_amount_cents),
      payeeName: row.payee_name, payeeIban: row.payee_iban, payeePurpose: row.payee_purpose,
    })
    if (candidate !== null) scored.push(candidate)
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topN)
}

/** End-to-end SEPA pain.001.001.09 export (mirror
 *  sepa-export-orchestrator.ts#exportSepa). Locks + validates every PO in the
 *  batch (authorised, has an expense, a payee IBAN, a non-zero receipt-item
 *  sum), builds the XML via ./bank/sepa-backend.ts (same `sepa` npm package the
 *  native oracle uses), validates it against the vendored EPC XSD, then
 *  transitions each PO to 'exported'. Whole batch is one transaction — an
 *  XSD-invalid build or any PO failing validation rolls back every prior state
 *  change, matching the native "abort the WHOLE batch" contract. */
export async function exportSepa(
  sql: Sql, actor: ActorContext,
  input: {
    paymentOrderIds: readonly number[]; initiatingPartyName: string; debtorName: string
    debtorIban: string; debtorBic: string | null; requestedExecutionDate: string
  },
): Promise<{ xml: string; exportedPaymentOrderIds: readonly number[] }> {
  const { SepaJsBackend } = await import('../bank/sepa-backend.js')
  const { xsdValidatePain001 } = await import('../bank/xsd-validator.js')

  if (input.paymentOrderIds.length === 0) {
    throw new FinanceStateError('sepa_export: empty_batch -> export is not a valid transition')
  }

  return sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as Sql
    const orders: Array<{
      po: MoneyPaymentOrderDto; payeeName: string; payeeIban: string
      payeePurpose: string; amountCents: number
    }> = []
    // R2-C3 HIGH: dedupe + sort before locking. A repeated id would otherwise be
    // FOR UPDATE-locked and pushed onto `orders` twice (the same transaction does
    // not self-block), producing two pain.001 CdtTrfTxInf entries for the same
    // payee/amount — a real double payment. Locking in a fixed ascending order
    // also avoids a lock-order deadlock (40P01) between two overlapping batches
    // that name the same PO ids in different orders.
    const uniqueSortedIds = [...new Set(input.paymentOrderIds)].sort((a, b) => a - b)
    for (const poId of uniqueSortedIds) {
      // TASK-009 item 5b: scope (PO -> expense -> finance_unit -> org unit)
      // is asserted BEFORE the PO's existence or state is revealed.
      const { po, exp } = await lockMoneyPaymentOrderInScope(tx, actor, poId)
      if (po.state !== 'authorised') {
        throw new FinanceStateError(`payment_order: ${po.state} -> exported is not a valid transition`)
      }
      if (po.expense_id === null || exp === null) {
        throw new FinanceStateError('payment_order: no_expense -> sepa_export is not a valid transition')
      }
      if (exp.payee_iban === null) {
        throw new FinanceStateError('payment_order: no_payee_iban -> sepa_export is not a valid transition')
      }
      const sumRows = await tx<{ total: string | null }[]>`
        SELECT SUM(ri.amount_cents)::TEXT AS total FROM finance.receipt r
        JOIN finance.receipt_item ri ON ri.receipt_id = r.id WHERE r.expense_id = ${po.expense_id}`
      const amountCents = sumRows[0]?.total == null ? null : Number(sumRows[0].total)
      if (amountCents === null || amountCents === 0) {
        throw new FinanceStateError('payment_order: zero_amount -> sepa_export is not a valid transition')
      }
      orders.push({
        po, payeeName: exp.payee_name, payeeIban: exp.payee_iban,
        payeePurpose: exp.payee_purpose ?? '', amountCents,
      })
    }

    // ID prefix deliberately spelled GREMION- not the historical STU-RA-OS one — the
    // no-phantom-stura-db guard bans that substring anywhere in leaf source (a
    // regression lock for a past carve incident), and there is no cross-backend
    // parity requirement on this arbitrary identifier text (each backend mints its
    // own unique msgId/endToEndId; a bank never sees both for the same PO/batch).
    const msgId = `GREMION-EXPORT-${Date.now()}`
    const batch = {
      messageId: msgId,
      creationDateTime: new Date().toISOString().slice(0, 19),
      initiatingParty: { name: input.initiatingPartyName },
      debtor: {
        name: input.debtorName, iban: input.debtorIban, bic: input.debtorBic,
        postalAddress: { townName: 'Ilmenau', country: 'DE' },
      },
      requestedExecutionDate: input.requestedExecutionDate,
      payments: orders.map((o) => ({
        endToEndId: `GREMION-PO-${o.po.id}`,
        amountCents: Math.abs(o.amountCents),
        creditorName: o.payeeName,
        creditorIban: o.payeeIban,
        creditorBic: null,
        remittanceInformation: o.payeePurpose || `payment_order ${o.po.id}`,
        postalAddress: { townName: 'Berlin', country: 'DE' },
      })),
    }

    const xml = await new SepaJsBackend().build(batch)
    await xsdValidatePain001(xml)

    const exportedIds: number[] = []
    for (const o of orders) {
      const updatedRows = await tx<{ id: string }[]>`
        UPDATE finance.payment_order SET state = 'exported' WHERE id = ${o.po.id} RETURNING id`
      if (updatedRows.length === 0) throw new Error(`payment_order#${o.po.id} disappeared during export`)
      exportedIds.push(o.po.id)
    }
    return { xml, exportedPaymentOrderIds: exportedIds }
  }) as Promise<{ xml: string; exportedPaymentOrderIds: readonly number[] }>
}
