-- 006_approval_single_open.sql -- F1-FIX-05-K (H20: S4#3, K4#0).
--
-- One open approval per approvable, and one live payment_order per expense.
-- Without these, a repeated "Genehmigung anfordern" opened two pending approvals,
-- both could be signed through, and each finalisation inserted its own authorised
-- payment_order: a double payout for one expense.
--
-- MONEY SAFETY: this migration never deletes, voids or rewrites a row. If the
-- database already holds duplicates it RAISES and the leaf refuses to boot for that
-- tenant, naming the affected approvables / expenses. An operator resolves them by
-- hand (reject the surplus approval, void the surplus payment_order), then restarts.
--
-- Idempotent: the leaf runner re-applies every migration at first contact, so the
-- checks run on every boot (cheap once the indexes exist: they cannot find a row).
--
-- NB the leaf runner strips the first line-leading BEGIN of a file (it wraps each
-- file in its own transaction), so the PL/pgSQL BEGIN below must not start a line.

DO $$
DECLARE
  dup_approvals text;
  dup_orders    text; BEGIN
  SELECT string_agg(format('%s#%s (%s pending)', approvable_type, approvable_id, n), ', ')
    INTO dup_approvals
    FROM (
      SELECT approvable_type, approvable_id, count(*) AS n
        FROM finance.approval
       WHERE status = 'pending'
       GROUP BY approvable_type, approvable_id
      HAVING count(*) > 1
    ) d;
  IF dup_approvals IS NOT NULL THEN
    RAISE EXCEPTION 'finance migration 006: duplicate pending approvals exist for %; resolve them by hand (reject the surplus approval) before this leaf can boot. No row was changed.', dup_approvals
      USING ERRCODE = 'unique_violation';
  END IF;

  SELECT string_agg(format('expense#%s (%s live payment_orders)', expense_id, n), ', ')
    INTO dup_orders
    FROM (
      SELECT expense_id, count(*) AS n
        FROM finance.payment_order
       WHERE expense_id IS NOT NULL AND state <> 'voided'
       GROUP BY expense_id
      HAVING count(*) > 1
    ) d;
  IF dup_orders IS NOT NULL THEN
    RAISE EXCEPTION 'finance migration 006: duplicate live payment_orders exist for %; resolve them by hand (void the surplus order) before this leaf can boot. No row was changed.', dup_orders
      USING ERRCODE = 'unique_violation';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS approval_one_open_per_approvable_idx
  ON finance.approval (approvable_type, approvable_id)
  WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS payment_order_one_live_per_expense_idx
  ON finance.payment_order (expense_id)
  WHERE expense_id IS NOT NULL AND state <> 'voided';
