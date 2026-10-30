// services/finance/src/http/routes.ts
//
// #369 slice 2 + 3 — the finance leaf's /api/v1/* route SURFACE. All 55 endpoints
// of the FinanceBackend contract are registered here (verb + path in lock-step
// with gremion-ui/.../backend/service-client.ts), each behind the guard (shared
// secret + tenant headers). TASK-009 lane C / R23-6 added the 53-55 finanzordnung
// config trio (getFinanzordnungProfile / getSignerConfig / updateSignerConfig).
//
// SURFACE PARTITION (final — messages-leaf precedent). Every registered op is
// guarded; the store-backed cutover is COMPLETE, so the split is now fixed:
//   - ALL 55 ops LIVE — served store-backed against the leaf's own `finance` PG via
//     the injected storeFn (the #369 slice-3 sub-org saga + the #383 Lanes A–E +
//     FIN-52's year-end closeBudget + R23-6's finanzordnung config trio). Both
//     KERNEL_COUPLING_EXCEPTIONS and DEFERRED_PORTABLE are now EMPTY — every
//     registered op reaches value-parity.
// 55 LIVE + 0 residual = 55. The LIVE_OPS set and the (now-empty)
// KERNEL_COUPLING_EXCEPTIONS set below are the SOURCE OF TRUTH for exact
// membership — this header narrates them rather than re-enumerating routes.
//
// #383 Lane B — READ DOMAINS. getBudget / getBudgetPlan / getBudgetStatement /
// listBookings reuse the SAME three-signal scope-forwarding contract as Lane A: they
// row-scope every non-auditor to its org units (via scopedFinanceUnitIds, which honours
// the superuser see-all) and 404 out-of-scope-but-existing budget plans (G-019). The
// statement read serves ONLY the read (persisted-jsonb-when-closed / interim otherwise) —
// the PDF/xlsx byte exports stay 501-locked (R5), so the leaf pulls in no render deps.
//
// #383 Lane A — SCOPE FORWARDING (R10 RESOLVED). The 5 scope-sensitive reads above
// row-scope every non-auditor actor to their org units in the native oracle
// (gremion-ui/.../services/read/{expense,bank-account,receipt,fints}.ts) and 404
// out-of-scope-but-existing resources (G-019 anti-probing). The ACL now forwards the
// actor's read scope over three internal headers — x-finance-is-auditor,
// x-finance-is-superuser, x-finance-scoped-org-units (comma-joined) — which
// scopeFromHeaders() reconstructs into a ScopeContext the store fns apply with the
// EXACT native gates (bank_account/fints gate on isAuditor only; expense/receipt on
// seesAllFinance — the superuser divergence).

import type http from 'node:http'
import type { HttpMethod, Route, RouteContext, RouteHandler } from './router.js'
import type { TenantRef, Sql } from '../tenant-store.js'
import {
  insertFinanceUnit,
  getFinanceUnitById,
  updateFinanceUnitById,
  deleteFinanceUnitForSubOrg,
  countOrgUnitFinanceRefs,
  assertSubOrgCreateAllowed,
  assertCentralScopeWritable,
  assertFinanceUnitWritable,
  assertBankAccountWritable,
  FinanceValidationError,
  AccessDeniedError,
  ApprovalWorkflowError,
  listFiscalYears,
  createFiscalYear,
  updateFiscalYear,
  listBankAccounts,
  getFintsStatus,
  listReceipts,
  uploadReceipt,
  deleteReceipt,
  publishReceipt,
  ReceiptTooLargeError,
  ReceiptMimeError,
  ReceiptNotFoundError,
  ReceiptImmutableError,
  InvalidReceiptFilenameError,
  type ReceiptUpload,
  listExpenses,
  getExpense,
  createExpense,
  getBudget,
  getBudgetPlan,
  getBudgetStatement,
  listBookings,
  listPendingApprovals,
  createApproval,
  signApproval,
  rejectApproval,
  heliosBudgetApprovalEnabled,
  createBudgetPlan,
  updateBudgetPlan,
  createBudgetGroup,
  updateBudgetGroup,
  deleteBudgetGroup,
  createBudgetItem,
  updateBudgetItem,
  deleteBudgetItem,
  activateBudget,
  assignBudgetFiscalYear,
  closeBudget,
  createProject,
  listProjects,
  getProject,
  updateProjectState,
  listSubOrgs,
  getSubOrgSummary,
  listSubOrgTypes,
  createSubOrgType,
  deleteSubOrgType,
  FinanceStateError,
  type FiscalYearPatch,
  type ScopeContext,
  type ActorContext,
  type ApprovableType,
  type ForwardedStepUp,
  type ListBookingsParams,
  getStatementProjection,
  type CreateProjectDto,
  getFinanzordnungProfile,
  getSignerConfig,
  updateSignerConfig,
  type SignerStageDef,
  type Tier,
  // TASK-009 lane C / R23-7 — the six BankServiceImpl money ops.
  recordManualPayout,
  recordCashPayout,
  allocateSplit,
  reconcileCashBox,
  suggestPaymentOrderMatches,
  exportSepa,
  FinanceUnprocessableError,
  type SplitPartDto,
} from '../store/index.js'
// #383 Lane E3 — byte exports + CSV import + FinTS (R5/R6/R11 unlock). The byte-
// generation deps (exceljs / the pdf template) live ONLY in ../exports/*; the store
// module stays JSON-pure (statement.store.test.ts boundary).
import { renderBudgetStatementHtml, groupLinesIntoSections } from '../exports/pdf.js'
import { buildBudgetExport } from '../exports/xlsx.js'
import { importCsv, BankAccountNotFoundError } from '../csv/import.js'
import type { CsvMapping } from '../csv/parser.js'
import { CsvMappingError, CsvParseError } from '../csv/errors.js'
import { configureFints, FintsConfigValidationError } from '../fints/config.js'
import { syncFints, FintsSyncNotFoundError } from '../fints/sync.js'
import { parseBoundary, parseMultipart } from './multipart.js'
// #383 Lane E2 (R7) — the receipt storage backend seam. STORAGE_BACKEND selects
// local-fs vs Nextcloud-WebDAV; getStorage() reads it lazily from the leaf env.
import { getStorage } from '../storage/index.js'

/** Augmented RouteContext: raw request/response + the guard-resolved tenant. */
export interface ApiContext extends RouteContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  tenant: TenantRef
}

/** Per-tenant store accessor (injected so the health handler / cutover can supply pools). */
export type StoreFn = (tenant: TenantRef) => Promise<Sql>
export type TenantLister = () => Promise<TenantRef[]>

/**
 * The route surface: one spec per FinanceBackend method (op), the HTTP verb it is
 * issued with, and the leaf path (query strings are stripped by the server before
 * matching, so exportBudget's ?format lives only on the client). routes.test.ts
 * asserts this covers all 55 ops in lock-step with the ACL client. The internal
 * GET /api/v1/sub-orgs/:id resolve route the updateSubOrg saga uses is NOT a
 * FinanceBackend method, so it is registered separately (see buildApiRoutes).
 */
export interface RouteSpec {
  method: HttpMethod
  path: string
  op: string
}

