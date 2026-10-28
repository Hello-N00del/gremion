-- 0060_erasure_report.sql
-- TRD-196 / PRD-OPS-005: the per-module data-subject erasure report.
-- Tenant-local (db-per-tenant), additive expand-only, all DDL IF NOT EXISTS. No
-- file-level BEGIN/COMMIT: the runner wraps each file + its schema_migrations
-- insert in one tx. Kernel-owned and applied on every init: it references no
-- module-owned schema.
--
-- One erasure_report row per erasure run, one erasure_report_module row per
-- ENABLED module of that run. A module's status is erased | skipped | failed;
-- a module with no hook, no database connection or an unreachable database is
-- `skipped`, never `erased`. The report's overall status is `complete` only when
-- every module row is `erased` (computed by overallErasureStatus in
-- @gremion/ports/erasure); the database refuses a `complete` header unless
-- every expected module has an `erased` row, and a finished report is
-- append-only, see erasure_report_header_guard / erasure_report_module_guard.
--
-- The erased person's identifier is NEVER stored: subject_ref is
-- sha256(tenant_id || ':' || subject_id), so the report cannot re-identify them
-- (a requester who knows the id can recompute it to look the report up).
--
-- governance_membership_record (below) is where an erasure keeps a governance
-- membership as a RECORD (RC-IDT-TENURE: "record period; pseudonymised on
-- request"): an elected org_unit_members row or a caucus_membership row is
-- copied here WITHOUT any subject column and the live row is deleted. The live
-- row cannot stay with a nulled/pseudonym subject: org_unit_members drives the
-- reconcile worker's add-only member sync (it would re-add the pseudonym to the
-- Keycloak/Matrix/Nextcloud groups) and quorum/access reads.
--
-- Rollback (manual; there is no automated down):
--   DROP TABLE IF EXISTS governance_membership_record;
--   DROP TRIGGER IF EXISTS erasure_report_module_guard ON erasure_report_module;
--   DROP FUNCTION IF EXISTS erasure_report_module_guard();
--   DROP TRIGGER IF EXISTS erasure_report_header_guard ON erasure_report;
--   DROP FUNCTION IF EXISTS erasure_report_header_guard();
--   DROP TABLE IF EXISTS erasure_report_module;
--   DROP TABLE IF EXISTS erasure_report;

CREATE TABLE IF NOT EXISTS erasure_report (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT        NOT NULL,
  subject_ref  TEXT        NOT NULL CHECK (subject_ref ~ '^[0-9a-f]{64}$'),
  requested_by TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'running'
               CHECK (status IN ('running', 'complete', 'incomplete')),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  -- The module ids the run was started for; `complete` needs exactly these.
  expected_modules TEXT[] NOT NULL DEFAULT '{}',
  -- Why a run ended `incomplete` by an error or the stale-run sweep (no subject id).
  finish_reason TEXT,
  CHECK ((status = 'running') = (finished_at IS NULL)),
  CHECK (status <> 'complete' OR finish_reason IS NULL)
);

CREATE INDEX IF NOT EXISTS erasure_report_tenant_started_idx
  ON erasure_report (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS erasure_report_tenant_subject_idx
  ON erasure_report (tenant_id, subject_ref);

CREATE TABLE IF NOT EXISTS erasure_report_module (
  report_id   UUID        NOT NULL REFERENCES erasure_report(id) ON DELETE CASCADE,
  module_id   TEXT        NOT NULL,
  position    INT         NOT NULL,
  status      TEXT        NOT NULL CHECK (status IN ('erased', 'skipped', 'failed')),
  counts      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  reason      TEXT,
  -- [{table, column, rows, reason}]: subject-id columns the hook deliberately left.
  residuals   JSONB       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(residuals) = 'array'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, module_id),
  CHECK (status = 'erased' OR reason IS NOT NULL)
);

