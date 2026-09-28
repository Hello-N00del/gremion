-- 003_money_running_no_fiscal_year_idx.sql
-- R2-C3 MEDIUM fix — the running_no unique index scoped GLOBALLY per ledger
-- instead of per (ledger, fiscal_year), contradicting the allocator's own
-- design intent.
--
-- allocateMoneyRunningNo (src/store/index.ts) computes
--   SELECT MAX(running_no) FROM finance.booking
--   WHERE ledger_account_id = X AND fiscal_year_id = Y
-- i.e. running_no restarts at 1 for every (ledger_account_id, fiscal_year_id)
-- pair -- a Kassenbuch is identified by that PAIR (see the allocator's own
-- docstring, and the native mirror services/write/running-no.ts's header:
-- "A Kassenbuch is identified by (ledger_account_id, fiscal_year_id)").
--
-- But 001_finance_init.sql's booking_running_no_idx enforces uniqueness on
-- (ledger_account_id, running_no) ONLY -- i.e. GLOBALLY across every fiscal
-- year a ledger has ever posted to. The first booking into a ledger's SECOND
-- fiscal year computes MAX(running_no) = NULL (no rows yet for THAT
-- ledger+FY pair), returns running_no = 1, and the INSERT then hits a 23505
-- unique violation against the OLD index because running_no 1 already
-- exists for that ledger in FY1. runStore does not map 23505 to a typed
-- domain error, so every ledger's second fiscal year 500s on its first
-- booking -- a real production-blocking defect on every one of the six
-- money-moving routes (doRecordPayout, allocateSplit), not a theoretical one.
--
-- Fix: replace the index with one scoped to (ledger_account_id,
-- fiscal_year_id, running_no), matching what the allocator already computes.
-- This is a WIDER (less restrictive) constraint than the one it replaces, so
-- every row that satisfied the old index still satisfies the new one --
-- safe to apply to a database that already has bookings.
BEGIN;

DROP INDEX IF EXISTS finance.booking_running_no_idx;

CREATE UNIQUE INDEX IF NOT EXISTS booking_running_no_fiscal_year_idx
  ON finance.booking (ledger_account_id, fiscal_year_id, running_no);

COMMIT;
