/**
 * Integration tests for the R23-7 money domain store functions — the REAL
 * Postgres round-trip that test/bank-money.store.test.ts's fakeSql-queue unit
 * suite deliberately does NOT cover (see that file's header). A fake that
 * ignores SQL text and parameters entirely cannot catch a typo'd column name,
 * a wrong filter, a missing FOR UPDATE, or a real constraint violation — see
 * R2-C3 finding "the money store tests replay canned results in call order".
 *
 * Covers each of the six money-moving functions with a happy path, a scope
 * refusal, and one invalid-input/illegal-state case, all against a fresh
 * ephemeral Postgres database with 001-004 actually applied.
 *
 * Fail-closed guard (same as backfill.integration.test.ts /
 * org-unit-mirror.integration.test.ts): FINANCE_TEST_PG_URL on a NON-5432 port
 * + the finance_test_ db prefix. This suite CREATEs/DROPs databases.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import {
  storeFor, _resetTenantStoreForTests, type TenantRef, type Sql,
} from '../src/tenant-store.ts'
import {
  recordManualPayout, recordCashPayout, allocateSplit, reconcileCashBox,
  suggestPaymentOrderMatches, exportSepa,
  FinanceStateError, FinanceUnprocessableError, AccessDeniedError,
  type ActorContext, type ScopeContext,
} from '../src/store/index.ts'

const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'finance_test_'

function requireEphemeralTestPgUrl(): string {
  const url = process.env.FINANCE_TEST_PG_URL
  if (!url) {
    throw new Error(
      '[fin-test-guard] FINANCE_TEST_PG_URL is REQUIRED — refusing to default to localhost:5432 ' +
        '(the LIVE staging Postgres). Start an ephemeral throwaway container on a NON-5432 port, e.g.:\n' +
        '  docker run -d --name t009fin-testpg-1 -p 127.0.0.1:55491:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine\n' +
        '  export FINANCE_TEST_PG_URL=postgres://postgres@localhost:55491/postgres',
    )
  }
  return url
}

function assertSafeTestEnv(url: string, dbPrefix: string): void {
  const parsed = new URL(url)
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`[fin-test-guard] must use postgres:// scheme. Got: ${parsed.protocol}`)
  }
  const rawHost = parsed.hostname.toLowerCase()
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost
  if (!new Set(['localhost', '127.0.0.1', '::1']).has(host)) {
    throw new Error(`[fin-test-guard] SAFETY VIOLATION: non-localhost host "${host}" — refusing.`)
  }
  if (parsed.port === '' || parsed.port === '5432') {
    throw new Error(`[fin-test-guard] SAFETY VIOLATION: port "${parsed.port || '(implicit 5432)'}" is live — refusing.`)
  }
  if (!dbPrefix.startsWith('finance_test_')) {
    throw new Error(`[fin-test-guard] SAFETY VIOLATION: dbPrefix "${dbPrefix}" — refusing.`)
  }
}
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

const TENANT: TenantRef = { id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', slug: 'money' }
const ORG_A = '11111111-1111-1111-1111-111111111111'
const ORG_B = '22222222-2222-2222-2222-222222222222'

const ACTOR_A: ActorContext = {
  userId: 'treasurer-a', isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [ORG_A], groups: [],
}
const ACTOR_B: ActorContext = {
  userId: 'treasurer-b', isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [ORG_B], groups: [],
}

let admin: ReturnType<typeof postgres>

async function dropTestDbs(): Promise<void> {
  const rows = await admin<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname LIKE 'finance_test_%'`
  for (const { datname } of rows) {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${datname}' AND pid <> pg_backend_pid()`,
    )
    await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}"`)
  }
}

async function fresh(): Promise<Sql> {
  await _resetTenantStoreForTests()
  await dropTestDbs()
  return storeFor(TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
}

beforeAll(async () => {
  admin = postgres(TEST_PG_URL, { max: 1, prepare: false })
})
afterAll(async () => {
  await _resetTenantStoreForTests()
  await dropTestDbs()
  await admin.end()
})

interface Fixture {
  financeUnitA: number
  financeUnitB: number
  fiscalYearId: number
  titelId: number
  bankAccountA: number
  ledgerOwnA: number
  ledgerCashA: number
  ledgerOwnB: number
  expenseA: number
  paymentOrderId: number
  bankTransactionId: number
}

/** Seeds one fully-wired money fixture: two finance units (A/B, on ORG_A/ORG_B),
 *  a fiscal year, a budget chain (plan->section->group->titel) rooted at unit A,
 *  a bank account backing unit A's own_account ledger (plus a cash_box ledger
 *  for unit A and a SEPARATE own_account ledger for unit B on its OWN bank
 *  account), an authorised payment_order on an expense in unit A with a
 *  receipt covering the full amount, and a bank_transaction on unit A's bank
 *  account for the split-allocation tests. */