-- The honest-reporting invariants, enforced where the data lives (a caller with
-- plain DML on these tables cannot forge or rewrite a report):
--   * a header is inserted `running`; finished_at is set exactly when it is not;
--   * tenant_id, subject_ref, requested_by, started_at and expected_modules
--     never change;
--   * `complete` needs a module row for EVERY id in expected_modules (set
--     equality, non-empty) and every one of them `erased`;
--   * a module row is accepted only for an expected module of a RUNNING header;
--   * a finished report is append-only: no UPDATE or DELETE of the header or
--     of its module rows (TRUNCATE by an owner is out of scope of row triggers).
CREATE OR REPLACE FUNCTION erasure_report_header_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'running' THEN
      RAISE EXCEPTION 'erasure_report % is finished and append-only', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'running' THEN
      RAISE EXCEPTION 'erasure_report must be inserted running'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'erasure_report % is finished and append-only', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.subject_ref IS DISTINCT FROM OLD.subject_ref
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.expected_modules IS DISTINCT FROM OLD.expected_modules THEN
    RAISE EXCEPTION 'erasure_report % identity columns are immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'complete' AND (
       cardinality(NEW.expected_modules) = 0
       OR EXISTS (SELECT 1 FROM erasure_report_module WHERE report_id = NEW.id AND status <> 'erased')
       OR (SELECT coalesce(array_agg(DISTINCT module_id ORDER BY module_id), '{}')
             FROM erasure_report_module WHERE report_id = NEW.id)
          IS DISTINCT FROM
          (SELECT coalesce(array_agg(DISTINCT m ORDER BY m), '{}') FROM unnest(NEW.expected_modules) AS m)
     ) THEN
    RAISE EXCEPTION 'erasure_report % cannot be complete: a module is not erased', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS erasure_report_header_guard ON erasure_report;
CREATE TRIGGER erasure_report_header_guard
  BEFORE INSERT OR UPDATE OR DELETE ON erasure_report
  FOR EACH ROW EXECUTE FUNCTION erasure_report_header_guard();

CREATE OR REPLACE FUNCTION erasure_report_module_guard() RETURNS trigger AS $$
DECLARE
  rid    UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.report_id ELSE NEW.report_id END;
  parent erasure_report%ROWTYPE;
BEGIN
  -- FOR SHARE: a concurrent finish of the header waits for (or blocks) this row.
  SELECT * INTO parent FROM erasure_report WHERE id = rid FOR SHARE;
  IF NOT FOUND THEN
    -- DELETE: the cascade from deleting a (running) header; INSERT/UPDATE: the FK refuses.
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF parent.status <> 'running' THEN
    RAISE EXCEPTION 'erasure_report % is finished and append-only', rid
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.report_id IS DISTINCT FROM OLD.report_id
                           OR NEW.module_id IS DISTINCT FROM OLD.module_id) THEN
    RAISE EXCEPTION 'erasure_report_module identity columns are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (NEW.module_id = ANY (parent.expected_modules)) THEN
    RAISE EXCEPTION 'erasure_report %: % is not an expected module', rid, NEW.module_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS erasure_report_module_guard ON erasure_report_module;
CREATE TRIGGER erasure_report_module_guard
  BEFORE INSERT OR UPDATE OR DELETE ON erasure_report_module
  FOR EACH ROW EXECUTE FUNCTION erasure_report_module_guard();

-- A pseudonymised governance-membership record (written by the kernel erasure
-- step only). No subject column by construction: the seat/term survives, the
-- person does not. org_unit_id is the unit (org_unit_members) or the council
-- (caucus_membership); the record goes with the unit, like role_assignment_history
-- goes with its committee_roles row.
CREATE TABLE IF NOT EXISTS governance_membership_record (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source          TEXT        NOT NULL CHECK (source IN ('org_unit_members', 'caucus_membership')),
  org_unit_id     UUID        NOT NULL REFERENCES org_units(id) ON DELETE CASCADE,
  caucus_id       UUID,
  membership_type TEXT,
  voting          BOOLEAN,
  term_start      DATE,
  term_end        DATE,
  joined_at       TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_reason    TEXT        NOT NULL DEFAULT 'erased' CHECK (ended_reason = 'erased'),
  CHECK ((source = 'caucus_membership') = (caucus_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS governance_membership_record_unit_idx
  ON governance_membership_record (org_unit_id);
