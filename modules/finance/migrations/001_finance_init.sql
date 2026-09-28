-- 001_finance_init.sql
-- #369 slice 2 — the finance leaf's OWN `finance` schema, squashed from the
-- kernel migrations that built it (gremion-ui/migrations/013 + the folded finance
-- deltas 016/017/020/021/022/025/026/027/028/029/030/031/035/036). Money is
-- integer euro-cents (BIGINT). PKs are BIGINT GENERATED ALWAYS AS IDENTITY.
--
-- ── SLICE-3 DELTA vs the kernel schema ──────────────────────────────────────
-- The kernel finance schema declares THREE `org_unit_id UUID ... REFERENCES
-- org_units(id) ON DELETE RESTRICT` foreign keys (finance.finance_unit,
-- finance.project, finance.inventory_item). `org_units` is a GOVERNANCE table
-- that lives in the KERNEL database — the finance leaf DB does NOT own it, so
-- those 3 cross-database RESTRICT FKs CANNOT exist here and are intentionally
-- OMITTED below (the columns are kept as plain `UUID NOT NULL`). Slice 3
-- (#369 WP2-S3) restores the referential guarantee at the application layer:
-- app-level existence/RESTRICT guards + the createSubOrg saga via a kernel
-- callback. Each omission is marked inline with `-- SLICE-3:`.
--
-- Idempotent DDL (CREATE ... IF NOT EXISTS / CREATE OR REPLACE VIEW) so the
-- manifest-verified leaf migration runner can re-apply it safely.

CREATE SCHEMA IF NOT EXISTS finance;

-- ─────────────────────────────────────────────────────────────────────────
-- Section 1 — config + org-unit bridge
-- ─────────────────────────────────────────────────────────────────────────

-- The per-installation Finanzordnung record (singleton — see the unique index).
CREATE TABLE IF NOT EXISTS finance.finanzordnung_profile (
  id                                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bundesland                          TEXT   NOT NULL,
  deckungsfaehigkeit_pct              NUMERIC(5,2) NOT NULL DEFAULT 0,
  reserve_base                        TEXT   NOT NULL DEFAULT 'contribution_income'
                                      CHECK (reserve_base IN ('contribution_income', 'budget_volume')),
  reserve_frei_amount_cents           BIGINT NOT NULL DEFAULT 0,
  reserve_frei_bound                  TEXT   NOT NULL DEFAULT 'ceiling'
                                      CHECK (reserve_frei_bound IN ('floor', 'ceiling')),
  reserve_betriebsmittel_amount_cents BIGINT NOT NULL DEFAULT 0,
  reserve_betriebsmittel_bound        TEXT   NOT NULL DEFAULT 'ceiling'
                                      CHECK (reserve_betriebsmittel_bound IN ('floor', 'ceiling')),
  reserve_zweckgebunden_amount_cents  BIGINT NOT NULL DEFAULT 0,
  reserve_zweckgebunden_bound         TEXT   NOT NULL DEFAULT 'ceiling'
                                      CHECK (reserve_zweckgebunden_bound IN ('floor', 'ceiling')),
  carry_over_central                  TEXT   NOT NULL DEFAULT 'to_reserves'
                                      CHECK (carry_over_central IN ('to_reserves', 'carry_forward')),
  carry_over_fachschaft               TEXT   NOT NULL DEFAULT 'carry_forward'
                                      CHECK (carry_over_fachschaft IN ('to_reserves', 'carry_forward')),
  retention_years                     INT    NOT NULL DEFAULT 10,
  retention_from                      TEXT   NOT NULL DEFAULT 'entlastung'
                                      CHECK (retention_from IN ('entlastung', 'fiscal_year_end')),
  inventar_threshold_cents            BIGINT NOT NULL DEFAULT 80000,
  handkasse_cap_cents                 BIGINT,
  majority_haushalt                   TEXT   NOT NULL DEFAULT 'simple',
  majority_nachtrag                   TEXT   NOT NULL DEFAULT 'simple',
  majority_entlastung                 TEXT   NOT NULL DEFAULT 'simple',
  -- Folded from 029 + 035 (KV-first order is the frozen v6 design default).
  signer_stages                       JSONB  NOT NULL DEFAULT
    '[{"role":"KV","required_group":"ref-finanzen-kv","certifies":["sachlich","rechnerisch"]},{"role":"HV","required_group":"ref-finanzen-hv","certifies":["anordnung"]}]'::jsonb,
  decision_authority_tiers            JSONB  NOT NULL DEFAULT '[]'::jsonb,
  created_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 025: singleton — exactly one profile row.
CREATE UNIQUE INDEX IF NOT EXISTS finanzordnung_profile_singleton_idx
  ON finance.finanzordnung_profile ((true));

-- Optional Helios budget-approval integration config.
CREATE TABLE IF NOT EXISTS finance.finance_helios_settings (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enabled            BOOLEAN NOT NULL DEFAULT false,
  voting_period_days INT     NOT NULL DEFAULT 7,
  quorum_pct         NUMERIC(5,2) NOT NULL DEFAULT 0,
  required_majority  TEXT    NOT NULL DEFAULT 'two_thirds',
  binding            BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_helios_settings_singleton_idx
  ON finance.finance_helios_settings ((true));

-- An org unit's finance profile — one per finance-participating org unit.
CREATE TABLE IF NOT EXISTS finance.finance_unit (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- SLICE-3: kernel schema has `UNIQUE REFERENCES org_units(id) ON DELETE
  -- RESTRICT`. org_units lives in the KERNEL DB; the FK is omitted here and
  -- restored as an app-level guard + createSubOrg saga in #369 slice 3.
  org_unit_id      UUID NOT NULL UNIQUE,
  kind             TEXT NOT NULL CHECK (kind IN ('central', 'standard')),
  bookkeeping_mode TEXT NOT NULL CHECK (bookkeeping_mode IN ('central', 'own')),
  carry_over_rule  TEXT NOT NULL CHECK (carry_over_rule IN ('to_reserves', 'carry_forward')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_unit_one_central_idx
  ON finance.finance_unit ((kind)) WHERE kind = 'central';

-- ─────────────────────────────────────────────────────────────────────────
-- Section 2 — accounts & funds
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS finance.bank_account (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                  TEXT   NOT NULL,
  iban                  TEXT   NOT NULL,
  current_balance_cents BIGINT NOT NULL DEFAULT 0,
  last_sync_at          TIMESTAMPTZ,
  -- Folded from 027.
  fints_state           TEXT   NOT NULL DEFAULT 'pending_registration'
                        CONSTRAINT bank_account_fints_state_chk
                        CHECK (fints_state IN ('pending_registration', 'connected', 'error')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance.ledger_account (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  finance_unit_id BIGINT NOT NULL REFERENCES finance.finance_unit(id) ON DELETE RESTRICT,
  bank_account_id BIGINT REFERENCES finance.bank_account(id) ON DELETE RESTRICT,
  type            TEXT   NOT NULL CHECK (type IN ('own_account', 'sub_fund', 'cash_box')),
  name            TEXT   NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ledger_account_bank_backing_chk CHECK (
    (type = 'cash_box' AND bank_account_id IS NULL) OR
    (type IN ('own_account', 'sub_fund') AND bank_account_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS finance_ledger_account_finance_unit_idx
  ON finance.ledger_account (finance_unit_id);

CREATE TABLE IF NOT EXISTS finance.bank_transaction (
  id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bank_account_id             BIGINT NOT NULL REFERENCES finance.bank_account(id) ON DELETE RESTRICT,
  booking_date                DATE   NOT NULL,
  valuta_date                 DATE,
  counterparty_name           TEXT,
  counterparty_iban           TEXT,
  amount_cents                BIGINT NOT NULL,
  saldo_cents                 BIGINT,
  purpose                     TEXT,
  bank_reference              TEXT   UNIQUE,
  import_hash                 TEXT   NOT NULL,
  allocated_ledger_account_id BIGINT REFERENCES finance.ledger_account(id) ON DELETE SET NULL,
  imported_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bank_transaction_account_date_idx
  ON finance.bank_transaction (bank_account_id, booking_date);
-- Folded from 021: content-hash dedup fallback (reference-less imports).
CREATE UNIQUE INDEX IF NOT EXISTS bank_transaction_import_hash_per_account_idx
  ON finance.bank_transaction (bank_account_id, import_hash)
  WHERE bank_reference IS NULL;

CREATE TABLE IF NOT EXISTS finance.fints_config (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bank_account_id    BIGINT NOT NULL UNIQUE REFERENCES finance.bank_account(id) ON DELETE CASCADE,
  fints_url          TEXT   NOT NULL,
  bank_code          TEXT   NOT NULL,
  username           TEXT   NOT NULL,
  password_encrypted TEXT   NOT NULL,
  last_sync_at       TIMESTAMPTZ,
  last_sync_status   TEXT CHECK (last_sync_status IN ('ok', 'failed')),
  last_sync_error    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance.csv_import_profile (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bank_account_id BIGINT NOT NULL REFERENCES finance.bank_account(id) ON DELETE CASCADE,
  name            TEXT   NOT NULL,
  column_mapping  JSONB  NOT NULL,
  separator       TEXT,
  date_format     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance.reserve (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type         TEXT   NOT NULL CHECK (type IN ('frei', 'betriebsmittel', 'zweckgebunden')),
  name         TEXT   NOT NULL,
  amount_cents BIGINT NOT NULL DEFAULT 0,
  cap_cents    BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- Section 3 — budget
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS finance.fiscal_year (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT   NOT NULL,
  start_date DATE   NOT NULL,
  end_date   DATE   NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance.budget_plan (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fiscal_year_id BIGINT NOT NULL REFERENCES finance.fiscal_year(id) ON DELETE RESTRICT,
  name           TEXT   NOT NULL,
  state          TEXT   NOT NULL DEFAULT 'draft'
                 CHECK (state IN ('draft', 'under_review', 'approved', 'active', 'closed', 'rejected')),
  parent_plan_id BIGINT REFERENCES finance.budget_plan(id) ON DELETE RESTRICT,
  statement      JSONB,
  closed_at      TIMESTAMPTZ,
  approved_by    TEXT,
  approved_at    TIMESTAMPTZ,
  activated_by   TEXT,
  activated_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance.budget_section (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  budget_plan_id    BIGINT NOT NULL REFERENCES finance.budget_plan(id) ON DELETE CASCADE,
  finance_unit_id   BIGINT NOT NULL REFERENCES finance.finance_unit(id) ON DELETE RESTRICT,
  preparation_state TEXT   NOT NULL DEFAULT 'drafting'
                    CHECK (preparation_state IN ('drafting', 'submitted_to_central')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (budget_plan_id, finance_unit_id)
);

CREATE TABLE IF NOT EXISTS finance.budget_group (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  budget_section_id BIGINT NOT NULL REFERENCES finance.budget_section(id) ON DELETE CASCADE,
  name              TEXT   NOT NULL,
  budget_type       TEXT   NOT NULL CHECK (budget_type IN ('income', 'expense')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance.budget_titel (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  budget_group_id BIGINT NOT NULL REFERENCES finance.budget_group(id) ON DELETE CASCADE,
  titel_nr        TEXT,
  titel_name      TEXT   NOT NULL,
  planned_cents   BIGINT NOT NULL DEFAULT 0,
  deckungsfaehig  BOOLEAN NOT NULL DEFAULT false,
  deckungs_group  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- Section 4 — applications, expenses & receipts
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS finance.project (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- SLICE-3: kernel schema has `REFERENCES org_units(id) ON DELETE RESTRICT`.
  -- FK omitted (org_units is a kernel table); restored app-level in slice 3.
  org_unit_id UUID   NOT NULL,
  type        TEXT   NOT NULL CHECK (type IN ('internal', 'external_grant')),
  name        TEXT   NOT NULL,
  state       TEXT   NOT NULL DEFAULT 'draft'
              CHECK (state IN ('draft', 'submitted', 'approved', 'disbursed',
                               'verwendungsnachweis_pending', 'completed', 'rejected')),
  responsible TEXT,
  description TEXT,
  date_start  DATE,
  date_end    DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_project_org_unit_idx
  ON finance.project (org_unit_id);

CREATE TABLE IF NOT EXISTS finance.expense (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  finance_unit_id BIGINT NOT NULL REFERENCES finance.finance_unit(id) ON DELETE RESTRICT,
  project_id      BIGINT REFERENCES finance.project(id) ON DELETE RESTRICT,
  payee_name      TEXT   NOT NULL,
  payee_iban      TEXT,
  payee_purpose   TEXT,
  payment_method  TEXT   NOT NULL CHECK (payment_method IN ('bank_transfer', 'cash', 'cheque')),
  state           TEXT   NOT NULL DEFAULT 'draft'
                  CHECK (state IN ('draft', 'submitted', 'approved', 'paid', 'rejected')),
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_expense_finance_unit_idx
  ON finance.expense (finance_unit_id);

CREATE TABLE IF NOT EXISTS finance.receipt (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  expense_id  BIGINT NOT NULL REFERENCES finance.expense(id) ON DELETE CASCADE,
  beleg_nr    TEXT   NOT NULL,
  beleg_date  DATE   NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance.receipt_item (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_id      BIGINT NOT NULL REFERENCES finance.receipt(id) ON DELETE CASCADE,
  budget_titel_id BIGINT NOT NULL REFERENCES finance.budget_titel(id) ON DELETE RESTRICT,
  amount_cents    BIGINT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance.expense_attachment (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  expense_id     BIGINT NOT NULL REFERENCES finance.expense(id) ON DELETE CASCADE,
  kind           TEXT   NOT NULL CHECK (kind IN ('beleg', 'quittung', 'other')),
  filename       TEXT   NOT NULL,
  mime_type      TEXT,
  storage_path   TEXT   NOT NULL,
  nextcloud_path TEXT,
  uploaded_by    TEXT,
  published_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- Section 5 — bookkeeping & authorisation
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS finance.booking (
  id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ledger_account_id         BIGINT NOT NULL REFERENCES finance.ledger_account(id) ON DELETE RESTRICT,
  budget_titel_id           BIGINT NOT NULL REFERENCES finance.budget_titel(id) ON DELETE RESTRICT,
  fiscal_year_id            BIGINT NOT NULL REFERENCES finance.fiscal_year(id) ON DELETE RESTRICT,
  amount_cents              BIGINT NOT NULL,
  booking_date              DATE   NOT NULL,
  running_no                BIGINT NOT NULL,
  payment_type              TEXT   NOT NULL CHECK (payment_type IN ('bargeldlos', 'scheck', 'bar')),
  receipt_id                BIGINT REFERENCES finance.receipt(id) ON DELETE RESTRICT,
  bank_transaction_id       BIGINT REFERENCES finance.bank_transaction(id) ON DELETE RESTRICT,
  state                     TEXT   NOT NULL DEFAULT 'draft'
                            CHECK (state IN ('draft', 'posted', 'struck')),
  supersedes                BIGINT REFERENCES finance.booking(id) ON DELETE RESTRICT,
  -- Folded from 016.
  correction_fiscal_year_id BIGINT REFERENCES finance.fiscal_year(id) ON DELETE RESTRICT,
  -- Folded from 022 (GDPR/HGB retention marker).
  retention_until           TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT booking_belegprinzip_chk CHECK (
    state <> 'posted' OR receipt_id IS NOT NULL OR bank_transaction_id IS NOT NULL
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS booking_running_no_idx
  ON finance.booking (ledger_account_id, running_no);
CREATE INDEX IF NOT EXISTS booking_correction_fiscal_year_idx
  ON finance.booking (correction_fiscal_year_id) WHERE correction_fiscal_year_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS finance_booking_retention_due_idx
  ON finance.booking (retention_until) WHERE retention_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS finance_booking_budget_titel_idx
  ON finance.booking (budget_titel_id);
CREATE INDEX IF NOT EXISTS finance_booking_fiscal_year_idx
  ON finance.booking (fiscal_year_id);
CREATE INDEX IF NOT EXISTS finance_booking_actuals_covering_idx
  ON finance.booking (budget_titel_id, fiscal_year_id, state);

-- 017: per-Kassenbuch running_no allocator lock target.
CREATE TABLE IF NOT EXISTS finance.booking_running_no_head (
  ledger_account_id BIGINT NOT NULL REFERENCES finance.ledger_account(id) ON DELETE RESTRICT,
  fiscal_year_id    BIGINT NOT NULL REFERENCES finance.fiscal_year(id) ON DELETE RESTRICT,
  PRIMARY KEY (ledger_account_id, fiscal_year_id)
);

CREATE TABLE IF NOT EXISTS finance.payment_order (
  id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  expense_id                  BIGINT REFERENCES finance.expense(id) ON DELETE RESTRICT,
  anordnung_by                TEXT   NOT NULL,
  feststellung_sachlich_by    TEXT   NOT NULL,
  feststellung_rechnerisch_by TEXT   NOT NULL,
  dual_signature_attested     BOOLEAN NOT NULL DEFAULT false,
  state                       TEXT   NOT NULL DEFAULT 'pending'
                              CHECK (state IN ('pending', 'authorised', 'exported',
                                               'settled', 'voided')),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Folded from 030 (legal floor: rechnerisch certifier must differ from the
  -- orderer; VV-BHO Anhang §79 permits combining Anordnung + sachlich).
  CONSTRAINT payment_order_four_eyes_chk CHECK (
    feststellung_rechnerisch_by <> anordnung_by
  )
);
CREATE INDEX IF NOT EXISTS finance_payment_order_expense_idx
  ON finance.payment_order (expense_id);

-- 028: unified approval entity + per-stage interactive sign-off (replaces the
-- 013 finance.approval_request table, which this squash never creates).
CREATE TABLE IF NOT EXISTS finance.approval (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  approvable_type     TEXT   NOT NULL CHECK (approvable_type IN ('expense','budget_plan','project')),
  approvable_id       BIGINT NOT NULL,
  created_by          TEXT   NOT NULL,
  amount_cents        BIGINT,
  status              TEXT   NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected')),
  current_stage_index INT    NOT NULL DEFAULT 0,
  method              TEXT   NOT NULL DEFAULT 'manual' CHECK (method IN ('manual','helios')),
  rejected_by         TEXT,
  rejection_reason    TEXT,
  decided_at          TIMESTAMPTZ,
  helios_election_id  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance.approval_stage (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  approval_id     BIGINT NOT NULL REFERENCES finance.approval(id) ON DELETE CASCADE,
  stage_index     INT    NOT NULL,
  role            TEXT   NOT NULL,
  required_group  TEXT   NOT NULL,
  certifies       TEXT[] NOT NULL,
  state           TEXT   NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending','approved','rejected')),
  signer_user_id  TEXT,
  acted_at        TIMESTAMPTZ,
  note            TEXT,
  -- Folded from 036 (#164 step-up LoA proof on each decided stage).
  step_up_loa     INT,
  step_up_at      TIMESTAMPTZ,
  CONSTRAINT approval_stage_unique_idx UNIQUE (approval_id, stage_index)
);
CREATE INDEX IF NOT EXISTS idx_approval_pending
  ON finance.approval (status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_approval_stage_approval
  ON finance.approval_stage (approval_id, stage_index);

-- 031: read-side projection of approval_stage in the bundle's signers[] shape.
CREATE OR REPLACE VIEW finance.approval_signers_v AS
SELECT
  s.approval_id,
  s.stage_index,
  s.role,
  s.required_group,
  s.signer_user_id AS user_id,
  s.state,
  s.acted_at AS at,
  s.note
FROM finance.approval_stage s
ORDER BY s.approval_id, s.stage_index;

-- ─────────────────────────────────────────────────────────────────────────
-- Section 6 — assets & history
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS finance.inventory_item (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- SLICE-3: kernel schema has `REFERENCES org_units(id) ON DELETE RESTRICT`.
  -- FK omitted (org_units is a kernel table); restored app-level in slice 3.
  org_unit_id             UUID   NOT NULL,
  inventory_no            TEXT   NOT NULL,
  name                    TEXT   NOT NULL,
  acquisition_date        DATE,
  acquisition_value_cents BIGINT NOT NULL DEFAULT 0,
  disposed_at             DATE,
  disposal_resolution_ref TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_inventory_item_org_unit_idx
  ON finance.inventory_item (org_unit_id);

CREATE TABLE IF NOT EXISTS finance.cash_audit (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  audit_date DATE   NOT NULL,
  auditor    TEXT   NOT NULL,
  scope      TEXT,
  result     TEXT   NOT NULL CHECK (result IN ('passed', 'passed_with_findings', 'failed')),
  report_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance.discharge (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fiscal_year_id   BIGINT NOT NULL REFERENCES finance.fiscal_year(id) ON DELETE RESTRICT,
  finance_unit_id  BIGINT NOT NULL REFERENCES finance.finance_unit(id) ON DELETE RESTRICT,
  audit_report_ref TEXT,
  approved_by      TEXT,
  approved_at      TIMESTAMPTZ,
  -- Folded from 022 (discharge state machine).
  state            TEXT   NOT NULL DEFAULT 'proposed'
                   CHECK (state IN ('proposed', 'granted', 'denied')),
  denied_reason    TEXT,
  resolution_ref   BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (fiscal_year_id, finance_unit_id)
);

CREATE TABLE IF NOT EXISTS finance.comment (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  commentable_type TEXT   NOT NULL,
  commentable_id   BIGINT NOT NULL,
  author           TEXT   NOT NULL,
  body             TEXT   NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Folded from 026.
  CONSTRAINT comment_commentable_type_chk CHECK (commentable_type IN (
    'booking', 'expense', 'project', 'budget_plan', 'payment_order'
  ))
);
CREATE INDEX IF NOT EXISTS idx_comment_commentable
  ON finance.comment (commentable_type, commentable_id);

CREATE TABLE IF NOT EXISTS finance.reconciliation (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ledger_account_id BIGINT NOT NULL REFERENCES finance.ledger_account(id) ON DELETE RESTRICT,
  period_year       INT    NOT NULL,
  period_month      INT    NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  soll_cents        BIGINT NOT NULL,
  ist_cents         BIGINT NOT NULL,
  has_discrepancy   BOOLEAN NOT NULL DEFAULT false,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ledger_account_id, period_year, period_month)
);
