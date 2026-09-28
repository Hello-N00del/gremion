// test/bank-money.store.test.ts — mocked-PG unit tests for the R23-7 money
// domain store functions (recordManualPayout/recordCashPayout/allocateSplit/
// reconcileCashBox/suggestPaymentOrderMatches/exportSepa), ported from
// gremion-ui/.../services/money/*.ts onto the leaf's own finance schema.
//
// Each op gets: a happy path, an authorization-refusal case (AccessDeniedError
// from the write-scope gate), and an invalid-input / illegal-state case
// (FinanceStateError or FinanceUnprocessableError) — the money-moving-path test
// tier the operator called out in R23-7, mirroring fiscal-year.store.test.ts's
// fakeSql-queue technique (every tagged-template call consumes the next canned
// result-set in order; `.begin(cb)` runs the callback against the same fake).
// The real ephemeral-PG round-trip + the full end-to-end wiring (route ->
// backend -> leaf) is out of scope here — see routes.test.ts (capstone LIVE
// wiring) and the gremion-ui route-parity.test.ts (ACL verb+path) for that
// layer; exportSepa's happy path additionally needs the real `sepa`/
// `xmllint-wasm` packages wired through a live XML round-trip, which is a
// follow-up integration test, not a unit test of this store layer.

import { describe, it, expect, vi } from 'vitest'
import {
  recordManualPayout,
  recordCashPayout,
  allocateSplit,
  reconcileCashBox,
  suggestPaymentOrderMatches,
  exportSepa,
  FinanceStateError,
  FinanceUnprocessableError,
  AccessDeniedError,
  type ActorContext,
  type ScopeContext,
} from '../src/store/index.ts'
import type { Sql } from '../src/tenant-store.ts'

// exportSepa's dedupe/sort tests below exercise the real store happy path up to
// (but not including) the actual `sepa`/xmllint-wasm round-trip, which is covered
// separately by the ephemeral-Postgres integration suite
// (bank-money.integration.test.ts). Stub both dynamically-imported bank/*
// modules so these stay fast, dependency-free unit tests.
vi.mock('../src/bank/sepa-backend.js', () => ({
  SepaJsBackend: class {
    async build(batch: { payments: ReadonlyArray<{ endToEndId: string }> }): Promise<string> {
      return `<xml>${JSON.stringify(batch.payments.map((p) => p.endToEndId))}</xml>`
    }
  },
}))
vi.mock('../src/bank/xsd-validator.js', () => ({
  xsdValidatePain001: async (): Promise<void> => {},
}))

/** A fake postgres-js Sql whose tagged-template calls return, in order, the
 *  canned result-sets from `queue`; `.begin(cb)` runs the callback with the
 *  same fake (mirrors fiscal-year.store.test.ts#fakeSql).
 *
 *  R2-C3 LOW: an exhausted queue THROWS rather than silently returning `[]`.
 *  A silent `[]` default would make a test that queued too FEW result-sets
 *  fail downstream with a confusing "cannot read property of undefined" (or,
 *  worse, quietly pass with an empty-rows codepath the test never intended to
 *  exercise) instead of failing loudly at the exact call that ran out. */
function fakeSql(queue: Array<Array<Record<string, unknown>>>) {
  const fn = ((..._args: unknown[]) => {
    if (queue.length === 0) throw new Error('fakeSql queue exhausted — an unexpected extra query ran')
    return Promise.resolve(queue.shift()!)
  }) as unknown as {
    (...args: unknown[]): Promise<unknown[]>
    begin: (cb: (tx: unknown) => unknown) => Promise<unknown>
  }
  fn.begin = async (cb: (tx: unknown) => unknown) => cb(fn)
  return fn as unknown as Sql
}

const SCOPED_ACTOR: ActorContext = {
  userId: 'u1', isAuditor: false, isSuperuser: false, scopedOrgUnitIds: ['ou-1'], groups: [],
}
const WRONG_SCOPE_ACTOR: ActorContext = {
  userId: 'u1', isAuditor: false, isSuperuser: false, scopedOrgUnitIds: ['ou-9'], groups: [],
}

const PO_AUTHORISED = {
  id: '5', expense_id: '7', anordnung_by: 'a', feststellung_sachlich_by: 'b',
  feststellung_rechnerisch_by: 'c', dual_signature_attested: false, state: 'authorised',
}
const PO_PENDING = { ...PO_AUTHORISED, state: 'pending' }
const PO_SETTLED = { ...PO_AUTHORISED, state: 'settled' }
const BOOKING_DRAFT = {
  id: '50', ledger_account_id: '9', budget_titel_id: '20', fiscal_year_id: '1',
  amount_cents: '4500', booking_date: '2026-06-15', running_no: '5', payment_type: 'bar',
  receipt_id: '3', bank_transaction_id: null, state: 'draft', supersedes: null,
  correction_fiscal_year_id: null,
}
const BOOKING_POSTED = { ...BOOKING_DRAFT, state: 'posted' }

