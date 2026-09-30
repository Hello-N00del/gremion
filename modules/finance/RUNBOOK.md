# Finance leaf: operator runbook

Operational notes for the finance leaf (`modules/finance`). Everything below runs against
one tenant's finance database (`finance_<slug>`), never the kernel database.

## Receipt storage keys (F1-FIX-05-K, H05)

- **New uploads** are stored under a server-built key:
  `finance/<tenantId>/expense/<expenseId>/<uuid><ext>`.
  The client's file name is kept only as the display name (`finance.expense_attachment.filename`).
- **Receipts written before the fix** live under the old key
  `finance/expense/<expenseId>/<client filename>`. They stay readable and deletable,
  because read and delete use the `storage_path` stored on each row, never a recomputed
  key. **Nothing is migrated.** Do not move or rename those objects by hand: the stored
  `storage_path` would stop resolving.
- Both storage backends refuse to overwrite:
  - The local backend writes with `wx`.
  - The Nextcloud backend sends `If-None-Match: *`.
  A collision fails the upload loudly: `EEXIST` on the local backend, HTTP 412 from
  Nextcloud. It never replaces another receipt's bytes. With UUID keys, a collision
  points to a bug, so report it and do not retry blindly.

## Migration 006: the leaf refuses to boot over duplicates (H20)

Migration `006_approval_single_open.sql` adds two partial unique indexes:
- one pending approval per approvable
- one non-voided `payment_order` per expense

It **never deletes, voids or rewrites a row**. If a tenant DB already holds duplicates, the
migration raises `finance migration 006: duplicate pending approvals exist for ...` or
`... duplicate live payment_orders exist for ...`. The leaf then refuses to open that tenant.

**Pre-flight** (run before deploying, per tenant DB). Both queries must return no rows:

```sql
SELECT approvable_type, approvable_id, count(*) AS pending
  FROM finance.approval WHERE status = 'pending'
 GROUP BY approvable_type, approvable_id HAVING count(*) > 1;

SELECT expense_id, count(*) AS live_orders
  FROM finance.payment_order WHERE expense_id IS NOT NULL AND state <> 'voided'
 GROUP BY expense_id HAVING count(*) > 1;
```

**Repair by hand.** Decide which row is the real one with the finance office. The surplus
rows stay in the table for the audit trail.

```sql
-- Reject the surplus approval (keep the one whose signatures are the real ones):
UPDATE finance.approval SET status = 'rejected', rejection_reason = 'duplicate (006 repair)'
 WHERE id = <surplus approval id>;

-- Void the surplus payment order (make sure it has NOT been paid out):
UPDATE finance.payment_order SET state = 'voided' WHERE id = <surplus payment_order id>;
```

Then restart the leaf. The next first contact re-runs 006 and builds both indexes.
`approval-single-open.integration.test.ts` covers the refusal and the repair path.

## Probes (K4#32)

- `/healthz` is the container healthcheck and needs no authentication.
- `/healthz/tenants` needs the internal secret (`x-internal-auth`). Without it, it answers 401.
  It returns only `{ success, db_ok }`. The per-tenant detail goes to the leaf log.

## Write scope on configuration (H15, K4#34)

Every write rides the actor headers that the finance service client forwards. When the
actor is missing, the scope is fail-closed: the request is denied.

- **Sub-org create:** needs write scope on the parent org unit. A body
  `parent_org_unit_id` counts only when `finance.org_unit_mirror` confirms that it is the
  new unit's parent. Otherwise the check falls back to the central finance_unit's org unit.
- **Sub-org rename and delete:** need write scope on the sub-org's own org unit.
- **Fiscal-year create/update and sub-org-type create/delete:** need one of these:
  - the `admin` or `it-admin` group
  - write scope on the central finance_unit's org unit (auditors are refused)
  - a runtime superuser
- **`configureFints`, `syncFints` and `csvImport`:** need write scope on a finance_unit
  whose ledger account the bank account backs.