async function seed(sql: Sql): Promise<Fixture> {
  const fu = await sql<{ id: string }[]>`
    INSERT INTO finance.finance_unit (org_unit_id, kind, bookkeeping_mode, carry_over_rule)
    VALUES (${ORG_A}, 'standard', 'own', 'carry_forward'), (${ORG_B}, 'standard', 'own', 'carry_forward')
    RETURNING id`
  const financeUnitA = Number(fu[0]!.id)
  const financeUnitB = Number(fu[1]!.id)

  const fy = await sql<{ id: string }[]>`
    INSERT INTO finance.fiscal_year (name, start_date, end_date)
    VALUES ('FY2026', '2026-01-01', '2026-12-31') RETURNING id`
  const fiscalYearId = Number(fy[0]!.id)

  const plan = await sql<{ id: string }[]>`
    INSERT INTO finance.budget_plan (fiscal_year_id, name, state)
    VALUES (${fiscalYearId}, 'P', 'active') RETURNING id`
  const section = await sql<{ id: string }[]>`
    INSERT INTO finance.budget_section (budget_plan_id, finance_unit_id, preparation_state)
    VALUES (${Number(plan[0]!.id)}, ${financeUnitA}, 'submitted_to_central') RETURNING id`
  const group = await sql<{ id: string }[]>`
    INSERT INTO finance.budget_group (budget_section_id, name, budget_type)
    VALUES (${Number(section[0]!.id)}, 'G', 'expense') RETURNING id`
  const titel = await sql<{ id: string }[]>`
    INSERT INTO finance.budget_titel (budget_group_id, titel_nr, titel_name, planned_cents, deckungsfaehig)
    VALUES (${Number(group[0]!.id)}, '001', 'T', 1000000, false) RETURNING id`
  const titelId = Number(titel[0]!.id)

  const bankA = await sql<{ id: string }[]>`
    INSERT INTO finance.bank_account (name, iban) VALUES ('Sparkasse A', 'DE89370400440532013000') RETURNING id`
  const bankAccountA = Number(bankA[0]!.id)
  const bankB = await sql<{ id: string }[]>`
    INSERT INTO finance.bank_account (name, iban) VALUES ('Sparkasse B', 'DE02120300000000202051') RETURNING id`
  const bankAccountB = Number(bankB[0]!.id)

  const ledgers = await sql<{ id: string }[]>`
    INSERT INTO finance.ledger_account (finance_unit_id, bank_account_id, type, name) VALUES
      (${financeUnitA}, ${bankAccountA}, 'own_account', 'A Main'),
      (${financeUnitA}, NULL, 'cash_box', 'A Handkasse'),
      (${financeUnitB}, ${bankAccountB}, 'own_account', 'B Main')
    RETURNING id`
  const ledgerOwnA = Number(ledgers[0]!.id)
  const ledgerCashA = Number(ledgers[1]!.id)
  const ledgerOwnB = Number(ledgers[2]!.id)

  const exp = await sql<{ id: string }[]>`
    INSERT INTO finance.expense (finance_unit_id, payee_name, payee_iban, payee_purpose, payment_method, state)
    VALUES (${financeUnitA}, 'Druckerei Muster', 'DE89370400440532013000', 'Flyer', 'bank_transfer', 'approved')
    RETURNING id`
  const expenseA = Number(exp[0]!.id)

  const receipt = await sql<{ id: string }[]>`
    INSERT INTO finance.receipt (expense_id, beleg_nr, beleg_date)
    VALUES (${expenseA}, 'B-1', '2026-06-01') RETURNING id`
  await sql`
    INSERT INTO finance.receipt_item (receipt_id, budget_titel_id, amount_cents)
    VALUES (${Number(receipt[0]!.id)}, ${titelId}, 4500)`

  const po = await sql<{ id: string }[]>`
    INSERT INTO finance.payment_order
      (expense_id, anordnung_by, feststellung_sachlich_by, feststellung_rechnerisch_by, dual_signature_attested, state)
    VALUES (${expenseA}, 'u-anordnung', 'u-sachlich', 'u-rechnerisch', true, 'authorised')
    RETURNING id`
  const paymentOrderId = Number(po[0]!.id)

  const txn = await sql<{ id: string }[]>`
    INSERT INTO finance.bank_transaction
      (bank_account_id, booking_date, amount_cents, purpose, bank_reference, import_hash)
    VALUES (${bankAccountA}, '2026-06-10', 4500, 'Zahlung', 'REF-INT-1', 'hash-int-1')
    RETURNING id`
  const bankTransactionId = Number(txn[0]!.id)

  return {
    financeUnitA, financeUnitB, fiscalYearId, titelId, bankAccountA,
    ledgerOwnA, ledgerCashA, ledgerOwnB, expenseA, paymentOrderId, bankTransactionId,
  }
}