export const FINANCE_ROUTE_SPECS: RouteSpec[] = [
  { method: 'GET', path: '/api/v1/budget', op: 'getBudget' },
  { method: 'POST', path: '/api/v1/projects', op: 'createProject' },
  { method: 'GET', path: '/api/v1/projects', op: 'listProjects' },
  { method: 'PATCH', path: '/api/v1/projects/:id/state', op: 'updateProjectState' },
  { method: 'GET', path: '/api/v1/projects/:id', op: 'getProject' },
  { method: 'POST', path: '/api/v1/expenses', op: 'createExpense' },
  { method: 'GET', path: '/api/v1/expenses', op: 'listExpenses' },
  { method: 'GET', path: '/api/v1/expenses/:id', op: 'getExpense' },
  { method: 'GET', path: '/api/v1/bookings', op: 'listBookings' },
  { method: 'GET', path: '/api/v1/bank-accounts', op: 'listBankAccounts' },
  { method: 'GET', path: '/api/v1/approvals/pending', op: 'listPendingApprovals' },
  { method: 'POST', path: '/api/v1/projects/:id/request-approval', op: 'requestProjectApproval' },
  { method: 'POST', path: '/api/v1/expenses/:id/request-approval', op: 'requestExpenseApproval' },
  { method: 'POST', path: '/api/v1/approvals', op: 'createApproval' },
  { method: 'POST', path: '/api/v1/approvals/:id/sign', op: 'signApproval' },
  { method: 'POST', path: '/api/v1/approvals/:id/reject', op: 'rejectApproval' },
  { method: 'PUT', path: '/api/v1/bank-accounts/:id/fints', op: 'configureFints' },
  { method: 'GET', path: '/api/v1/bank-accounts/:id/fints', op: 'getFintsStatus' },
  { method: 'POST', path: '/api/v1/bank-accounts/:id/fints/sync', op: 'syncFints' },
  { method: 'GET', path: '/api/v1/expenses/:id/receipts', op: 'listReceipts' },
  { method: 'POST', path: '/api/v1/expenses/:id/receipts', op: 'uploadReceipt' },
  { method: 'DELETE', path: '/api/v1/expenses/:id/receipts/:attachmentId', op: 'deleteReceipt' },
  { method: 'POST', path: '/api/v1/expenses/:id/receipts/:attachmentId/publish', op: 'publishReceipt' },
  { method: 'GET', path: '/api/v1/sub-org-types', op: 'listSubOrgTypes' },
  { method: 'POST', path: '/api/v1/sub-org-types', op: 'createSubOrgType' },
  { method: 'DELETE', path: '/api/v1/sub-org-types/:id', op: 'deleteSubOrgType' },
  { method: 'GET', path: '/api/v1/sub-orgs', op: 'listSubOrgs' },
  { method: 'POST', path: '/api/v1/sub-orgs', op: 'createSubOrg' },
  { method: 'PATCH', path: '/api/v1/sub-orgs/:id', op: 'updateSubOrg' },
  { method: 'DELETE', path: '/api/v1/sub-orgs/:id', op: 'deleteSubOrg' },
  { method: 'GET', path: '/api/v1/sub-orgs/:id/summary', op: 'getSubOrgSummary' },
  { method: 'POST', path: '/api/v1/budget-plans', op: 'createBudgetPlan' },
  { method: 'GET', path: '/api/v1/budget-plans/:id', op: 'getBudgetPlan' },
  { method: 'PATCH', path: '/api/v1/budget-plans/:id', op: 'updateBudgetPlan' },
  { method: 'POST', path: '/api/v1/budget-plans/:budgetId/groups', op: 'createBudgetGroup' },
  { method: 'PATCH', path: '/api/v1/budget-plans/:budgetId/groups/:groupId', op: 'updateBudgetGroup' },
  { method: 'DELETE', path: '/api/v1/budget-plans/:budgetId/groups/:groupId', op: 'deleteBudgetGroup' },
  { method: 'POST', path: '/api/v1/budget-plans/:budgetId/groups/:groupId/items', op: 'createBudgetItem' },
  { method: 'PATCH', path: '/api/v1/budget-plans/:budgetId/groups/:groupId/items/:itemId', op: 'updateBudgetItem' },
  { method: 'DELETE', path: '/api/v1/budget-plans/:budgetId/groups/:groupId/items/:itemId', op: 'deleteBudgetItem' },
  { method: 'POST', path: '/api/v1/budget-plans/:id/request-approval', op: 'requestBudgetApproval' },
  { method: 'POST', path: '/api/v1/budget-plans/:id/activate', op: 'activateBudget' },
  { method: 'POST', path: '/api/v1/budget-plans/:id/close', op: 'closeBudget' },
  { method: 'GET', path: '/api/v1/budget-plans/:id/statement', op: 'getBudgetStatement' },
  { method: 'GET', path: '/api/v1/budget-plans/:id/statement/pdf', op: 'getBudgetStatementPdf' },
  { method: 'GET', path: '/api/v1/budget-plans/:id/export', op: 'exportBudget' },
  { method: 'GET', path: '/api/v1/fiscal-years', op: 'listFiscalYears' },
  { method: 'POST', path: '/api/v1/fiscal-years', op: 'createFiscalYear' },
  { method: 'PATCH', path: '/api/v1/fiscal-years/:id', op: 'updateFiscalYear' },
  { method: 'PUT', path: '/api/v1/budget-plans/:budgetId/fiscal-year', op: 'assignBudgetFiscalYear' },
  { method: 'POST', path: '/api/v1/bank-accounts/:id/csv-import', op: 'csvImport' },
  // #369 slice-3 referential guard (52nd op). GET by org_unit_id — the leaf's DB
  // holds the finance rows that reference the org unit.
  { method: 'GET', path: '/api/v1/org-units/:orgUnitId/finance-refs', op: 'checkOrgUnitFinanceRefs' },
  // TASK-009 lane C / R23-6 — the finanzordnung config trio (53rd-55th ops).
  { method: 'GET', path: '/api/v1/finanzordnung', op: 'getFinanzordnungProfile' },
  { method: 'GET', path: '/api/v1/finanzordnung/signer-config', op: 'getSignerConfig' },
  { method: 'PUT', path: '/api/v1/finanzordnung/signer-config', op: 'updateSignerConfig' },
  // TASK-009 lane C / R23-7 — the six BankServiceImpl money ops (56th-61st ops),
  // extending the contract beyond the 55 the R23-6 amendment set.
  { method: 'POST', path: '/api/v1/payment-orders/:id/record-cash-payout', op: 'recordCashPayout' },
  { method: 'POST', path: '/api/v1/payment-orders/:id/record-manual-payout', op: 'recordManualPayout' },
  { method: 'GET', path: '/api/v1/payment-orders/:id/suggest-matches', op: 'suggestPaymentOrderMatches' },
  { method: 'POST', path: '/api/v1/sepa/export', op: 'exportSepa' },
  { method: 'POST', path: '/api/v1/cash-boxes/:ledgerId/reconcile', op: 'reconcileCashBox' },
  { method: 'POST', path: '/api/v1/bank-transactions/:id/allocate-split', op: 'allocateSplit' },
]

/** The ops served LIVE (store-backed) — the finance leaf's FINAL surface: ALL 55
 *  registered ops (KERNEL_COUPLING_EXCEPTIONS is now empty). Every LIVE op reaches
 *  full value-parity with the native oracle, grouped below by lane: the #369 slice-3
 *  sub-org saga; #383 fiscal_year (leaf-local, no org_unit dimension); Lane A
 *  scope-sensitive reads (listBankAccounts / getFintsStatus / listReceipts /
 *  listExpenses / getExpense); Lane B budget/statement/booking reads; Lane C the
 *  Vier-Augen approval family + createExpense; Lane D budget CRUD + lifecycle; FIN-52
 *  the year-end closeBudget; Lane E1 project + sub-org-read / sub_org_type; Lane E2
 *  the receipts write trio; Lane E3 byte exports + CSV import + FinTS; TASK-009
 *  R23-6 the finanzordnung config trio. The
 *  scope-sensitive lanes reproduce the native per-actor org-unit row-scoping from the
 *  scope the ACL forwards over the internal finance headers (see the file header +
 *  scopeFromHeaders). */
const LIVE_OPS = new Set([
  // #369 slice-3 sub-org saga + referential guard
  'createSubOrg',
  'updateSubOrg',
  'deleteSubOrg',
  'checkOrgUnitFinanceRefs',
  // #383 fiscal_year domain (leaf-local statutory entity — not actor-scoped)
  'listFiscalYears',
  'createFiscalYear',
  'updateFiscalYear',
  // #383 Lane A scope-sensitive reads (R10 — row-scoped via forwarded scope)
  'listBankAccounts',
  'getFintsStatus',
  'listReceipts',
  'listExpenses',
  'getExpense',
  // #383 Lane B read domains (budget/statement/bookings — same forwarded scope)
  'getBudget',
  'getBudgetPlan',
  'getBudgetStatement',
  'listBookings',
  // #383 Lane C — Vier-Augen approval family + createExpense (R3 + R9). The full
  // native workflow ported into the leaf store (org-scope guard + amount/tier + stage
  // machine + four-eyes + certifies-token payment_order + finalise/reject); the
  // step-up LEVEL gate stays in the ACL client, which forwards step_up_loa/step_up_at.
  'listPendingApprovals',
  'requestProjectApproval',
  'requestExpenseApproval',
  'createApproval',
  'signApproval',
  'rejectApproval',
  'requestBudgetApproval',
  'createExpense',
  // #383 Lane D — budget CRUD + lifecycle write domain (all leaf-local: budget_plan/
  // section/group/titel; the §11 write-scope gate resolves the target org unit from
  // finance_unit.org_unit_id, which the leaf owns — NO org_units join, so these carry
  // NONE of the projects/sub-org-read kernel coupling). DTO parity with the write facade
  // (services/write/index.ts): create/update ship EMPTY actuals (booked=0), activate/
  // assign ship REAL actuals; activate enforces the §4.1 approved→active edge.
  'createBudgetPlan',
  'updateBudgetPlan',
  'createBudgetGroup',
  'updateBudgetGroup',
  'deleteBudgetGroup',
  'createBudgetItem',
  'updateBudgetItem',
  'deleteBudgetItem',
  'activateBudget',
  'assignBudgetFiscalYear',
  // #383 / FIN-52 — the WP-YearEnd close. The last kernel-coupling residual, ported
  // LEAF-LOCAL: closeBudget composes + persists the Jahresabschluss statement jsonb,
  // applies the §3.5 reserve deltas + §5.2 retention markers, and flips state→closed —
  // all against the leaf's own schema (the inventar walks org_unit_mirror, NOT the kernel
  // org_units), so it carries NO kernel coupling. KERNEL_COUPLING_EXCEPTIONS is now empty.
  'closeBudget',
  // #383 Lane E1 — project (R1) + sub-org-read / sub_org_type (R2) domain. The last
  // KERNEL-coupling residual is retired by the leaf-local `finance.org_unit_mirror`
  // (kept in sync by the kernel org-unit event pipeline + the id-preserving backfill)
  // + the leaf-owned `finance.sub_org_type`. These 9 ops now read/write LEAF-LOCAL
  // with the native per-actor scoping (isAuditor-only see-all on the reads; §11
  // write-scope on createProject/updateProjectState). listSubOrgTypes derives the
  // types from DISTINCT org_unit_mirror.kind exactly as the native oracle derives
  // them from DISTINCT org_units.kind.
  'createProject',
  'listProjects',
  'getProject',
  'updateProjectState',
  'listSubOrgs',
  'getSubOrgSummary',
  'listSubOrgTypes',
  'createSubOrgType',
  'deleteSubOrgType',
  // #383 Lane E3 — byte exports + CSV import + FinTS (R5/R6/R11 resolved).
  //   getBudgetStatementPdf / exportBudget: raw-byte responses over the SAME
  //   visibility-gated plan projection as getBudgetStatement (scope-forwarded,
  //   out-of-scope → 404); exceljs + the pure-HTML pdf template live in src/exports/*.
  //   csvImport: multipart intake (src/http/multipart.ts) → the ported native
  //   parser pipeline (Papa header-parse → unparse ';' → parseCsv) → ON CONFLICT
  //   DO NOTHING dedup inserts.
  //   configureFints / syncFints: AES-256-GCM at-rest config upsert + the sync
  //   pipeline against the injectable FinTS client. G-019b ZKA posture: without
  //   FINTS_PRODUCT_ID the sync records a failed attempt + returns
  //   { imported:0, skipped:0, errors:[msg] } — IDENTICAL to native-unconfigured;
  //   live bank sync stays ZKA-gated in BOTH modes.
  'getBudgetStatementPdf',
  'exportBudget',
  'csvImport',
  'configureFints',
  'syncFints',
  // #383 Lane E2 — the receipts trio (R7 resolved). The last DEFERRED_PORTABLE ops:
  // finance.expense_attachment writes over the leaf storage backend (src/storage/* —
  // STORAGE_BACKEND local-fs / Nextcloud-WebDAV; the leaf carries its own WebDAV client).
  // uploadReceipt rides the SAME multipart intake Lane E3 shipped; deleteReceipt/
  // publishReceipt are no-body ops. §11 write-scope + published-immutable + byte-parity
  // handles identical to the native oracle (services/write/receipt-storage.ts).
  'uploadReceipt',
  'deleteReceipt',
  'publishReceipt',
  // TASK-009 lane C / R23-6 — the finanzordnung config trio. Plain leaf-local
  // singleton reads/write (no org_unit dimension); updateSignerConfig re-checks
  // the caller's forwarded groups (admin/it-admin) before applying the write.
  'getFinanzordnungProfile',
  'getSignerConfig',
  'updateSignerConfig',
  // TASK-009 lane C / R23-7 — the six BankServiceImpl money ops, ported onto the
  // leaf's own finance schema (same tables the backfill already copies).
  'recordManualPayout',
  'recordCashPayout',
  'suggestPaymentOrderMatches',
  'allocateSplit',
  'exportSepa',
  'reconcileCashBox',
])

