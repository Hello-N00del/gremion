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
-- Rollback (manual; there is no automated down):
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