describe('R2-C3 money ops — real Postgres round-trip', () => {
  let sql: Sql
  let fx: Fixture
  beforeEach(async () => {
    sql = await fresh()
    fx = await seed(sql)
  })

  describe('recordManualPayout', () => {
    it('happy path: posts a real booking row and settles the PO', async () => {
      const result = await recordManualPayout(sql, ACTOR_A, {
        paymentOrderId: fx.paymentOrderId, ledgerAccountId: fx.ledgerOwnA,
        budgetTitelId: fx.titelId, fiscalYearId: fx.fiscalYearId,
        amountCents: 4500, paidAt: '2026-06-15', reference: 'ref',
      })
      expect(result.paymentOrder.state).toBe('settled')
      expect(result.booking.state).toBe('posted')
      const rows = await sql<{ state: string; running_no: string }[]>`
        SELECT state, running_no FROM finance.booking WHERE id = ${result.booking.id}`
      expect(rows[0]).toMatchObject({ state: 'posted', running_no: '1' })
      const poRows = await sql<{ state: string }[]>`
        SELECT state FROM finance.payment_order WHERE id = ${fx.paymentOrderId}`
      expect(poRows[0]!.state).toBe('settled')
    })

    it('scope refusal: the PO\'s own expense unit is out of the actor\'s scope (real 403 path)', async () => {
      await expect(
        recordManualPayout(sql, ACTOR_B, {
          paymentOrderId: fx.paymentOrderId, ledgerAccountId: fx.ledgerOwnA,
          budgetTitelId: fx.titelId, fiscalYearId: fx.fiscalYearId,
          amountCents: 4500, paidAt: '2026-06-15', reference: 'ref',
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError)
      const poRows = await sql<{ state: string }[]>`
        SELECT state FROM finance.payment_order WHERE id = ${fx.paymentOrderId}`
      expect(poRows[0]!.state).toBe('authorised') // untouched — the whole tx rolled back
    })

    it('invalid input: a non-authorised PO is refused (real state-machine check)', async () => {
      await sql`UPDATE finance.payment_order SET state = 'pending' WHERE id = ${fx.paymentOrderId}`
      await expect(
        recordManualPayout(sql, ACTOR_A, {
          paymentOrderId: fx.paymentOrderId, ledgerAccountId: fx.ledgerOwnA,
          budgetTitelId: fx.titelId, fiscalYearId: fx.fiscalYearId,
          amountCents: 4500, paidAt: '2026-06-15', reference: 'ref',
        }),
      ).rejects.toBeInstanceOf(FinanceStateError)
    })
  })

  describe('recordCashPayout', () => {
    it('happy path: posts against the real cash_box ledger', async () => {
      const result = await recordCashPayout(sql, ACTOR_A, {
        paymentOrderId: fx.paymentOrderId, cashBoxLedgerId: fx.ledgerCashA,
        budgetTitelId: fx.titelId, fiscalYearId: fx.fiscalYearId,
        amountCents: 4500, paidAt: '2026-06-15',
      })
      expect(result.paymentOrder.state).toBe('settled')
      expect(result.booking.payment_type).toBe('bar')
    })

    it('scope refusal: the target ledger belongs to a different unit than the actor\'s scope', async () => {
      await expect(
        recordCashPayout(sql, ACTOR_B, {
          paymentOrderId: fx.paymentOrderId, cashBoxLedgerId: fx.ledgerCashA,
          budgetTitelId: fx.titelId, fiscalYearId: fx.fiscalYearId,
          amountCents: 4500, paidAt: '2026-06-15',
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError)
    })

    it('invalid input: a non-cash_box ledger is refused (real CHECK-shaped state check)', async () => {
      await expect(
        recordCashPayout(sql, ACTOR_A, {
          paymentOrderId: fx.paymentOrderId, cashBoxLedgerId: fx.ledgerOwnA,
          budgetTitelId: fx.titelId, fiscalYearId: fx.fiscalYearId,
          amountCents: 4500, paidAt: '2026-06-15',
        }),
      ).rejects.toBeInstanceOf(FinanceStateError)
    })
  })

  describe('allocateSplit', () => {
    it('happy path: posts a real booking sharing the bank_transaction as Beleg', async () => {
      const bookings = await allocateSplit(sql, ACTOR_A, {
        bankTransactionId: fx.bankTransactionId,
        parts: [{ ledgerAccountId: fx.ledgerOwnA, budgetTitelId: fx.titelId, fiscalYearId: fx.fiscalYearId, amountCents: 4500 }],
      })
      expect(bookings).toHaveLength(1)
      expect(bookings[0]!.state).toBe('posted')
      expect(bookings[0]!.bank_transaction_id).toBe(fx.bankTransactionId)
    })

    it('scope refusal: no ledger backing this bank_transaction is in the actor\'s scope', async () => {
      await expect(
        allocateSplit(sql, ACTOR_B, {
          bankTransactionId: fx.bankTransactionId,
          parts: [{ ledgerAccountId: fx.ledgerOwnA, budgetTitelId: fx.titelId, fiscalYearId: fx.fiscalYearId, amountCents: 4500 }],
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError)
    })

    it('TASK-009 item 4: a DEBIT (outgoing) transaction splits into negative parts', async () => {
      await sql`UPDATE finance.bank_transaction SET amount_cents = -4500 WHERE id = ${fx.bankTransactionId}`
      const bookings = await allocateSplit(sql, ACTOR_A, {
        bankTransactionId: fx.bankTransactionId,
        parts: [{ ledgerAccountId: fx.ledgerOwnA, budgetTitelId: fx.titelId, fiscalYearId: fx.fiscalYearId, amountCents: -4500 }],
      })
      expect(bookings).toHaveLength(1)
      const rows = await sql<{ amount_cents: string; state: string }[]>`
        SELECT amount_cents, state FROM finance.booking WHERE id = ${bookings[0]!.id}`
      expect(rows[0]).toMatchObject({ amount_cents: '-4500', state: 'posted' })
    })

    it('invalid input: parts summing to less than the real locked amount are refused (real amount, not a canned one)', async () => {
      await expect(
        allocateSplit(sql, ACTOR_A, {
          bankTransactionId: fx.bankTransactionId,
          parts: [{ ledgerAccountId: fx.ledgerOwnA, budgetTitelId: fx.titelId, fiscalYearId: fx.fiscalYearId, amountCents: 1 }],
        }),
      ).rejects.toBeInstanceOf(FinanceUnprocessableError)
    })
  })

  describe('reconcileCashBox', () => {
    it('happy path: IN_BALANCE against the real posted-booking sum (0, nothing posted yet)', async () => {
      const report = await reconcileCashBox(sql, ACTOR_A, {
        cashBoxLedgerId: fx.ledgerCashA, countedCents: 0, countedAt: '2026-06-15T12:00:00Z',
      })
      expect(report.status).toBe('IN_BALANCE')
    })

    it('scope refusal: the cash box belongs to a different unit than the actor\'s scope', async () => {
      await expect(
        reconcileCashBox(sql, ACTOR_B, {
          cashBoxLedgerId: fx.ledgerCashA, countedCents: 0, countedAt: '2026-06-15T12:00:00Z',
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError)
    })

    it('invalid input: a non-cash_box ledger is refused', async () => {
      await expect(
        reconcileCashBox(sql, ACTOR_A, {
          cashBoxLedgerId: fx.ledgerOwnA, countedCents: 0, countedAt: '2026-06-15T12:00:00Z',
        }),
      ).rejects.toBeInstanceOf(FinanceStateError)
    })
  })

  describe('suggestPaymentOrderMatches', () => {
    const scopeA: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [ORG_A] }
    const scopeB: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [ORG_B] }

    it('happy path: scores the real seeded PO/expense against the real bank_transaction', async () => {
      const result = await suggestPaymentOrderMatches(sql, scopeA, { bankTransactionId: fx.bankTransactionId })
      expect(result).toHaveLength(1)
      expect(result[0]!.paymentOrderId).toBe(fx.paymentOrderId)
      expect(result[0]!.reasons).toContain('amount_eq')
    })

    it('scope refusal (visibility): an out-of-scope actor sees no candidates, no probing signal', async () => {
      const result = await suggestPaymentOrderMatches(sql, scopeB, { bankTransactionId: fx.bankTransactionId })
      expect(result).toEqual([])
    })

    it('invalid input: a non-existent bank_transaction returns [] rather than throwing', async () => {
      const result = await suggestPaymentOrderMatches(sql, scopeA, { bankTransactionId: 999_999 })
      expect(result).toEqual([])
    })
  })

  describe('exportSepa', () => {
    it('happy path: builds a real pain.001 XML and transitions the PO to exported', async () => {
      const result = await exportSepa(sql, ACTOR_A, {
        paymentOrderIds: [fx.paymentOrderId], initiatingPartyName: 'AStA Test',
        debtorName: 'AStA Test', debtorIban: 'DE89370400440532013000', debtorBic: null,
        requestedExecutionDate: '2026-06-20',
      })
      expect(result.exportedPaymentOrderIds).toEqual([fx.paymentOrderId])
      expect(result.xml).toContain('pain.001.001.09')
      const poRows = await sql<{ state: string }[]>`
        SELECT state FROM finance.payment_order WHERE id = ${fx.paymentOrderId}`
      expect(poRows[0]!.state).toBe('exported')
    })

    it('scope refusal: the PO\'s expense unit is out of the actor\'s scope (whole batch rolls back)', async () => {
      await expect(
        exportSepa(sql, ACTOR_B, {
          paymentOrderIds: [fx.paymentOrderId], initiatingPartyName: 'AStA Test',
          debtorName: 'AStA Test', debtorIban: 'DE89370400440532013000', debtorBic: null,
          requestedExecutionDate: '2026-06-20',
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError)
      const poRows = await sql<{ state: string }[]>`
        SELECT state FROM finance.payment_order WHERE id = ${fx.paymentOrderId}`
      expect(poRows[0]!.state).toBe('authorised')
    })

    it('invalid input: an empty batch is refused before touching the DB', async () => {
      await expect(
        exportSepa(sql, ACTOR_A, {
          paymentOrderIds: [], initiatingPartyName: 'AStA Test',
          debtorName: 'AStA Test', debtorIban: 'DE89370400440532013000', debtorBic: null,
          requestedExecutionDate: '2026-06-20',
        }),
      ).rejects.toBeInstanceOf(FinanceStateError)
    })
  })

  // R2-C3 HIGH regression — exportSepa's dedupe/sort against REAL locking. Two
  // different bank_transactions/payment_orders so the dedupe target id (paid
  // twice in the input) is unambiguous in the assertion.
  it('exportSepa deduplicates a repeated paymentOrderId end-to-end (real FOR UPDATE, real state transition)', async () => {
    const result = await exportSepa(sql, ACTOR_A, {
      paymentOrderIds: [fx.paymentOrderId, fx.paymentOrderId], initiatingPartyName: 'AStA Test',
      debtorName: 'AStA Test', debtorIban: 'DE89370400440532013000', debtorBic: null,
      requestedExecutionDate: '2026-06-20',
    })
    expect(result.exportedPaymentOrderIds).toEqual([fx.paymentOrderId])
    // The XML must contain exactly ONE CdtTrfTxInf payment for this PO, not two.
    const occurrences = result.xml.split(`GREMION-PO-${fx.paymentOrderId}`).length - 1
    expect(occurrences).toBe(1)
  })

  // R2-C3 MEDIUM regression — the running_no fiscal-year index fix (migration
  // 003/059). Before the fix, the SECOND fiscal year's first booking on a
  // ledger that already has FY1 bookings hit a 23505 unique violation against
  // the old (ledger_account_id, running_no) index.
  it('a ledger\'s SECOND fiscal year books running_no=1 without a unique-index collision', async () => {
    await recordManualPayout(sql, ACTOR_A, {
      paymentOrderId: fx.paymentOrderId, ledgerAccountId: fx.ledgerOwnA,
      budgetTitelId: fx.titelId, fiscalYearId: fx.fiscalYearId,
      amountCents: 4500, paidAt: '2026-06-15', reference: 'ref',
    }) // FY1 running_no 1 posted against fx.ledgerOwnA

    const fy2 = await sql<{ id: string }[]>`
      INSERT INTO finance.fiscal_year (name, start_date, end_date)
      VALUES ('FY2027', '2027-01-01', '2027-12-31') RETURNING id`
    const fiscalYearId2 = Number(fy2[0]!.id)

    const po2 = await sql<{ id: string }[]>`
      INSERT INTO finance.payment_order
        (expense_id, anordnung_by, feststellung_sachlich_by, feststellung_rechnerisch_by, dual_signature_attested, state)
      VALUES (${fx.expenseA}, 'u-anordnung', 'u-sachlich', 'u-rechnerisch', true, 'authorised')
      RETURNING id`
    const result = await recordManualPayout(sql, ACTOR_A, {
      paymentOrderId: Number(po2[0]!.id), ledgerAccountId: fx.ledgerOwnA,
      budgetTitelId: fx.titelId, fiscalYearId: fiscalYearId2,
      amountCents: 4500, paidAt: '2027-01-15', reference: 'ref',
    })
    expect(result.booking.running_no).toBe(1) // NOT a 23505 against the old global-per-ledger index
  })
})