/**
 * The ops that CANNOT be served from the leaf and stay 501-locked as a NAMED
 * exception (see docs/runbooks/finance-cutover.md + PR #383 body). This set is now
 * EMPTY — every op is LIVE.
 *
 * (The former YEAR-END coupling — closeBudget, which delegated to the WP-YearEnd
 *  orchestrator across ~13 services/yearend/* modules — was retired by FIN-52: the
 *  Jahresabschluss composition (statement / reserves / retention / state flip) is now
 *  ported LEAF-LOCAL against the leaf's own schema, so closeBudget is LIVE above. The
 *  former KERNEL org_units coupling — createProject / listProjects / getProject /
 *  updateProjectState / listSubOrgs / getSubOrgSummary / listSubOrgTypes /
 *  createSubOrgType / deleteSubOrgType — was retired earlier in Lane E1 by the org-unit
 *  mirror; those 9 ops are LIVE too.)
 */
export const KERNEL_COUPLING_EXCEPTIONS = new Set<string>()

/**
 * Leaf-local ops that are portable in principle but DEFERRED to a follow-up because
 * they need NEW leaf transport/deps the surface does not yet carry. These are NOT
 * coupling exceptions — they are honest residual work (tracked in the runbook).
 *
 * #383 Lane E3 unlocked five (csvImport / configureFints / syncFints /
 * getBudgetStatementPdf / exportBudget); **#383 Lane E2 unlocked the LAST three —
 * the receipts trio (uploadReceipt / deleteReceipt / publishReceipt, R7)** over the
 * leaf storage backend seam (src/storage/*, the leaf's own WebDAV client). This set is
 * now EMPTY: every DEFERRED_PORTABLE op has been carried across to LIVE_OPS. With FIN-52's
 * closeBudget port and TASK-009 R23-6's finanzordnung config trio, the finance leaf
 * surface is FINAL at 55 LIVE ⊍ 0 residual = 55.
 */
export const DEFERRED_PORTABLE = new Set<string>([])

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** A request body that is not a JSON object (F1-FIX-05-K, K4#4). The server maps it
 *  to 400 'invalid JSON body' before any store call. */
export class BadJsonBodyError extends Error {
  readonly httpStatus = 400
  constructor(reason: string) {
    super(`invalid JSON body: ${reason}`)
    this.name = 'BadJsonBodyError'
  }
}

/** Read + JSON-parse the request body. An empty body means {}; a malformed body or
 *  a JSON value that is not an object (array, null, string, number) throws
 *  BadJsonBodyError -- it used to become {}, so a truncated mutation ran as an empty
 *  one (a sign request without its note still signed). */
async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw.length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new BadJsonBodyError('not parseable')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadJsonBodyError('not an object')
  }
  return parsed as Record<string, unknown>
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

// ── Lane E3 byte-transport helpers ────────────────────────────────────────────

/** Read the FULL raw request body as a Buffer (multipart intake — the body must
 *  NEVER round-trip through a utf8 string). Buffer.concat allocates an exact-size
 *  result; the multipart parser then COPIES each part out of it (pooled-buffer
 *  lesson — parts never alias the request buffer). */
async function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** Write a raw-byte response with an explicit exact content-length (the byte ops'
 *  HTTP envelope: the ACL client streams the body straight through). */
function sendBytes(
  res: http.ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: Buffer,
): void {
  res.writeHead(status, { ...headers, 'content-length': String(body.byteLength) })
  res.end(body)
}

/** Read a single request header value (node lowercases keys; arrays → first). */
function header(req: http.IncomingMessage, key: string): string | undefined {
  const v = (req.headers ?? {})[key]
  return Array.isArray(v) ? v[0] : v
}

/** Reconstruct the actor's finance read scope from the internal headers the ACL
 *  forwards (x-finance-is-auditor / x-finance-is-superuser / x-finance-scoped-org-
 *  units). Absent/empty headers → fail-closed deny scope (not auditor, not
 *  superuser, no org units) so a request without the scope contract sees nothing. */
function scopeFromHeaders(req: http.IncomingMessage): ScopeContext {
  const list = header(req, 'x-finance-scoped-org-units')
  return {
    isAuditor: header(req, 'x-finance-is-auditor') === 'true',
    isSuperuser: header(req, 'x-finance-is-superuser') === 'true',
    scopedOrgUnitIds: list ? list.split(',').filter((s) => s.length > 0) : [],
  }
}

/** Reconstruct the full WRITE actor from the ACL headers: the read scope
 *  (scopeFromHeaders) PLUS the actor identity (x-finance-user-id) and Keycloak group
 *  memberships (x-finance-groups-json, base64url of a JSON array). The write ops (createExpense + the
 *  Vier-Augen approval family) need the identity for created_by / signer eligibility
 *  and the groups for per-stage required_group checks. Absent headers → fail-closed
 *  ('' user, no groups) on top of the deny scope. */
function actorFromHeaders(req: http.IncomingMessage): ActorContext {
  return {
    ...scopeFromHeaders(req),
    userId: header(req, 'x-finance-user-id') ?? '',
    groups: groupsFromHeader(header(req, 'x-finance-groups-json')),
  }
}

/** Decode the actor's Keycloak groups from x-finance-groups-json =
 *  base64url(JSON.stringify(groups)). A comma-joined list is ambiguous: a group NAME
 *  containing ',' would split into extra entries and could smuggle a signer group into
 *  the per-stage eligibility check, so the old x-finance-groups header is no longer
 *  read (and must not be read again). Absent, undecodable or non-array values are the
 *  fail-closed empty set (logged); non-string and empty entries are dropped. */
function groupsFromHeader(value: string | undefined): string[] {
  if (value === undefined || value.length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    console.error('[finance] x-finance-groups-json is not base64url JSON; treating the actor as having no groups')
    return []
  }
  if (!Array.isArray(parsed)) {
    console.error('[finance] x-finance-groups-json is not a JSON array; treating the actor as having no groups')
    return []
  }
  return parsed.filter((g): g is string => typeof g === 'string' && g.length > 0)
}

/** The forwarded step-up proof the ACL client resolves from the actor's LoA and sends
 *  on a sign/reject body (never leaf-generated). A non-numeric / absent step_up_loa →
 *  null (below the step-up threshold); step_up_at is forwarded verbatim (ISO string). */
function stepUpFromBody(body: Record<string, unknown>): ForwardedStepUp {
  const loa = body.step_up_loa
  const at = body.step_up_at
  return {
    stepUpLoa: typeof loa === 'number' && Number.isFinite(loa) ? loa : null,
    stepUpAt: typeof at === 'string' && at.length > 0 ? at : null,
  }
}

/** Parse the ?page query (listExpenses) from the raw request URL — the server
 *  strips the query only for route MATCHING; req.url still carries it. */
function pageParam(req: http.IncomingMessage): number | undefined {
  const q = (req.url ?? '').split('?')[1]
  if (!q) return undefined
  const raw = new URLSearchParams(q).get('page')
  return raw != null ? Number(raw) : undefined
}

/** Run a store-backed handler body, mapping the leaf's typed domain errors to their
 *  HTTP status (mirrors the native routes' domain-Error → 4xx mapping):
 *    - FinanceValidationError            → 400
 *    - AccessDeniedError                 → 403 (write-scope denial)
 *    - ApprovalWorkflowError             → err.httpStatus (403 / 400 / 409 / 500)
 *  Any other error propagates to the server's top-level 500 handler. */
async function runStore(res: http.ServerResponse, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof FinanceValidationError) {
      return sendJson(res, 400, { success: false, error: err.message })
    }
    if (err instanceof AccessDeniedError) {
      return sendJson(res, 403, { success: false, error: err.message, code: 'ACCESS_DENIED' })
    }
    if (err instanceof ApprovalWorkflowError) {
      return sendJson(res, err.httpStatus, { success: false, error: err.message, code: err.code })
    }
    if (err instanceof FinanceStateError) {
      return sendJson(res, err.httpStatus, { success: false, error: err.message, code: 'ILLEGAL_TRANSITION' })
    }
    // R23-7 — a domain-conflict the DB accepts but the business rule rejects
    // (split-sum mismatch, SEPA XSD validation). 422, distinct from the 409
    // FinanceStateError case above.
    if (err instanceof FinanceUnprocessableError) {
      return sendJson(res, err.httpStatus, { success: false, error: err.message, code: 'UNPROCESSABLE' })
    }
    throw err
  }
}

/** The 501 surface-lock handler for a not-yet-cut-over op. */
function lockedHandler(op: string): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { res } = ctx as ApiContext
    sendJson(res, 501, {
      success: false,
      error: `not implemented: ${op} (finance leaf route surface locked until the operator-held cutover)`,
    })
  }
}

// ── LIVE slice-3 handlers (store-backed) ─────────────────────────────────────

function createSubOrgHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant } = ctx as ApiContext
    const body = await readJsonBody(req)
    const orgUnitId = str(body.org_unit_id)
    if (!orgUnitId) return sendJson(res, 400, { success: false, error: 'org_unit_id (string) is required' })
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      // F1-FIX-05-K (H15): the write actor must be able to write the parent org unit.
      await assertSubOrgCreateAllowed(sql, actorFromHeaders(req), orgUnitId, str(body.parent_org_unit_id))
      const fu = await insertFinanceUnit(sql, {
        orgUnitId,
        kind: str(body.kind),
        bookkeepingMode: str(body.bookkeeping_mode),
        carryOverRule: str(body.carry_over_rule),
      })
      sendJson(res, 200, fu)
    })
  }
}

function resolveSubOrgHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { res, tenant, params } = ctx as ApiContext
    const sql = await storeFn(tenant)
    const fu = await getFinanceUnitById(sql, params.id!)
    if (!fu) return sendJson(res, 404, { success: false, error: 'sub-org not found' })
    sendJson(res, 200, fu)
  }
}

function updateSubOrgHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const body = await readJsonBody(req)
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      // F1-FIX-05-K (H15): the write actor must be able to write the sub-org itself.
      if (!(await assertFinanceUnitWritable(sql, actorFromHeaders(req), params.id!))) {
        return sendJson(res, 404, { success: false, error: 'sub-org not found' })
      }
      const fu = await updateFinanceUnitById(sql, params.id!, {
        bookkeepingMode: str(body.bookkeeping_mode),
        carryOverRule: str(body.carry_over_rule),
      })
      if (!fu) return sendJson(res, 404, { success: false, error: 'sub-org not found' })
      sendJson(res, 200, fu)
    })
  }
}

function deleteSubOrgHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      // F1-FIX-05-K (H15): the write actor must be able to write the sub-org itself.
      if (!(await assertFinanceUnitWritable(sql, actorFromHeaders(req), params.id!))) {
        return sendJson(res, 404, { success: false, error: 'sub-org not found' })
      }
      const result = await deleteFinanceUnitForSubOrg(sql, params.id!)
      if (result.status === 'not_found') return sendJson(res, 404, { success: false, error: 'sub-org not found' })
      if (result.status === 'blocked') {
        return sendJson(res, 409, {
          success: false,
          error: 'sub-org still referenced by finance rows (RESTRICT)',
          counts: result.counts,
        })
      }
      sendJson(res, 200, { org_unit_id: result.orgUnitId })
    })
  }
}

function financeRefsHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { res, tenant, params } = ctx as ApiContext
    const sql = await storeFn(tenant)
    const counts = await countOrgUnitFinanceRefs(sql, params.orgUnitId!)
    const referenced = Object.values(counts).some((n) => n > 0)
    sendJson(res, 200, { referenced, counts })
  }
}

// ── LIVE fiscal_year handlers (#383 leaf gap-close) ──────────────────────────
// listFiscalYears / createFiscalYear / updateFiscalYear — a leaf-local statutory
// entity (no org_units join). Bodies use the client's snake_case DTO
// ({ name, start_date, end_date }); the store input is camelCase.

function listFiscalYearsHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { res, tenant } = ctx as ApiContext
    const sql = await storeFn(tenant)
    sendJson(res, 200, await listFiscalYears(sql))
  }
}

function createFiscalYearHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant } = ctx as ApiContext
    const body = await readJsonBody(req)
    const name = str(body.name)
    const startDate = str(body.start_date)
    const endDate = str(body.end_date)
    if (!name || !startDate || !endDate) {
      return sendJson(res, 400, { success: false, error: 'name, start_date, end_date (strings) are required' })
    }
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      await assertCentralOrConfigAdmin(sql, actorFromHeaders(req))
      sendJson(res, 200, await createFiscalYear(sql, { name, startDate, endDate }))
    })
  }
}

function updateFiscalYearHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const body = await readJsonBody(req)
    const patch: FiscalYearPatch = {}
    if (typeof body.name === 'string') patch.name = body.name
    if (typeof body.start_date === 'string') patch.startDate = body.start_date
    if (typeof body.end_date === 'string') patch.endDate = body.end_date
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      await assertCentralOrConfigAdmin(sql, actorFromHeaders(req))
      const fy = await updateFiscalYear(sql, params.id!, patch)
      if (!fy) return sendJson(res, 404, { success: false, error: 'fiscal_year not found' })
      sendJson(res, 200, fy)
    })
  }
}

// ── LIVE scope-sensitive read handlers (#383 Lane A — R10) ───────────────────
// listBankAccounts / getFintsStatus / listReceipts / listExpenses / getExpense.
// Each reconstructs the actor's read scope from the forwarded internal headers
// (scopeFromHeaders) and hands it to the store fn, which reproduces the native
// oracle's per-actor row-scoping. A store fn returning null → 404 (G-019 anti-
// probing: an out-of-scope-but-existing resource is indistinguishable from absent).

function listBankAccountsHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant } = ctx as ApiContext
    const sql = await storeFn(tenant)
    sendJson(res, 200, await listBankAccounts(sql, scopeFromHeaders(req)))
  }
}

function getFintsStatusHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const sql = await storeFn(tenant)
    const status = await getFintsStatus(sql, params.id!, scopeFromHeaders(req))
    if (status === null) return sendJson(res, 404, { success: false, error: 'bank account not found' })
    sendJson(res, 200, status)
  }
}

function listReceiptsHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const sql = await storeFn(tenant)
    const receipts = await listReceipts(sql, params.id!, scopeFromHeaders(req))
    if (receipts === null) return sendJson(res, 404, { success: false, error: 'expense not found' })
    sendJson(res, 200, receipts)
  }
}

function listExpensesHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant } = ctx as ApiContext
    const sql = await storeFn(tenant)
    sendJson(res, 200, await listExpenses(sql, pageParam(req), scopeFromHeaders(req)))
  }
}

function getExpenseHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const sql = await storeFn(tenant)
    const expense = await getExpense(sql, params.id!, scopeFromHeaders(req))
    if (expense === null) return sendJson(res, 404, { success: false, error: 'expense not found' })
    sendJson(res, 200, expense)
  }
}

// ── LIVE budget read handlers (#383 Lane B) ──────────────────────────────────
// getBudget / getBudgetPlan / getBudgetStatement / listBookings. Each reconstructs the
// actor's read scope from the forwarded internal headers (scopeFromHeaders) and hands it
// to the store fn, which reproduces the native oracle's per-actor row-scoping. The two
// id-addressed reads (getBudgetPlan / getBudgetStatement) return 404 when the store fn
// yields null (absent OR out-of-scope-but-existing → G-019 anti-probing). NB the byte
// exports (getBudgetStatementPdf / exportBudget) stay 501-locked (R5) — NOT wired here.

function getBudgetHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant } = ctx as ApiContext
    const sql = await storeFn(tenant)
    sendJson(res, 200, await getBudget(sql, scopeFromHeaders(req)))
  }
}

function getBudgetPlanHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const sql = await storeFn(tenant)
    const plan = await getBudgetPlan(sql, params.id!, scopeFromHeaders(req))
    if (plan === null) return sendJson(res, 404, { success: false, error: 'budget plan not found' })
    sendJson(res, 200, plan)
  }
}

function getBudgetStatementHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const sql = await storeFn(tenant)
    const statement = await getBudgetStatement(sql, params.id!, scopeFromHeaders(req))
    if (statement === null) return sendJson(res, 404, { success: false, error: 'budget plan not found' })
    sendJson(res, 200, statement)
  }
}

/** Parse listBookings' filters from the raw request URL (account_id / date_from /
 *  date_to / page). The server strips the query only for route MATCHING; req.url still
 *  carries it. A non-numeric account_id/page is dropped (→ undefined), letting the store
 *  clamp page to 1 and skip the account filter. */
function bookingParams(req: http.IncomingMessage): ListBookingsParams {
  const q = (req.url ?? '').split('?')[1]
  if (!q) return {}
  const p = new URLSearchParams(q)
  const num = (v: string | null): number | undefined => {
    if (v == null) return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const params: ListBookingsParams = {}
  const accountId = num(p.get('account_id'))
  if (accountId !== undefined) params.account_id = accountId
  const dateFrom = str(p.get('date_from') ?? undefined)
  if (dateFrom !== undefined) params.date_from = dateFrom
  const dateTo = str(p.get('date_to') ?? undefined)
  if (dateTo !== undefined) params.date_to = dateTo
  const page = num(p.get('page'))
  if (page !== undefined) params.page = page
  return params
}

function listBookingsHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant } = ctx as ApiContext
    const sql = await storeFn(tenant)
    sendJson(res, 200, await listBookings(sql, bookingParams(req), scopeFromHeaders(req)))
  }
}

// ── LIVE Vier-Augen approval family + createExpense handlers (#383 Lane C) ────
// createExpense + listPendingApprovals + the request*/createApproval openers +
// signApproval/rejectApproval. The write ops reconstruct the full WRITE actor from
// the ACL headers (actorFromHeaders); listPendingApprovals uses only the read scope.
// sign/reject persist the FORWARDED step_up_loa/step_up_at (stepUpFromBody) verbatim.
// Typed domain errors map to their HTTP status via runStore (AccessDenied → 403,
// ApprovalWorkflowError → its code's status). request*/createApproval return the
// { approval_id } DTO; sign/reject return the bare ApprovalStatus string.

function createExpenseHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant } = ctx as ApiContext
    const body = await readJsonBody(req)
    const projektId = Number(body.projekt_id)
    const zahlungName = str(body.zahlung_name)
    if (!Number.isFinite(projektId) || !zahlungName) {
      return sendJson(res, 400, { success: false, error: 'projekt_id (number) and zahlung_name (string) are required' })
    }
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      const expense = await createExpense(sql, actorFromHeaders(req), {
        projekt_id: projektId,
        name_suffix: str(body.name_suffix),
        zahlung_name: zahlungName,
        zahlung_iban: str(body.zahlung_iban),
        zahlung_vwzk: str(body.zahlung_vwzk),
        address: str(body.address),
      })
      sendJson(res, 200, expense)
    })
  }
}

function listPendingApprovalsHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant } = ctx as ApiContext
    const sql = await storeFn(tenant)
    sendJson(res, 200, await listPendingApprovals(sql, scopeFromHeaders(req)))
  }
}

/** Shared opener for the request-approval + createApproval ops — all shims onto
 *  createApproval (mirror the write facade). Returns the { approval_id } DTO. */
function openApprovalHandler(
  storeFn: StoreFn,
  resolve: (
    req: http.IncomingMessage,
    sql: Sql,
    params: Record<string, string | undefined>,
  ) => Promise<{ approvableType: ApprovableType; approvableId: number; method?: 'manual' | 'helios' }>,
): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      const input = await resolve(req, sql, params)
      sendJson(res, 200, await createApproval(sql, actorFromHeaders(req), input))
    })
  }
}

function signApprovalHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const body = await readJsonBody(req)
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      const status = await signApproval(sql, actorFromHeaders(req), Number(params.id), {
        note: str(body.note),
        ...stepUpFromBody(body),
      })
      sendJson(res, 200, status)
    })
  }
}

function rejectApprovalHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const body = await readJsonBody(req)
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      const status = await rejectApproval(sql, actorFromHeaders(req), Number(params.id), {
        note: str(body.note) ?? '',
        ...stepUpFromBody(body),
      })
      sendJson(res, 200, status)
    })
  }
}