describe('recordCashPayout / recordManualPayout — shared doRecordPayout', () => {
  it('recordCashPayout happy path: posts the booking + settles the PO', async () => {
    const sql = fakeSql([
      [PO_AUTHORISED], // payment_order FOR UPDATE
      [{ finance_unit_id: '10' }], // PO's own expense -> finance_unit (R2-C3 scope gate)
      [{ org_unit_id: 'ou-1' }], // PO's own finance_unit -> org_unit (write-scope gate)
      [{ id: '9', finance_unit_id: '10', type: 'cash_box' }], // ledger lookup
      [{ org_unit_id: 'ou-1' }], // ledger's finance_unit lookup (write-scope gate)
      [{ id: '3' }], // receipt lookup (Belegprinzip)
      [], // running_no head upsert (unused return)
      [{ max: '4' }], // MAX running_no
      [BOOKING_DRAFT], // INSERT booking RETURNING *
      [BOOKING_POSTED], // UPDATE booking SET state='posted' RETURNING *
      [], // UPDATE payment_order SET state='exported' (no RETURNING)
      [PO_SETTLED], // UPDATE payment_order SET state='settled' RETURNING *
    ])
    const result = await recordCashPayout(sql, SCOPED_ACTOR, {
      paymentOrderId: 5, cashBoxLedgerId: 9, budgetTitelId: 20, fiscalYearId: 1,
      amountCents: 4500, paidAt: '2026-06-15',
    })
    expect(result.booking.state).toBe('posted')
    expect(result.booking.running_no).toBe(5)
    expect(result.paymentOrder.state).toBe('settled')
  })

  it('recordCashPayout rejects a PO not in "authorised" state (FinanceStateError -> 409)', async () => {
    const sql = fakeSql([
      [PO_PENDING],
      [{ finance_unit_id: '10' }], // scope is checked BEFORE the state (item 5b)
      [{ org_unit_id: 'ou-1' }],
    ])
    await expect(
      recordCashPayout(sql, SCOPED_ACTOR, {
        paymentOrderId: 5, cashBoxLedgerId: 9, budgetTitelId: 20, fiscalYearId: 1,
        amountCents: 4500, paidAt: '2026-06-15',
      }),
    ).rejects.toBeInstanceOf(FinanceStateError)
  })

  it('recordCashPayout rejects a non-cash_box ledger (FinanceStateError -> 409)', async () => {
    const sql = fakeSql([
      [PO_AUTHORISED],
      [{ finance_unit_id: '10' }],
      [{ org_unit_id: 'ou-1' }],
      [{ id: '9', finance_unit_id: '10', type: 'own_account' }],
      [{ org_unit_id: 'ou-1' }],
    ])
    await expect(
      recordCashPayout(sql, SCOPED_ACTOR, {
        paymentOrderId: 5, cashBoxLedgerId: 9, budgetTitelId: 20, fiscalYearId: 1,
        amountCents: 4500, paidAt: '2026-06-15',
      }),
    ).rejects.toBeInstanceOf(FinanceStateError)
  })

  it('recordManualPayout rejects a cash_box ledger (wrong direction — FinanceStateError -> 409)', async () => {
    const sql = fakeSql([
      [PO_AUTHORISED],
      [{ finance_unit_id: '10' }],
      [{ org_unit_id: 'ou-1' }],
      [{ id: '9', finance_unit_id: '10', type: 'cash_box' }],
      [{ org_unit_id: 'ou-1' }],
    ])
    await expect(
      recordManualPayout(sql, SCOPED_ACTOR, {
        paymentOrderId: 5, ledgerAccountId: 9, budgetTitelId: 20, fiscalYearId: 1,
        amountCents: 4500, paidAt: '2026-06-15', reference: 'ref',
      }),
    ).rejects.toBeInstanceOf(FinanceStateError)
  })

  it('recordManualPayout refuses when the PO\'s OWN expense/finance-unit is outside scope (AccessDeniedError -> 403)', async () => {
    const sql = fakeSql([
      [PO_AUTHORISED],
      [{ finance_unit_id: '10' }],
      [{ org_unit_id: 'ou-1' }], // NOT in WRONG_SCOPE_ACTOR's scope (['ou-9'])
    ])
    await expect(
      recordManualPayout(sql, WRONG_SCOPE_ACTOR, {
        paymentOrderId: 5, ledgerAccountId: 9, budgetTitelId: 20, fiscalYearId: 1,
        amountCents: 4500, paidAt: '2026-06-15', reference: 'ref',
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError)
  })

  it('recordManualPayout refuses when only the TARGET LEDGER is outside scope (ledger-side gate still applies)', async () => {
    const sql = fakeSql([
      [PO_AUTHORISED],
      [{ finance_unit_id: '10' }],
      [{ org_unit_id: 'ou-1' }], // PO's own org — IN SCOPED_ACTOR's scope (['ou-1'])
      [{ id: '9', finance_unit_id: '20', type: 'own_account' }],
      [{ org_unit_id: 'ou-9' }], // ledger's org — NOT in SCOPED_ACTOR's scope
    ])
    await expect(
      recordManualPayout(sql, SCOPED_ACTOR, {
        paymentOrderId: 5, ledgerAccountId: 9, budgetTitelId: 20, fiscalYearId: 1,
        amountCents: 4500, paidAt: '2026-06-15', reference: 'ref',
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError)
  })

  // R2-C3 MEDIUM regression test — cross-org PO settlement (pre-existing gap,
  // closed; the native manual-payout-recorder.ts had this gap too). Before the
  // fix, a writer scoped only to the TARGET LEDGER's org unit could settle a
  // payment order whose own expense belongs to a DIFFERENT org unit: every old
  // check passed (the PO is authorised, the ledger is in scope), moving another
  // unit's money through this unit's Kassenbuch.
  it('refuses a cross-org PO settlement: target ledger IS in scope but the PO\'s own expense unit is NOT', async () => {
    const sql = fakeSql([
      [PO_AUTHORISED],
      [{ finance_unit_id: '30' }], // PO's expense -> a DIFFERENT finance_unit
      [{ org_unit_id: 'ou-9' }], // that unit's org — NOT in SCOPED_ACTOR's scope (['ou-1'])
      // (the ledger lookup below must NEVER be reached — the fake queue would
      // desync and the test would fail with a shape error if it were)
    ])
    await expect(
      recordManualPayout(sql, SCOPED_ACTOR, {
        paymentOrderId: 5, ledgerAccountId: 9, budgetTitelId: 20, fiscalYearId: 1,
        amountCents: 4500, paidAt: '2026-06-15', reference: 'ref',
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError)
  })

  // TASK-009 verifier item 5b: scope is checked BEFORE anything about the
  // payment order is revealed. A missing PO and an out-of-scope PO (in any
  // state) must be indistinguishable: same error class, same message.
  it('item 5b: a NON-EXISTENT payment order is the same 403 as an out-of-scope one (no existence oracle)', async () => {
    const missing = await recordManualPayout(fakeSql([[]]), WRONG_SCOPE_ACTOR, {
      paymentOrderId: 5, ledgerAccountId: 9, budgetTitelId: 20, fiscalYearId: 1,
      amountCents: 4500, paidAt: '2026-06-15', reference: 'ref',
    }).then(() => new Error('did not throw'), (e: unknown) => e as Error)
    const outOfScope = await recordManualPayout(
      fakeSql([[PO_AUTHORISED], [{ finance_unit_id: '10' }], [{ org_unit_id: 'ou-1' }]]),
      WRONG_SCOPE_ACTOR,
      {
        paymentOrderId: 5, ledgerAccountId: 9, budgetTitelId: 20, fiscalYearId: 1,
        amountCents: 4500, paidAt: '2026-06-15', reference: 'ref',
      },
    ).then(() => new Error('did not throw'), (e: unknown) => e as Error)
    expect(missing).toBeInstanceOf(AccessDeniedError)
    expect(outOfScope).toBeInstanceOf(AccessDeniedError)
    expect(missing.message).toBe(outOfScope.message)
  })

  it('item 5b: an out-of-scope PO in a NON-authorised state is a 403, never a 409 revealing its state', async () => {
    const sql = fakeSql([
      [PO_SETTLED],
      [{ finance_unit_id: '10' }],
      [{ org_unit_id: 'ou-1' }], // NOT in WRONG_SCOPE_ACTOR's scope
    ])
    await expect(
      recordCashPayout(sql, WRONG_SCOPE_ACTOR, {
        paymentOrderId: 5, cashBoxLedgerId: 9, budgetTitelId: 20, fiscalYearId: 1,
        amountCents: 4500, paidAt: '2026-06-15',
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError)
  })

  // TASK-009 item 3: a payment_order whose expense_id (or, below, whose
  // finance_unit_id) references a row that no longer exists is a
  // data-integrity problem, not an ordinary access-scope refusal — the API
  // response stays the same generic bodiless 403, but the concrete missing
  // id must reach the logs (see lockMoneyPaymentOrderInScope).
  it('item 3: a dangling expense reference logs the concrete ids before the generic 403', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(
        recordManualPayout(fakeSql([[PO_AUTHORISED], []]), SCOPED_ACTOR, {
          paymentOrderId: 5, ledgerAccountId: 9, budgetTitelId: 20, fiscalYearId: 1,
          amountCents: 4500, paidAt: '2026-06-15', reference: 'ref',
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError)
      expect(errSpy).toHaveBeenCalledTimes(1)
      const logged = errSpy.mock.calls[0]!.join(' ')
      expect(logged).toContain('payment_order#5')
      expect(logged).toContain('expense#7')
    } finally {
      errSpy.mockRestore()
    }
  })

  it('item 3: a dangling finance_unit reference logs the concrete ids before the generic 403', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(
        recordManualPayout(fakeSql([[PO_AUTHORISED], [{ finance_unit_id: '10' }], []]), SCOPED_ACTOR, {
          paymentOrderId: 5, ledgerAccountId: 9, budgetTitelId: 20, fiscalYearId: 1,
          amountCents: 4500, paidAt: '2026-06-15', reference: 'ref',
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError)
      expect(errSpy).toHaveBeenCalledTimes(1)
      const logged = errSpy.mock.calls[0]!.join(' ')
      expect(logged).toContain('payment_order#5')
      expect(logged).toContain('finance_unit#10')
    } finally {
      errSpy.mockRestore()
    }
  })

  it('recordManualPayout does not persist `reference` (accepted for API parity, discarded like the native recorder)', async () => {
    const sql = fakeSql([
      [PO_AUTHORISED],
      [{ finance_unit_id: '10' }],
      [{ org_unit_id: 'ou-1' }],
      [{ id: '9', finance_unit_id: '10', type: 'own_account' }],
      [{ org_unit_id: 'ou-1' }],
      [{ id: '3' }],
      [],
      [{ max: '0' }],
      [BOOKING_DRAFT],
      [BOOKING_POSTED],
      [],
      [PO_SETTLED],
    ])
    const result = await recordManualPayout(sql, SCOPED_ACTOR, {
      paymentOrderId: 5, ledgerAccountId: 9, budgetTitelId: 20, fiscalYearId: 1,
      amountCents: 4500, paidAt: '2026-06-15', reference: 'audit-trail-note',
    })
    expect(result.booking).not.toHaveProperty('reference')
  })
})

describe('allocateSplit', () => {
  it('rejects an empty parts array before touching the DB (FinanceUnprocessableError -> 422)', async () => {
    const sql = fakeSql([]) // no query should ever be consumed
    await expect(
      allocateSplit(sql, SCOPED_ACTOR, { bankTransactionId: 1, parts: [] }),
    ).rejects.toBeInstanceOf(FinanceUnprocessableError)
  })

  it('rejects a duplicate ledger across parts before touching the DB (FinanceStateError -> 409)', async () => {
    const sql = fakeSql([])
    await expect(
      allocateSplit(sql, SCOPED_ACTOR, {
        bankTransactionId: 1,
        parts: [
          { ledgerAccountId: 9, budgetTitelId: 1, fiscalYearId: 1, amountCents: 50 },
          { ledgerAccountId: 9, budgetTitelId: 2, fiscalYearId: 1, amountCents: 50 },
        ],
      }),
    ).rejects.toBeInstanceOf(FinanceStateError)
  })

  it('rejects a sum mismatch against the locked bank_transaction (FinanceUnprocessableError -> 422)', async () => {
    const sql = fakeSql([
      [{ id: '1', amount_cents: '100', allocated_ledger_account_id: null, bank_account_id: '5' }], // bank_transaction FOR UPDATE
      [{ org_unit_id: 'ou-1' }], // R2-C3: bank_transaction's own scope gate (passes — reached to prove ordering)
    ])
    await expect(
      allocateSplit(sql, SCOPED_ACTOR, {
        bankTransactionId: 1,
        parts: [{ ledgerAccountId: 9, budgetTitelId: 1, fiscalYearId: 1, amountCents: 99 }],
      }),
    ).rejects.toBeInstanceOf(FinanceUnprocessableError)
  })

  it('TASK-009 item 5a: the sum-mismatch 422 message names NO amounts (neither the parts sum nor the transaction amount)', async () => {
    const sql = fakeSql([
      [{ id: '1', amount_cents: '12345', allocated_ledger_account_id: null, bank_account_id: '5' }],
      [{ org_unit_id: 'ou-1' }],
    ])
    const err = await allocateSplit(sql, SCOPED_ACTOR, {
      bankTransactionId: 1,
      parts: [{ ledgerAccountId: 9, budgetTitelId: 1, fiscalYearId: 1, amountCents: 6789 }],
    }).then(() => new Error('did not throw'), (e: unknown) => e as Error)
    expect(err).toBeInstanceOf(FinanceUnprocessableError)
    expect(err.message).not.toMatch(/12345|6789/)
  })

  // R2-C3 MEDIUM regression test — the amount-leak fix. Before the fix, an
  // out-of-scope actor got a 422 body echoing the transaction's real amount
  // (`... != txn ${txAmountCents}`) because no scope check ran before the
  // sum-invariant check. The scope gate must fire FIRST, so this test uses a
  // deliberately mismatched sum (99 != 100) to prove AccessDeniedError wins.
  it('refuses a bank_transaction whose backing bank_account has no writable finance_unit — BEFORE the amount can leak', async () => {
    const sql = fakeSql([
      [{ id: '1', amount_cents: '100', allocated_ledger_account_id: null, bank_account_id: '5' }],
      [{ org_unit_id: 'ou-9' }], // the only unit backing this bank_account — NOT in SCOPED_ACTOR's scope (['ou-1'])
    ])
    await expect(
      allocateSplit(sql, SCOPED_ACTOR, {
        bankTransactionId: 1,
        parts: [{ ledgerAccountId: 9, budgetTitelId: 1, fiscalYearId: 1, amountCents: 99 }], // mismatched on purpose
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError)
  })

  it('refuses a part\'s ledger outside the actor\'s org-unit scope (AccessDeniedError -> 403)', async () => {
    const sql = fakeSql([
      [{ id: '1', amount_cents: '100', allocated_ledger_account_id: null, bank_account_id: '5' }],
      [{ org_unit_id: 'ou-9' }], // bank_transaction's own scope gate — IN WRONG_SCOPE_ACTOR's scope, passes
      [], // no prior bookings
      [{ id: '9', finance_unit_id: '10', type: 'own_account', bank_account_id: '5' }], // ledger lookup (same bank_account as the txn)
      [{ org_unit_id: 'ou-1' }], // NOT in WRONG_SCOPE_ACTOR's scope
    ])
    await expect(
      allocateSplit(sql, WRONG_SCOPE_ACTOR, {
        bankTransactionId: 1,
        parts: [{ ledgerAccountId: 9, budgetTitelId: 1, fiscalYearId: 1, amountCents: 100 }],
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError)
  })

  // R2-C3 MEDIUM regression test — a part's ledger must be backed by the SAME
  // bank_account as the transaction being split, even when that ledger's own
  // finance_unit is otherwise in scope.
  it('refuses a part\'s ledger backed by a DIFFERENT bank_account than the transaction (FinanceStateError -> 409)', async () => {
    const sql = fakeSql([
      [{ id: '1', amount_cents: '100', allocated_ledger_account_id: null, bank_account_id: '5' }],
      [{ org_unit_id: 'ou-1' }], // bank_transaction's own scope gate — passes
      [], // no prior bookings
      [{ id: '9', finance_unit_id: '10', type: 'own_account', bank_account_id: '7' }], // WRONG bank_account (7 != 5)
      [{ org_unit_id: 'ou-1' }], // ledger's own finance_unit scope — passes (the mismatch is caught separately)
    ])
    await expect(
      allocateSplit(sql, SCOPED_ACTOR, {
        bankTransactionId: 1,
        parts: [{ ledgerAccountId: 9, budgetTitelId: 1, fiscalYearId: 1, amountCents: 100 }],
      }),
    ).rejects.toBeInstanceOf(FinanceStateError)
  })

  it('happy path: one part sums to the transaction amount and posts one booking', async () => {
    const sql = fakeSql([
      [{ id: '1', amount_cents: '100', allocated_ledger_account_id: null, bank_account_id: '5' }], // lock txn
      [{ org_unit_id: 'ou-1' }], // bank_transaction's own scope gate
      [], // no prior bookings
      [{ id: '9', finance_unit_id: '10', type: 'own_account', bank_account_id: '5' }], // ledger lookup (same bank_account)
      [{ org_unit_id: 'ou-1' }], // finance_unit lookup (in scope)
      [{ booking_date: '2026-06-15' }], // txn booking_date
      [], // running_no head upsert
      [{ max: '0' }], // MAX running_no
      [{ ...BOOKING_DRAFT, id: '60', ledger_account_id: '9', bank_transaction_id: '1', payment_type: 'bargeldlos' }], // INSERT
      [{ ...BOOKING_POSTED, id: '60', ledger_account_id: '9', bank_transaction_id: '1', payment_type: 'bargeldlos' }], // posted
    ])
    const bookings = await allocateSplit(sql, SCOPED_ACTOR, {
      bankTransactionId: 1,
      parts: [{ ledgerAccountId: 9, budgetTitelId: 1, fiscalYearId: 1, amountCents: 100 }],
    })
    expect(bookings).toHaveLength(1)
    expect(bookings[0]!.state).toBe('posted')
    expect(bookings[0]!.bank_transaction_id).toBe(1)
  })

  // TASK-009 verifier item 4 (deletion-aware pass): the in-process ACL zod
  // (gremion-ui allocate-split +server.ts) always allowed NEGATIVE parts for a
  // debit (outgoing) transaction; the leaf port required > 0 and so refused
  // every outgoing split in service mode. Restored contract: non-zero safe
  // integers whose sign matches the transaction's.
  it('debit split: an OUTGOING transaction splits into negative parts and posts one booking per part', async () => {
    const sql = fakeSql([
      [{ id: '1', amount_cents: '-100', allocated_ledger_account_id: null, bank_account_id: '5' }], // lock txn
      [{ org_unit_id: 'ou-1' }], // bank_transaction's own scope gate
      [], // no prior bookings
      [{ id: '9', finance_unit_id: '10', type: 'own_account', bank_account_id: '5' }], // part 1 ledger
      [{ org_unit_id: 'ou-1' }],
      [{ id: '11', finance_unit_id: '10', type: 'sub_fund', bank_account_id: '5' }], // part 2 ledger
      [{ org_unit_id: 'ou-1' }],
      [{ booking_date: '2026-06-15' }], // txn booking_date
      [], [{ max: '0' }], // running_no for ledger 9
      [{ ...BOOKING_DRAFT, id: '60', ledger_account_id: '9', amount_cents: '-60', bank_transaction_id: '1', payment_type: 'bargeldlos' }],
      [{ ...BOOKING_POSTED, id: '60', ledger_account_id: '9', amount_cents: '-60', bank_transaction_id: '1', payment_type: 'bargeldlos' }],
      [], [{ max: '0' }], // running_no for ledger 11
      [{ ...BOOKING_DRAFT, id: '61', ledger_account_id: '11', amount_cents: '-40', bank_transaction_id: '1', payment_type: 'bargeldlos' }],
      [{ ...BOOKING_POSTED, id: '61', ledger_account_id: '11', amount_cents: '-40', bank_transaction_id: '1', payment_type: 'bargeldlos' }],
    ])
    const bookings = await allocateSplit(sql, SCOPED_ACTOR, {
      bankTransactionId: 1,
      parts: [
        { ledgerAccountId: 9, budgetTitelId: 1, fiscalYearId: 1, amountCents: -60 },
        { ledgerAccountId: 11, budgetTitelId: 2, fiscalYearId: 1, amountCents: -40 },
      ],
    })
    expect(bookings.map((b) => b.amount_cents)).toEqual([-60, -40])
    expect(bookings.every((b) => b.state === 'posted')).toBe(true)
  })

  it('refuses parts whose sign disagrees with the transaction even when they sum correctly (FinanceUnprocessableError -> 422)', async () => {
    const sql = fakeSql([
      [{ id: '1', amount_cents: '100', allocated_ledger_account_id: null, bank_account_id: '5' }],
      [{ org_unit_id: 'ou-1' }], // scope gate passes
    ])
    await expect(
      allocateSplit(sql, SCOPED_ACTOR, {
        bankTransactionId: 1,
        parts: [
          { ledgerAccountId: 9, budgetTitelId: 1, fiscalYearId: 1, amountCents: 150 },
          { ledgerAccountId: 11, budgetTitelId: 1, fiscalYearId: 1, amountCents: -50 },
        ],
      }),
    ).rejects.toBeInstanceOf(FinanceUnprocessableError)
  })

  it('rejects re-allocating an already single-allocated transaction (FinanceStateError -> 409)', async () => {
    const sql = fakeSql([
      [{ id: '1', amount_cents: '100', allocated_ledger_account_id: '9', bank_account_id: '5' }], // already allocated
      [{ org_unit_id: 'ou-1' }], // bank_transaction's own scope gate (runs before the allocated-state check)
    ])
    await expect(
      allocateSplit(sql, SCOPED_ACTOR, {
        bankTransactionId: 1,
        parts: [{ ledgerAccountId: 9, budgetTitelId: 1, fiscalYearId: 1, amountCents: 100 }],
      }),
    ).rejects.toBeInstanceOf(FinanceStateError)
  })
})

describe('reconcileCashBox', () => {
  it('happy path: IN_BALANCE when counted equals the posted booking sum', async () => {
    const sql = fakeSql([
      [{ id: '9', finance_unit_id: '10', type: 'cash_box' }],
      [{ org_unit_id: 'ou-1' }],
      [{ total: '5000' }],
    ])
    const report = await reconcileCashBox(sql, SCOPED_ACTOR, {
      cashBoxLedgerId: 9, countedCents: 5000, countedAt: '2026-06-15T12:00:00Z',
    })
    expect(report.status).toBe('IN_BALANCE')
    expect(report.discrepancyCents).toBe(0)
  })

  it('computes a signed OVER_COUNT discrepancy (value-not-throw)', async () => {
    const sql = fakeSql([
      [{ id: '9', finance_unit_id: '10', type: 'cash_box' }],
      [{ org_unit_id: 'ou-1' }],
      [{ total: '5000' }],
    ])
    const report = await reconcileCashBox(sql, SCOPED_ACTOR, {
      cashBoxLedgerId: 9, countedCents: 5200, countedAt: '2026-06-15T12:00:00Z',
    })
    expect(report.status).toBe('OVER_COUNT')
    expect(report.discrepancyCents).toBe(200)
  })

  it('rejects a non-cash_box ledger (FinanceStateError -> 409)', async () => {
    const sql = fakeSql([
      [{ id: '9', finance_unit_id: '10', type: 'own_account' }],
      [{ org_unit_id: 'ou-1' }],
    ])
    await expect(
      reconcileCashBox(sql, SCOPED_ACTOR, {
        cashBoxLedgerId: 9, countedCents: 100, countedAt: '2026-06-15T12:00:00Z',
      }),
    ).rejects.toBeInstanceOf(FinanceStateError)
  })

  it('refuses a ledger outside the actor\'s org-unit scope (AccessDeniedError -> 403)', async () => {
    const sql = fakeSql([
      [{ id: '9', finance_unit_id: '10', type: 'cash_box' }],
      [{ org_unit_id: 'ou-1' }], // NOT in WRONG_SCOPE_ACTOR's scope
    ])
    await expect(
      reconcileCashBox(sql, WRONG_SCOPE_ACTOR, {
        cashBoxLedgerId: 9, countedCents: 100, countedAt: '2026-06-15T12:00:00Z',
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError)
  })
})

describe('suggestPaymentOrderMatches', () => {
  const AUDITOR: ScopeContext = { isAuditor: true, isSuperuser: false, scopedOrgUnitIds: [] }
  const EMPTY_SCOPE: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [] }
  const SCOPED: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: ['ou-1'] }

  it('an empty scope returns [] WITHOUT any query (short-circuit, mirrors the native oracle)', async () => {
    const sql = fakeSql([])
    const result = await suggestPaymentOrderMatches(sql, EMPTY_SCOPE, { bankTransactionId: 1 })
    expect(result).toEqual([])
  })

  it('a non-existent bank_transaction returns [] (same as an out-of-scope one — no probing signal)', async () => {
    const sql = fakeSql([
      [{ id: '10' }], // scopedFinanceUnitIds
      [], // bank_transaction lookup: none
    ])
    const result = await suggestPaymentOrderMatches(sql, SCOPED, { bankTransactionId: 999 })
    expect(result).toEqual([])
  })

  it('happy path: scores a matching candidate above the floor and returns it', async () => {
    const sql = fakeSql([
      [{ id: '10' }], // scopedFinanceUnitIds
      [{
        id: '1', amount_cents: '4500', counterparty_iban: 'DE89370400440532013000',
        counterparty_name: 'Max Mustermann', bank_reference: 'REF-1', purpose: 'Beitrag',
        bank_account_id: '5',
      }], // bank_transaction
      [{ one: 1 }], // scope-visibility check
      [{
        po_id: '42', payee_name: 'Max Mustermann', payee_iban: 'DE89370400440532013000',
        payee_purpose: null, expense_amount_cents: '4500',
      }], // candidate
    ])
    const result = await suggestPaymentOrderMatches(sql, AUDITOR, { bankTransactionId: 1 })
    expect(result).toHaveLength(1)
    expect(result[0]!.paymentOrderId).toBe(42)
    expect(result[0]!.score).toBeGreaterThanOrEqual(0.3)
    expect(result[0]!.reasons).toContain('amount_eq')
    expect(result[0]!.reasons).toContain('iban_eq')
  })

  it('drops a candidate scoring below the 0.30 floor', async () => {
    const sql = fakeSql([
      [{ id: '10' }],
      [{
        id: '1', amount_cents: '4500', counterparty_iban: null,
        counterparty_name: null, bank_reference: null, purpose: null, bank_account_id: '5',
      }],
      [{ one: 1 }],
      [{ po_id: '42', payee_name: 'Someone Else', payee_iban: null, payee_purpose: null, expense_amount_cents: '100' }],
    ])
    const result = await suggestPaymentOrderMatches(sql, AUDITOR, { bankTransactionId: 1 })
    expect(result).toEqual([])
  })
})

describe('exportSepa', () => {
  it('rejects an empty payment-order batch (FinanceStateError -> 409)', async () => {
    const sql = fakeSql([])
    await expect(
      exportSepa(sql, SCOPED_ACTOR, {
        paymentOrderIds: [], initiatingPartyName: 'AStA', debtorName: 'AStA',
        debtorIban: 'DE1234', debtorBic: null, requestedExecutionDate: '2026-06-15',
      }),
    ).rejects.toBeInstanceOf(FinanceStateError)
  })

  it('rejects a PO not in "authorised" state (FinanceStateError -> 409)', async () => {
    const sql = fakeSql([
      [PO_PENDING],
      [{ finance_unit_id: '10', payee_name: 'X', payee_iban: 'DE1', payee_purpose: null }], // scope first (item 5b)
      [{ org_unit_id: 'ou-1' }],
    ])
    await expect(
      exportSepa(sql, SCOPED_ACTOR, {
        paymentOrderIds: [5], initiatingPartyName: 'AStA', debtorName: 'AStA',
        debtorIban: 'DE1234', debtorBic: null, requestedExecutionDate: '2026-06-15',
      }),
    ).rejects.toBeInstanceOf(FinanceStateError)
  })

  it('refuses a PO whose expense sits outside the actor\'s org-unit scope (AccessDeniedError -> 403)', async () => {
    const sql = fakeSql([
      [PO_AUTHORISED],
      [{ finance_unit_id: '10', payee_name: 'X', payee_iban: 'DE1', payee_purpose: null }],
      [{ org_unit_id: 'ou-1' }], // NOT in WRONG_SCOPE_ACTOR's scope
    ])
    await expect(
      exportSepa(sql, WRONG_SCOPE_ACTOR, {
        paymentOrderIds: [5], initiatingPartyName: 'AStA', debtorName: 'AStA',
        debtorIban: 'DE1234', debtorBic: null, requestedExecutionDate: '2026-06-15',
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError)
  })

  it('item 5b: a NON-EXISTENT payment order is the same 403 as an out-of-scope one', async () => {
    const input = {
      paymentOrderIds: [5], initiatingPartyName: 'AStA', debtorName: 'AStA',
      debtorIban: 'DE1234', debtorBic: null, requestedExecutionDate: '2026-06-15',
    }
    const missing = await exportSepa(fakeSql([[]]), WRONG_SCOPE_ACTOR, input).then(() => new Error('did not throw'), (e: unknown) => e as Error)
    const outOfScope = await exportSepa(
      fakeSql([
        [PO_AUTHORISED],
        [{ finance_unit_id: '10', payee_name: 'X', payee_iban: 'DE1', payee_purpose: null }],
        [{ org_unit_id: 'ou-1' }],
      ]),
      WRONG_SCOPE_ACTOR, input,
    ).then(() => new Error('did not throw'), (e: unknown) => e as Error)
    expect(missing).toBeInstanceOf(AccessDeniedError)
    expect(outOfScope).toBeInstanceOf(AccessDeniedError)
    expect(missing.message).toBe(outOfScope.message)
  })

  it('item 5b: an out-of-scope PO in a NON-authorised state is a 403, never a 409 revealing its state', async () => {
    const sql = fakeSql([
      [PO_PENDING],
      [{ finance_unit_id: '10', payee_name: 'X', payee_iban: 'DE1', payee_purpose: null }],
      [{ org_unit_id: 'ou-1' }], // NOT in WRONG_SCOPE_ACTOR's scope
    ])
    await expect(
      exportSepa(sql, WRONG_SCOPE_ACTOR, {
        paymentOrderIds: [5], initiatingPartyName: 'AStA', debtorName: 'AStA',
        debtorIban: 'DE1234', debtorBic: null, requestedExecutionDate: '2026-06-15',
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError)
  })

  it('rejects a payee with no IBAN on file (FinanceStateError -> 409)', async () => {
    const sql = fakeSql([
      [PO_AUTHORISED],
      [{ finance_unit_id: '10', payee_name: 'X', payee_iban: null, payee_purpose: null }],
      [{ org_unit_id: 'ou-1' }],
    ])
    await expect(
      exportSepa(sql, SCOPED_ACTOR, {
        paymentOrderIds: [5], initiatingPartyName: 'AStA', debtorName: 'AStA',
        debtorIban: 'DE1234', debtorBic: null, requestedExecutionDate: '2026-06-15',
      }),
    ).rejects.toBeInstanceOf(FinanceStateError)
  })

  // R2-C3 HIGH: a repeated id must not pay out twice, and mixed-order ids must
  // still lock/process in a stable ascending order (deadlock avoidance across
  // overlapping batches). See store/index.ts#exportSepa's uniqueSortedIds.
  it('deduplicates a repeated paymentOrderId — exports it once, not twice', async () => {
    const sql = fakeSql([
      [PO_AUTHORISED], // #5 payment_order FOR UPDATE (consumed ONCE, not twice)
      [{ finance_unit_id: '10', payee_name: 'X', payee_iban: 'DE1234', payee_purpose: null }],
      [{ org_unit_id: 'ou-1' }],
      [{ total: '4500' }],
      [{ ...PO_AUTHORISED, state: 'exported' }], // UPDATE ... RETURNING *
    ])
    const result = await exportSepa(sql, SCOPED_ACTOR, {
      paymentOrderIds: [5, 5], initiatingPartyName: 'AStA', debtorName: 'AStA',
      debtorIban: 'DE1234', debtorBic: null, requestedExecutionDate: '2026-06-15',
    })
    expect(result.exportedPaymentOrderIds).toEqual([5])
  })

  it('locks + exports out-of-order, duplicated ids in stable ascending order', async () => {
    const PO3 = {
      id: '3', expense_id: '30', anordnung_by: 'a', feststellung_sachlich_by: 'b',
      feststellung_rechnerisch_by: 'c', dual_signature_attested: false, state: 'authorised',
    }
    const PO9 = { ...PO3, id: '9', expense_id: '90' }
    const sql = fakeSql([
      [PO3], // #3 locked FIRST despite appearing second in the input array
      [{ finance_unit_id: '10', payee_name: 'A', payee_iban: 'DE1', payee_purpose: null }],
      [{ org_unit_id: 'ou-1' }],
      [{ total: '100' }],
      [PO9], // #9 locked SECOND — only once, despite appearing twice in the input
      [{ finance_unit_id: '10', payee_name: 'B', payee_iban: 'DE2', payee_purpose: null }],
      [{ org_unit_id: 'ou-1' }],
      [{ total: '200' }],
      [{ ...PO3, state: 'exported' }],
      [{ ...PO9, state: 'exported' }],
    ])
    const result = await exportSepa(sql, SCOPED_ACTOR, {
      paymentOrderIds: [9, 3, 3, 9], initiatingPartyName: 'AStA', debtorName: 'AStA',
      debtorIban: 'DE1234', debtorBic: null, requestedExecutionDate: '2026-06-15',
    })
    expect(result.exportedPaymentOrderIds).toEqual([3, 9])
  })
})
