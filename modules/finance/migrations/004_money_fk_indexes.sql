-- 004_money_fk_indexes.sql
-- R2-C3 MEDIUM fix — three foreign-key columns the R23-7 money routes filter
-- on had no supporting index in 001_finance_init.sql:
--
--   finance.booking (bank_transaction_id)  -- allocateSplit's re-allocation
--     check ("SELECT id FROM finance.booking WHERE bank_transaction_id = ...
--     LIMIT 1") sequential-scans finance.booking, the largest append-only
--     table, WHILE holding the bank_transaction row lock.
--   finance.receipt (expense_id)           -- doRecordPayout's Belegprinzip
--     lookup and exportSepa's receipt-item sum both filter on this.
--   finance.receipt_item (receipt_id)      -- exportSepa's / suggestPayment-
--     OrderMatches' correlated SUM(...) subquery joins on this, once per
--     candidate payment_order.
--
-- All three columns are also unindexed foreign keys, so an ON DELETE
-- RESTRICT/CASCADE check on the parent additionally sequential-scans the
-- child table. Plain CREATE INDEX (not CONCURRENTLY): this runs inside the
-- same migration transaction as every other leaf migration
-- (tenant-store.ts#runMigrations wraps each file in sql.begin), and
-- CONCURRENTLY cannot run inside a transaction block.
BEGIN;

CREATE INDEX IF NOT EXISTS finance_booking_bank_transaction_idx
  ON finance.booking (bank_transaction_id)
  WHERE bank_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS finance_receipt_expense_idx
  ON finance.receipt (expense_id);

CREATE INDEX IF NOT EXISTS finance_receipt_item_receipt_idx
  ON finance.receipt_item (receipt_id) INCLUDE (amount_cents);

COMMIT;
