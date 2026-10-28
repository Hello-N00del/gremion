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
-- @gremion/ports/erasure); the table cannot hold a `complete` header without
-- module rows, see erasure_report_complete_guard below.
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
--   DROP TRIGGER IF EXISTS erasure_report_complete_guard ON erasure_report;
--   DROP FUNCTION IF EXISTS erasure_report_complete_guard();
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
  finished_at  TIMESTAMPTZ
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
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, module_id),
  CHECK (status = 'erased' OR reason IS NOT NULL)
);

-- The honest-reporting invariant, enforced where the data lives: a header cannot
-- be set to `complete` while any module row is not `erased`, or while it has none.
CREATE OR REPLACE FUNCTION erasure_report_complete_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'complete' AND (
       NOT EXISTS (SELECT 1 FROM erasure_report_module WHERE report_id = NEW.id)
       OR EXISTS (SELECT 1 FROM erasure_report_module WHERE report_id = NEW.id AND status <> 'erased')
     ) THEN
    RAISE EXCEPTION 'erasure_report % cannot be complete: a module is not erased', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS erasure_report_complete_guard ON erasure_report;
CREATE TRIGGER erasure_report_complete_guard
  BEFORE INSERT OR UPDATE OF status ON erasure_report
  FOR EACH ROW EXECUTE FUNCTION erasure_report_complete_guard();

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