// ── LIVE budget write handlers (#383 Lane D) ─────────────────────────────────
// createBudgetPlan / updateBudgetPlan / createBudgetGroup / updateBudgetGroup /
// deleteBudgetGroup / createBudgetItem / updateBudgetItem / deleteBudgetItem /
// activateBudget / assignBudgetFiscalYear. All reconstruct the WRITE actor from the
// ACL headers (actorFromHeaders) for the §11 org-unit write-scope gate. Typed domain
// errors map via runStore (AccessDenied→403, FinanceValidation→400, FinanceState→409);
// a store fn returning null → 404. DTO shapes match the ACL client verbatim.

function createBudgetPlanHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant } = ctx as ApiContext
    const body = await readJsonBody(req)
    const fiscalYearId = Number(body.fiscal_year_id)
    if (!Number.isFinite(fiscalYearId)) {
      return sendJson(res, 400, { success: false, error: 'fiscal_year_id (number) is required' })
    }
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      sendJson(res, 200, await createBudgetPlan(sql, actorFromHeaders(req), { fiscalYearId }))
    })
  }
}

function updateBudgetPlanHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const body = await readJsonBody(req)
    const patch: { name?: string } = {}
    if (typeof body.name === 'string') patch.name = body.name
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      const plan = await updateBudgetPlan(sql, actorFromHeaders(req), params.id!, patch)
      if (plan === null) return sendJson(res, 404, { success: false, error: 'budget plan not found' })
      sendJson(res, 200, plan)
    })
  }
}

function createBudgetGroupHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const body = await readJsonBody(req)
    const name = str(body.name)
    const budgetType = str(body.budget_type)
    if (!name || !budgetType) {
      return sendJson(res, 400, { success: false, error: 'name and budget_type (strings) are required' })
    }
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      sendJson(res, 200, await createBudgetGroup(sql, actorFromHeaders(req), params.budgetId!, { name, budget_type: budgetType }))
    })
  }
}

function updateBudgetGroupHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const body = await readJsonBody(req)
    const patch: { name?: string; budget_type?: string } = {}
    if (typeof body.name === 'string') patch.name = body.name
    if (typeof body.budget_type === 'string') patch.budget_type = body.budget_type
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      const group = await updateBudgetGroup(sql, actorFromHeaders(req), params.groupId!, patch)
      if (group === null) return sendJson(res, 404, { success: false, error: 'budget group not found' })
      sendJson(res, 200, group)
    })
  }
}

function deleteBudgetGroupHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      await deleteBudgetGroup(sql, actorFromHeaders(req), params.groupId!)
      sendJson(res, 200, { success: true })
    })
  }
}

function createBudgetItemHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const body = await readJsonBody(req)
    const titelName = str(body.titel_name)
    const value = Number(body.value)
    if (!titelName || !Number.isFinite(value)) {
      return sendJson(res, 400, { success: false, error: 'titel_name (string) and value (number) are required' })
    }
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      const item = await createBudgetItem(sql, actorFromHeaders(req), params.groupId!, {
        titel_nr: str(body.titel_nr) ?? '',
        titel_name: titelName,
        value,
      })
      if (item === null) return sendJson(res, 404, { success: false, error: 'budget group not found' })
      sendJson(res, 200, item)
    })
  }
}

function updateBudgetItemHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const body = await readJsonBody(req)
    const patch: { titel_nr?: string; titel_name?: string; value?: number } = {}
    if (typeof body.titel_nr === 'string') patch.titel_nr = body.titel_nr
    if (typeof body.titel_name === 'string') patch.titel_name = body.titel_name
    if (typeof body.value === 'number' && Number.isFinite(body.value)) patch.value = body.value
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      const item = await updateBudgetItem(sql, actorFromHeaders(req), params.itemId!, patch)
      if (item === null) return sendJson(res, 404, { success: false, error: 'budget item not found' })
      sendJson(res, 200, item)
    })
  }
}

function deleteBudgetItemHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      await deleteBudgetItem(sql, actorFromHeaders(req), params.itemId!)
      sendJson(res, 200, { success: true })
    })
  }
}

function activateBudgetHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      const plan = await activateBudget(sql, actorFromHeaders(req), params.id!)
      if (plan === null) return sendJson(res, 404, { success: false, error: 'budget plan not found' })
      sendJson(res, 200, plan)
    })
  }
}

function assignBudgetFiscalYearHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const body = await readJsonBody(req)
    const raw = body.fiscal_year_id
    const fiscalYearId = raw === null ? null : Number(raw)
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      const plan = await assignBudgetFiscalYear(sql, actorFromHeaders(req), params.budgetId!, fiscalYearId)
      if (plan === null) return sendJson(res, 404, { success: false, error: 'budget plan not found' })
      sendJson(res, 200, plan)
    })
  }
}

// ── LIVE year-end handler (#383 / FIN-52 — the WP-YearEnd Jahresabschluss) ────
// closeBudget: the 52nd/final op. The store composes + persists the statement jsonb,
// applies reserve deltas + retention markers, flips state→closed, and re-reads the
// persisted Statement (returned verbatim). Typed domain errors map via runStore
// (FinanceState→409 non-active plan, AccessDenied→403 out-of-scope); null → 404.

function closeBudgetHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      const statement = await closeBudget(sql, actorFromHeaders(req), params.id!)
      if (statement === null) return sendJson(res, 404, { success: false, error: 'budget plan not found' })
      sendJson(res, 200, statement)
    })
  }
}

// ── LIVE byte-export + CSV + FinTS handlers (#383 Lane E3) ────────────────────
// getBudgetStatementPdf / exportBudget / csvImport / configureFints / syncFints.
// The two byte exports reuse the Lane B statement visibility gate (scope-forwarded
// headers → getStatementProjection; null → 404 G-019) and answer RAW BYTES with an
// exact content-length — the ACL client's leafFetchRaw passes the Response straight
// through to the SvelteKit route. csvImport takes multipart/form-data (file +
// mapping + csv_order_reversed — the exact FormData the ACL client sends).
// configureFints / syncFints mirror the native dto-adapter: route-level Role.Finance
// is the primary access gate in BOTH modes (the native synthesises a wildcard system
// actor), so these are not row-scoped — parity with services/money/*.

function getBudgetStatementPdfHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const sql = await storeFn(tenant)
    const projection = await getStatementProjection(sql, params.id!, scopeFromHeaders(req))
    if (projection === null) return sendJson(res, 404, { success: false, error: 'budget plan not found' })
    const html = renderBudgetStatementHtml({
      plan: projection.plan,
      sections: groupLinesIntoSections(projection.lines),
    })
    // Native parity: the HTML body IS the contract, served as application/pdf
    // (no headless HTML→PDF pipeline exists on either side — see exports/pdf.ts).
    sendBytes(res, 200, {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="statement-${params.id}.pdf"`,
    }, Buffer.from(html, 'utf8'))
  }
}

/** Parse exportBudget's ?format (xlsx | ods) from the raw request URL. The ACL
 *  client always sends it; anything else → null (route 400). */
function exportFormat(req: http.IncomingMessage): 'xlsx' | 'ods' | null {
  const q = (req.url ?? '').split('?')[1]
  const raw = q ? new URLSearchParams(q).get('format') : null
  return raw === 'xlsx' || raw === 'ods' ? raw : null
}

function exportBudgetHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const format = exportFormat(req)
    if (format === null) {
      return sendJson(res, 400, { success: false, error: 'format query param must be xlsx or ods' })
    }
    const sql = await storeFn(tenant)
    const projection = await getStatementProjection(sql, params.id!, scopeFromHeaders(req))
    if (projection === null) return sendJson(res, 404, { success: false, error: 'budget plan not found' })
    const { body, contentType } = await buildBudgetExport(projection.lines, format)
    sendBytes(res, 200, {
      'content-type': contentType,
      'content-disposition': `attachment; filename="haushalt-${params.id}.${format}"`,
    }, body)
  }
}

function csvImportHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const boundary = parseBoundary(header(req, 'content-type'))
    if (boundary === null) {
      return sendJson(res, 400, { success: false, error: 'csv-import requires a multipart/form-data body' })
    }
    const parts = parseMultipart(await readRawBody(req), boundary)
    const file = parts.find((p) => p.name === 'file')
    if (!file) {
      return sendJson(res, 400, { success: false, error: 'multipart part "file" (the CSV) is required' })
    }
    // mapping arrives as a JSON-stringified Record<string, number|null> (the ACL
    // client's FormData); csv_order_reversed as 'true'/'false'.
    let mapping: CsvMapping
    try {
      const raw: unknown = JSON.parse(parts.find((p) => p.name === 'mapping')?.data.toString('utf8') ?? '{}')
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object')
      const m = raw as Record<string, unknown>
      const col = (k: string): number | null => (typeof m[k] === 'number' && Number.isFinite(m[k]) ? (m[k] as number) : null)
      mapping = {
        bookingDate: col('bookingDate'),
        valutaDate: col('valutaDate'),
        counterpartyName: col('counterpartyName'),
        counterpartyIban: col('counterpartyIban'),
        amountCents: col('amountCents'),
        saldoCents: col('saldoCents'),
        purpose: col('purpose'),
        bankReference: col('bankReference'),
      }
    } catch {
      return sendJson(res, 400, { success: false, error: 'multipart part "mapping" must be a JSON object' })
    }
    const csvOrderReversed = parts.find((p) => p.name === 'csv_order_reversed')?.data.toString('utf8') === 'true'
    try {
      const sql = await storeFn(tenant)
      // F1-FIX-05-K (K4#34): only an actor who may write a unit backed by this account.
      await assertBankAccountWritable(sql, actorFromHeaders(req), Number(params.id))
      const result = await importCsv(sql, Number(params.id), file.data.toString('utf8'), mapping, csvOrderReversed)
      sendJson(res, 200, result)
    } catch (err) {
      if (err instanceof CsvMappingError || err instanceof CsvParseError) {
        return sendJson(res, 400, { success: false, error: err.message })
      }
      if (err instanceof BankAccountNotFoundError) {
        return sendJson(res, 404, { success: false, error: err.message })
      }
      if (err instanceof AccessDeniedError) {
        return sendJson(res, 403, { success: false, error: err.message, code: 'ACCESS_DENIED' })
      }
      throw err
    }
  }
}

function configureFintsHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const body = await readJsonBody(req)
    const fintsUrl = str(body.fints_url)
    const bankCode = str(body.bank_code)
    const username = str(body.username)
    const password = str(body.password)
    if (!fintsUrl || !bankCode || !username || !password) {
      return sendJson(res, 400, {
        success: false,
        error: 'fints_url, bank_code, username, password (strings) are required',
      })
    }
    try {
      const sql = await storeFn(tenant)
      // F1-FIX-05-K (K4#34): only an actor who may write a unit backed by this account.
      await assertBankAccountWritable(sql, actorFromHeaders(req), Number(params.id))
      const config = await configureFints(sql, Number(params.id), {
        fints_url: fintsUrl,
        bank_code: bankCode,
        username,
        password,
      })
      sendJson(res, 200, config)
    } catch (err) {
      if (err instanceof FintsConfigValidationError) {
        return sendJson(res, 400, { success: false, error: err.message })
      }
      if (err instanceof AccessDeniedError) {
        return sendJson(res, 403, { success: false, error: err.message, code: 'ACCESS_DENIED' })
      }
      throw err // incl. a missing FINANCE_FINTS_PASSWORD_KEY → 500 (native parity)
    }
  }
}

function syncFintsHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    try {
      const sql = await storeFn(tenant)
      // F1-FIX-05-K (K4#34): only an actor who may write a unit backed by this account.
      await assertBankAccountWritable(sql, actorFromHeaders(req), Number(params.id))
      sendJson(res, 200, await syncFints(sql, Number(params.id)))
    } catch (err) {
      if (err instanceof FintsSyncNotFoundError) {
        return sendJson(res, 404, { success: false, error: err.message })
      }
      if (err instanceof AccessDeniedError) {
        return sendJson(res, 403, { success: false, error: err.message, code: 'ACCESS_DENIED' })
      }
      throw err
    }
  }
}

// ── LIVE receipt write handlers (#383 Lane E2 — R7) ──────────────────────────
// uploadReceipt / deleteReceipt / publishReceipt on finance.expense_attachment over
// the leaf storage backend (getStorage(): local-fs / Nextcloud-WebDAV). uploadReceipt
// takes the SAME multipart/form-data intake as csvImport (the `file` part → exact-size
// bytes + filename + content-type); delete/publish are no-body ops keyed on :attachmentId.
// The full WRITE actor (actorFromHeaders) drives the §11 org-unit write-scope gate.
// Typed domain errors map to the native attachments-route statuses via runReceipt:
//   ReceiptTooLargeError → 413, ReceiptMimeError → 415, ReceiptNotFoundError → 404,
//   ReceiptImmutableError → 409, AccessDeniedError → 403 (anything else → top-level 500).

/** Map the receipt-domain typed errors to their HTTP status (mirrors runStore's shape;
 *  distinct because the receipt ops add 413/415/409 statuses runStore does not carry). */
async function runReceipt(res: http.ServerResponse, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    if (
      err instanceof ReceiptTooLargeError ||
      err instanceof ReceiptMimeError ||
      err instanceof ReceiptNotFoundError ||
      err instanceof ReceiptImmutableError ||
      err instanceof InvalidReceiptFilenameError
    ) {
      return sendJson(res, err.httpStatus, { success: false, error: err.message })
    }
    if (err instanceof AccessDeniedError) {
      return sendJson(res, 403, { success: false, error: err.message, code: 'ACCESS_DENIED' })
    }
    throw err
  }
}

function uploadReceiptHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const boundary = parseBoundary(header(req, 'content-type'))
    if (boundary === null) {
      return sendJson(res, 400, { success: false, error: 'uploadReceipt requires a multipart/form-data body' })
    }
    const parts = parseMultipart(await readRawBody(req), boundary)
    const file = parts.find((p) => p.name === 'file')
    if (!file || file.filename === undefined || file.filename.length === 0) {
      return sendJson(res, 400, { success: false, error: 'multipart part "file" (with a filename) is required' })
    }
    // The parser already COPIED exact-size bytes out of the (pooled) request buffer.
    const upload: ReceiptUpload = {
      filename: file.filename,
      mimeType: file.contentType ?? null,
      bytes: file.data,
    }
    await runReceipt(res, async () => {
      const sql = await storeFn(tenant)
      const receipt = await uploadReceipt(
        sql, actorFromHeaders(req), Number(params.id), upload, getStorage(), tenant.id,
      )
      sendJson(res, 200, receipt)
    })
  }
}

function deleteReceiptHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    await runReceipt(res, async () => {
      const sql = await storeFn(tenant)
      await deleteReceipt(sql, actorFromHeaders(req), Number(params.id), Number(params.attachmentId), getStorage())
      sendJson(res, 200, { success: true })
    })
  }
}

function publishReceiptHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    await runReceipt(res, async () => {
      const sql = await storeFn(tenant)
      const receipt = await publishReceipt(sql, actorFromHeaders(req), Number(params.id), Number(params.attachmentId))
      sendJson(res, 200, receipt)
    })
  }
}

// ── LIVE project + sub-org-read + sub_org_type handlers (#383 Lane E1) ────────
// createProject / listProjects / getProject / updateProjectState + listSubOrgs /
// getSubOrgSummary / listSubOrgTypes / createSubOrgType / deleteSubOrgType. The
// reads reconstruct the actor's read scope (scopeFromHeaders); the writes need the
// full WRITE actor (actorFromHeaders) for the §11 org-unit write-scope gate. All
// resolve LEAF-LOCAL against finance.org_unit_mirror + finance.sub_org_type (no
// kernel round-trip). id-addressed reads 404 (G-019) when the store fn yields null.

function createProjectHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant } = ctx as ApiContext
    const body = await readJsonBody(req)
    const name = str(body.name)
    if (!name) return sendJson(res, 400, { success: false, error: 'name (string) is required' })
    const dto: CreateProjectDto = {
      name,
      responsible: str(body.responsible),
      org: str(body.org),
      beschreibung: str(body.beschreibung),
      date_start: str(body.date_start),
      date_end: str(body.date_end),
    }
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      sendJson(res, 200, await createProject(sql, actorFromHeaders(req), dto))
    })
  }
}

function listProjectsHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant } = ctx as ApiContext
    const params: { state?: string; page?: number } = {}
    const q = (req.url ?? '').split('?')[1]
    if (q) {
      const p = new URLSearchParams(q)
      const state = str(p.get('state') ?? undefined)
      if (state !== undefined) params.state = state
      const pageRaw = p.get('page')
      if (pageRaw != null) {
        const n = Number(pageRaw)
        if (Number.isFinite(n)) params.page = n
      }
    }
    const sql = await storeFn(tenant)
    sendJson(res, 200, await listProjects(sql, scopeFromHeaders(req), params))
  }
}

function getProjectHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const sql = await storeFn(tenant)
    const project = await getProject(sql, scopeFromHeaders(req), params.id!)
    if (project === null) return sendJson(res, 404, { success: false, error: 'project not found' })
    sendJson(res, 200, project)
  }
}

function updateProjectStateHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const body = await readJsonBody(req)
    const state = str(body.state)
    if (!state) return sendJson(res, 400, { success: false, error: 'state (string) is required' })
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      const project = await updateProjectState(sql, actorFromHeaders(req), params.id!, state)
      if (project === null) return sendJson(res, 404, { success: false, error: 'project not found' })
      sendJson(res, 200, project)
    })
  }
}

function listSubOrgsHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant } = ctx as ApiContext
    const sql = await storeFn(tenant)
    sendJson(res, 200, await listSubOrgs(sql, scopeFromHeaders(req)))
  }
}

function getSubOrgSummaryHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const sql = await storeFn(tenant)
    const summary = await getSubOrgSummary(sql, scopeFromHeaders(req), params.id!)
    if (summary === null) return sendJson(res, 404, { success: false, error: 'sub-org not found' })
    sendJson(res, 200, summary)
  }
}

function listSubOrgTypesHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { res, tenant } = ctx as ApiContext
    const sql = await storeFn(tenant)
    sendJson(res, 200, await listSubOrgTypes(sql))
  }
}

function createSubOrgTypeHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant } = ctx as ApiContext
    const body = await readJsonBody(req)
    const name = str(body.name)
    if (!name) return sendJson(res, 400, { success: false, error: 'name (string) is required' })
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      await assertCentralOrConfigAdmin(sql, actorFromHeaders(req))
      sendJson(res, 200, await createSubOrgType(sql, { name, description: str(body.description) ?? null }))
    })
  }
}

function deleteSubOrgTypeHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      await assertCentralOrConfigAdmin(sql, actorFromHeaders(req))
      await deleteSubOrgType(sql, params.id!)
      sendJson(res, 200, { success: true })
    })
  }
}

/** F1-FIX-05-K r2 (K4#34 remainder): tenant-wide finance configuration -- fiscal
 *  years and sub-org types -- needs the central/admin scope, as the ledger fix asks:
 *  the admin / it-admin config groups (the updateSignerConfig gate below), else the
 *  central finance_unit's org unit (auditor refused, runtime superuser passes). These
 *  handlers used to run with no actor at all. Throws AccessDeniedError -> 403. */
async function assertCentralOrConfigAdmin(sql: Sql, actor: ActorContext): Promise<void> {
  if (isFinanceConfigAdmin(actor.groups)) return
  await assertCentralScopeWritable(sql, actor)
}

// ── LIVE finanzordnung config handlers (TASK-009 lane C / R23-6) ─────────────
// getFinanzordnungProfile / getSignerConfig: plain leaf-local singleton reads (no
// scope/org-unit dimension — the internal shared secret + tenant headers already
// gate every leaf call). updateSignerConfig is admin/it-admin-gated: the ACL
// forwards x-finance-groups-json (buildHeaders, always present when the ACL client is
// constructed with an actor), and the leaf RE-CHECKS membership here as
// defense-in-depth, mirroring the native +page.server.ts gateWrite check — the
// internal shared secret alone does not carry the caller's Keycloak roles.

/** True if the actor's forwarded Keycloak groups include admin or it-admin —
 *  the same gate routes/finance/finanzordnung/+page.server.ts#canEdit enforces
 *  natively. */
function isFinanceConfigAdmin(groups: readonly string[]): boolean {
  return groups.includes('admin') || groups.includes('it-admin')
}

/** Fix round 1 (review r1-finance-C1C2, LOW): the handler previously checked
 *  only `Array.isArray(body.signerStages)` / `Array.isArray(body.decisionAuthorityTiers)`
 *  — an array of anything (missing/wrong-typed fields, e.g. a stage with no
 *  `required_group`) passed straight through to the UPDATE. Any caller
 *  holding the internal shared secret (defense-in-depth only — the ACTUAL
 *  gate is the admin/it-admin re-check above) could otherwise write a
 *  malformed Vier-Augen config that createApproval later reads. Validate
 *  each entry's SHAPE before the write. */
function isValidSignerStage(v: unknown): v is SignerStageDef {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  return (
    typeof s.role === 'string' &&
    s.role.length > 0 &&
    typeof s.required_group === 'string' &&
    s.required_group.length > 0 &&
    Array.isArray(s.certifies) &&
    s.certifies.every((c) => typeof c === 'string')
  )
}

function isValidTier(v: unknown): v is Tier {
  if (typeof v !== 'object' || v === null) return false
  const t = v as Record<string, unknown>
  return (
    (t.max_amount_cents === null ||
      (typeof t.max_amount_cents === 'number' && Number.isFinite(t.max_amount_cents))) &&
    typeof t.required_group === 'string' &&
    t.required_group.length > 0
  )
}

function getFinanzordnungProfileHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { res, tenant } = ctx as ApiContext
    const sql = await storeFn(tenant)
    sendJson(res, 200, await getFinanzordnungProfile(sql))
  }
}

function getSignerConfigHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { res, tenant } = ctx as ApiContext
    const sql = await storeFn(tenant)
    sendJson(res, 200, await getSignerConfig(sql))
  }
}

function updateSignerConfigHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant } = ctx as ApiContext
    const actor = actorFromHeaders(req)
    if (!isFinanceConfigAdmin(actor.groups)) {
      return sendJson(res, 403, {
        success: false,
        error: 'the finanzordnung signer config may only be changed by admin/it-admin',
        code: 'ACCESS_DENIED',
      })
    }
    const body = await readJsonBody(req)
    const signerStages =
      Array.isArray(body.signerStages) && body.signerStages.every(isValidSignerStage)
        ? (body.signerStages as SignerStageDef[])
        : undefined
    const decisionAuthorityTiers =
      Array.isArray(body.decisionAuthorityTiers) && body.decisionAuthorityTiers.every(isValidTier)
        ? (body.decisionAuthorityTiers as Tier[])
        : undefined
    if (!signerStages || !decisionAuthorityTiers) {
      return sendJson(res, 400, {
        success: false,
        error:
          'signerStages must be an array of {role, required_group, certifies[]} and ' +
          'decisionAuthorityTiers must be an array of {max_amount_cents, required_group}',
      })
    }
    const sql = await storeFn(tenant)
    const updated = await updateSignerConfig(sql, { signerStages, decisionAuthorityTiers })
    if (!updated) {
      return sendJson(res, 409, { success: false, error: 'no active finanzordnung profile', code: 'NO_ACTIVE_PROFILE' })
    }
    sendJson(res, 200, updated)
  }
}

// ── LIVE money handlers (TASK-009 lane C / R23-7) ─────────────────────────────
// recordManualPayout / recordCashPayout / allocateSplit / reconcileCashBox /
// suggestPaymentOrderMatches / exportSepa — the six BankServiceImpl routes ported
// onto the leaf. Writes reconstruct the full WRITE actor (actorFromHeaders) for
// the §11 org-unit write-scope gate; suggestPaymentOrderMatches needs only the
// read scope. Typed domain errors map via runStore (FinanceStateError→409,
// FinanceUnprocessableError→422, AccessDeniedError→403); a bad/missing body field
// is a 400 before the store is ever called (mirrors the ACL client route's zod
// pre-validation).

// R2-C3 LOW: defense in depth beyond the old Number.isFinite-only checks. The
// leaf is already behind the x-internal-auth guard and the gremion-ui zod
// schemas validate first, but a bad value reaching these handlers directly
// (or a future caller that skips the UI layer) should get a 400 here instead
// of a DB error (500, e.g. a CHECK/domain violation) or a silently odd result
// (e.g. a fractional or negative amountCents, or a negative topN reaching
// Array#slice — see topNParam below).
function isPosIntId(x: number): boolean {
  return Number.isSafeInteger(x) && x > 0
}
function isPosCents(x: number): boolean {
  return Number.isSafeInteger(x) && x > 0
}
/** TASK-009 verifier item 4: a split part may be NEGATIVE — a debit
 *  (outgoing) bank_transaction splits into negative parts, exactly as the
 *  in-process ACL zod always allowed. Zero is never a valid part; the store
 *  checks each part's sign against the locked transaction. */
function isNonZeroCents(x: number): boolean {
  return Number.isSafeInteger(x) && x !== 0
}
function isNonNegCents(x: number): boolean {
  return Number.isSafeInteger(x) && x >= 0
}

function recordManualPayoutHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const body = await readJsonBody(req)
    const paymentOrderId = Number(params.id)
    const ledgerAccountId = Number(body.ledgerAccountId)
    const budgetTitelId = Number(body.budgetTitelId)
    const fiscalYearId = Number(body.fiscalYearId)
    const amountCents = Number(body.amountCents)
    const paidAt = str(body.paidAt)
    const reference = str(body.reference)
    if (
      !isPosIntId(paymentOrderId) || !isPosIntId(ledgerAccountId) ||
      !isPosIntId(budgetTitelId) || !isPosIntId(fiscalYearId) ||
      !isPosCents(amountCents) || !paidAt || !reference
    ) {
      return sendJson(res, 400, {
        success: false,
        error: 'ledgerAccountId, budgetTitelId, fiscalYearId (positive integers), amountCents (positive integer cents) and paidAt, reference (strings) are required',
      })
    }
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      const result = await recordManualPayout(sql, actorFromHeaders(req), {
        paymentOrderId, ledgerAccountId, budgetTitelId, fiscalYearId, amountCents, paidAt, reference,
      })
      sendJson(res, 200, result)
    })
  }
}

function recordCashPayoutHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const body = await readJsonBody(req)
    const paymentOrderId = Number(params.id)
    const cashBoxLedgerId = Number(body.cashBoxLedgerId)
    const budgetTitelId = Number(body.budgetTitelId)
    const fiscalYearId = Number(body.fiscalYearId)
    const amountCents = Number(body.amountCents)
    const paidAt = str(body.paidAt)
    if (
      !isPosIntId(paymentOrderId) || !isPosIntId(cashBoxLedgerId) ||
      !isPosIntId(budgetTitelId) || !isPosIntId(fiscalYearId) ||
      !isPosCents(amountCents) || !paidAt
    ) {
      return sendJson(res, 400, {
        success: false,
        error: 'cashBoxLedgerId, budgetTitelId, fiscalYearId (positive integers), amountCents (positive integer cents) and paidAt (string) are required',
      })
    }
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      const result = await recordCashPayout(sql, actorFromHeaders(req), {
        paymentOrderId, cashBoxLedgerId, budgetTitelId, fiscalYearId, amountCents, paidAt,
      })
      sendJson(res, 200, result)
    })
  }
}

/** Parse ?topN from the raw request URL (suggest-matches — the server strips the
 *  query only for route MATCHING; req.url still carries it). */
function topNParam(req: http.IncomingMessage): number | undefined {
  const q = (req.url ?? '').split('?')[1]
  if (!q) return undefined
  const raw = new URLSearchParams(q).get('topN')
  if (raw == null) return undefined
  const n = Number(raw)
  // R2-C3 LOW: a non-positive-integer topN (e.g. negative) would otherwise
  // reach `scored.slice(0, topN)`, whose negative-end-index semantics give a
  // silently odd (not obviously wrong) result rather than a crash. Falling
  // back to the default (applied by suggestPaymentOrderMatches) is the
  // graceful choice for an optional read-only query param.
  return isPosIntId(n) ? n : undefined
}

function suggestPaymentOrderMatchesHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const bankTransactionId = Number(params.id)
    if (!isPosIntId(bankTransactionId)) {
      return sendJson(res, 400, { success: false, error: 'bad bank_transaction id' })
    }
    // R2-C3 LOW: wrapped in runStore like the other five money handlers, so any
    // future typed domain error this function might throw gets the same status
    // mapping instead of falling through to the generic top-level 500.
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      const candidates = await suggestPaymentOrderMatches(sql, scopeFromHeaders(req), {
        bankTransactionId, topN: topNParam(req),
      })
      sendJson(res, 200, candidates)
    })
  }
}

function allocateSplitHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const bankTransactionId = Number(params.id)
    const body = await readJsonBody(req)
    const rawParts = Array.isArray(body.parts) ? (body.parts as Record<string, unknown>[]) : undefined
    if (!isPosIntId(bankTransactionId) || !rawParts) {
      return sendJson(res, 400, { success: false, error: 'bad bank_transaction id or missing parts (array)' })
    }
    const parts: SplitPartDto[] = []
    for (const raw of rawParts) {
      const ledgerAccountId = Number(raw.ledgerAccountId)
      const budgetTitelId = Number(raw.budgetTitelId)
      const fiscalYearId = Number(raw.fiscalYearId)
      const amountCents = Number(raw.amountCents)
      if (
        !isPosIntId(ledgerAccountId) || !isPosIntId(budgetTitelId) ||
        !isPosIntId(fiscalYearId) || !isNonZeroCents(amountCents)
      ) {
        return sendJson(res, 400, {
          success: false,
          error: 'each part requires ledgerAccountId, budgetTitelId, fiscalYearId (positive integers), amountCents (non-zero integer cents; negative for a debit transaction)',
        })
      }
      parts.push({ ledgerAccountId, budgetTitelId, fiscalYearId, amountCents })
    }
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      const bookings = await allocateSplit(sql, actorFromHeaders(req), { bankTransactionId, parts })
      sendJson(res, 200, bookings)
    })
  }
}

function exportSepaHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant } = ctx as ApiContext
    const body = await readJsonBody(req)
    const paymentOrderIds = Array.isArray(body.paymentOrderIds)
      ? (body.paymentOrderIds as unknown[]).map(Number)
      : undefined
    const initiatingPartyName = str(body.initiatingPartyName)
    const debtorName = str(body.debtorName)
    const debtorIban = str(body.debtorIban)
    const debtorBic = str(body.debtorBic) ?? null
    const requestedExecutionDate = str(body.requestedExecutionDate)
    if (
      !paymentOrderIds || paymentOrderIds.length === 0 || paymentOrderIds.some((n) => !isPosIntId(n)) ||
      !initiatingPartyName || !debtorName || !debtorIban || !requestedExecutionDate
    ) {
      return sendJson(res, 400, {
        success: false,
        error:
          'paymentOrderIds (non-empty array of positive integers), initiatingPartyName, debtorName, debtorIban, requestedExecutionDate (strings) are required',
      })
    }
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      const result = await exportSepa(sql, actorFromHeaders(req), {
        paymentOrderIds, initiatingPartyName, debtorName, debtorIban, debtorBic, requestedExecutionDate,
      })
      sendJson(res, 200, result)
    })
  }
}

function reconcileCashBoxHandler(storeFn: StoreFn): RouteHandler {
  return async (ctx: RouteContext): Promise<void> => {
    const { req, res, tenant, params } = ctx as ApiContext
    const cashBoxLedgerId = Number(params.ledgerId)
    const body = await readJsonBody(req)
    const countedCents = Number(body.countedCents)
    const countedAt = str(body.countedAt)
    // countedCents may legitimately be 0 (an empty cash box) — non-negative,
    // not strictly positive, unlike the payout/booking amounts above.
    if (!isPosIntId(cashBoxLedgerId) || !isNonNegCents(countedCents) || !countedAt) {
      return sendJson(res, 400, {
        success: false,
        error: 'countedCents (non-negative integer) and countedAt (string) are required',
      })
    }
    await runStore(res, async () => {
      const sql = await storeFn(tenant)
      const report = await reconcileCashBox(sql, actorFromHeaders(req), { cashBoxLedgerId, countedCents, countedAt })
      sendJson(res, 200, report)
    })
  }
}

/** Resolve the LIVE handler for an unlocked op (or undefined for a 501-locked op). */
function liveHandlerFor(op: string, storeFn: StoreFn): RouteHandler | undefined {
  switch (op) {
    case 'createSubOrg':
      return createSubOrgHandler(storeFn)
    case 'updateSubOrg':
      return updateSubOrgHandler(storeFn)
    case 'deleteSubOrg':
      return deleteSubOrgHandler(storeFn)
    case 'checkOrgUnitFinanceRefs':
      return financeRefsHandler(storeFn)
    case 'listFiscalYears':
      return listFiscalYearsHandler(storeFn)
    case 'createFiscalYear':
      return createFiscalYearHandler(storeFn)
    case 'updateFiscalYear':
      return updateFiscalYearHandler(storeFn)
    case 'listBankAccounts':
      return listBankAccountsHandler(storeFn)
    case 'getFintsStatus':
      return getFintsStatusHandler(storeFn)
    case 'listReceipts':
      return listReceiptsHandler(storeFn)
    case 'listExpenses':
      return listExpensesHandler(storeFn)
    case 'getExpense':
      return getExpenseHandler(storeFn)
    case 'getBudget':
      return getBudgetHandler(storeFn)
    case 'getBudgetPlan':
      return getBudgetPlanHandler(storeFn)
    case 'getBudgetStatement':
      return getBudgetStatementHandler(storeFn)
    case 'listBookings':
      return listBookingsHandler(storeFn)
    // #383 Lane C — Vier-Augen approval family + createExpense.
    case 'createExpense':
      return createExpenseHandler(storeFn)
    case 'listPendingApprovals':
      return listPendingApprovalsHandler(storeFn)
    case 'requestProjectApproval':
      return openApprovalHandler(storeFn, async (_req, _sql, params) => ({
        approvableType: 'project',
        approvableId: Number(params.id),
      }))
    case 'requestExpenseApproval':
      return openApprovalHandler(storeFn, async (_req, _sql, params) => ({
        approvableType: 'expense',
        approvableId: Number(params.id),
      }))
    case 'requestBudgetApproval':
      return openApprovalHandler(storeFn, async (_req, sql, params) => ({
        approvableType: 'budget_plan',
        approvableId: Number(params.id),
        method: (await heliosBudgetApprovalEnabled(sql)) ? 'helios' : 'manual',
      }))
    case 'createApproval':
      return openApprovalHandler(storeFn, async (req) => {
        const body = await readJsonBody(req)
        return {
          approvableType: (str(body.approvable_type) ?? 'expense') as ApprovableType,
          approvableId: Number(body.approvable_id),
        }
      })
    case 'signApproval':
      return signApprovalHandler(storeFn)
    case 'rejectApproval':
      return rejectApprovalHandler(storeFn)
    // #383 Lane D — budget CRUD + lifecycle write domain.
    case 'createBudgetPlan':
      return createBudgetPlanHandler(storeFn)
    case 'updateBudgetPlan':
      return updateBudgetPlanHandler(storeFn)
    case 'createBudgetGroup':
      return createBudgetGroupHandler(storeFn)
    case 'updateBudgetGroup':
      return updateBudgetGroupHandler(storeFn)
    case 'deleteBudgetGroup':
      return deleteBudgetGroupHandler(storeFn)
    case 'createBudgetItem':
      return createBudgetItemHandler(storeFn)
    case 'updateBudgetItem':
      return updateBudgetItemHandler(storeFn)
    case 'deleteBudgetItem':
      return deleteBudgetItemHandler(storeFn)
    case 'activateBudget':
      return activateBudgetHandler(storeFn)
    case 'assignBudgetFiscalYear':
      return assignBudgetFiscalYearHandler(storeFn)
    // #383 / FIN-52 — year-end close (the last kernel-coupling residual, ported leaf-local).
    case 'closeBudget':
      return closeBudgetHandler(storeFn)
    // #383 Lane E1 — project (R1) + sub-org-read / sub_org_type (R2).
    case 'createProject':
      return createProjectHandler(storeFn)
    case 'listProjects':
      return listProjectsHandler(storeFn)
    case 'getProject':
      return getProjectHandler(storeFn)
    case 'updateProjectState':
      return updateProjectStateHandler(storeFn)
    case 'listSubOrgs':
      return listSubOrgsHandler(storeFn)
    case 'getSubOrgSummary':
      return getSubOrgSummaryHandler(storeFn)
    case 'listSubOrgTypes':
      return listSubOrgTypesHandler(storeFn)
    case 'createSubOrgType':
      return createSubOrgTypeHandler(storeFn)
    case 'deleteSubOrgType':
      return deleteSubOrgTypeHandler(storeFn)
    // #383 Lane E3 — byte exports + CSV import + FinTS.
    case 'getBudgetStatementPdf':
      return getBudgetStatementPdfHandler(storeFn)
    case 'exportBudget':
      return exportBudgetHandler(storeFn)
    case 'csvImport':
      return csvImportHandler(storeFn)
    case 'configureFints':
      return configureFintsHandler(storeFn)
    case 'syncFints':
      return syncFintsHandler(storeFn)
    // #383 Lane E2 — the receipts trio (R7).
    case 'uploadReceipt':
      return uploadReceiptHandler(storeFn)
    case 'deleteReceipt':
      return deleteReceiptHandler(storeFn)
    case 'publishReceipt':
      return publishReceiptHandler(storeFn)
    // TASK-009 lane C / R23-6 — the finanzordnung config trio.
    case 'getFinanzordnungProfile':
      return getFinanzordnungProfileHandler(storeFn)
    case 'getSignerConfig':
      return getSignerConfigHandler(storeFn)
    case 'updateSignerConfig':
      return updateSignerConfigHandler(storeFn)
    // TASK-009 lane C / R23-7 — the six BankServiceImpl money ops.
    case 'recordManualPayout':
      return recordManualPayoutHandler(storeFn)
    case 'recordCashPayout':
      return recordCashPayoutHandler(storeFn)
    case 'suggestPaymentOrderMatches':
      return suggestPaymentOrderMatchesHandler(storeFn)
    case 'allocateSplit':
      return allocateSplitHandler(storeFn)
    case 'exportSepa':
      return exportSepaHandler(storeFn)
    case 'reconcileCashBox':
      return reconcileCashBoxHandler(storeFn)
    default:
      return undefined
  }
}

/**
 * Build all /api/v1/* routes. The LIVE_OPS (slice-3 sub-org saga + fiscal_year +
 * the R10 scope-sensitive reads + the Lane B budget/statement/booking reads) are
 * store-backed when a storeFn is supplied; every
 * other op — and all ops when no storeFn is given — resolves to 501 (surface lock).
 * The internal GET /api/v1/sub-orgs/:id resolve route the saga uses is added when
 * store-backed.
 */
export function buildApiRoutes(storeFn?: StoreFn): Route[] {
  const routes: Route[] = FINANCE_ROUTE_SPECS.map((spec) => ({
    method: spec.method,
    path: spec.path,
    handler:
      storeFn && LIVE_OPS.has(spec.op)
        ? (liveHandlerFor(spec.op, storeFn) ?? lockedHandler(spec.op))
        : lockedHandler(spec.op),
  }))
  if (storeFn) {
    // Internal saga-resolve route (finance_unit.id → org_unit_id) — NOT a
    // FinanceBackend method, so it is not in FINANCE_ROUTE_SPECS.
    routes.push({ method: 'GET', path: '/api/v1/sub-orgs/:id', handler: resolveSubOrgHandler(storeFn) })
  }
  return routes
}

// ── /healthz/tenants handler ──────────────────────────────────────────────────
// Served from the /healthz* path in server.ts, which requires the internal secret
// for this sub-path (F1-FIX-05-K, K4#32). An operator confirms the leaf's own PG is
// reachable and migrated for every tenant. The response carries booleans ONLY: no
// tenant ids or slugs, no finance counts, no DB error text (those went to any
// unauthenticated caller before). The per-tenant detail is logged server-side.

export async function tenantHealthHandler(
  res: http.ServerResponse,
  listTenants: TenantLister,
  storeFn: StoreFn,
): Promise<void> {
  let tenants: TenantRef[]
  try {
    tenants = await listTenants()
  } catch (err) {
    console.error('[finance] /healthz/tenants: tenant listing failed', err)
    sendJson(res, 503, { success: false, db_ok: false })
    return
  }

  const results = await Promise.all(
    tenants.map(async (t): Promise<boolean> => {
      try {
        const sql = await storeFn(t)
        await sql`SELECT 1`
        return true
      } catch (err) {
        console.error(`[finance] /healthz/tenants: tenant ${t.id} (${t.slug}) DB probe failed`, err)
        return false
      }
    }),
  )

  const allOk = results.every((ok) => ok)
  sendJson(res, allOk ? 200 : 503, { success: allOk, db_ok: allOk })
}
