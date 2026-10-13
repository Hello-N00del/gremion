-- gremion:phase expand
-- gremion_platform, 0005 (TASK-039-FU, TASK-039 brief Q10 + Q14, R31 C1): the
-- platform job tables and the one seeded definition.
--
-- plt.scheduled_job is DB-PLT-SCHEDULED-JOB and plt.job_run is DB-PLT-JOB-RUN,
-- both verbatim from SCHEMA-gremion.md (:1842-1873, :1891-1917). job_run's
-- trigger stays BEFORE UPDATE only, as in SCHEMA: a DELETE must stay possible
-- for the retention purge (rp-plt-job-run-log), unlike the append-only 0004
-- ledgers. This unit owns the DDL of both tables; the other job kinds
-- (purge_run: TASK-033-a; backup_nightly: TASK-089) only seed rows.
--
-- The seed is the weekly footprint measurement (TRD-223): scope platform,
-- cron '0 3 * * 1' (Monday 03:00 UTC), written by the system. The host timer
-- gremion-footprint.timer fires the same moment; infra/host/ops/footprint.sh
-- writes one plt.job_run row per ISO week against this definition.
SET lock_timeout = '5s';

CREATE TABLE plt.scheduled_job (
  scheduled_job_id     uuid          NOT NULL DEFAULT uuidv7(),
  scope                text          NOT NULL,
  customer_id          uuid,
  job_kind             text          NOT NULL,
  cron_expression      text          NOT NULL,
  enabled              boolean       NOT NULL DEFAULT true,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  created_by_kind      text          NOT NULL,
  created_by           uuid,
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  updated_by_kind      text          NOT NULL,
  updated_by           uuid,
  row_version          bigint        NOT NULL DEFAULT 1,
  CONSTRAINT scheduled_job_pkey PRIMARY KEY (scheduled_job_id),
  CONSTRAINT scheduled_job_job_kind_customer_id_key UNIQUE NULLS NOT DISTINCT (job_kind, customer_id),
  CONSTRAINT scheduled_job_scheduled_job_id_check CHECK (uuid_extract_version(scheduled_job_id) = 7),
  CONSTRAINT scheduled_job_scope_check CHECK (scope IN ('platform', 'customer')
    AND (scope = 'platform') = (customer_id IS NULL)),
  CONSTRAINT scheduled_job_job_kind_check CHECK (job_kind IN ('backup_nightly', 'purge_run',
    'footprint_measurement', 'restore_drill_due', 'dpia_reminder')),
  CONSTRAINT scheduled_job_cron_expression_check
    CHECK (cron_expression ~ '^[0-9*/,-]{1,40}( [0-9*/,-]{1,40}){4}$'),
  CONSTRAINT scheduled_job_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT scheduled_job_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT scheduled_job_row_version_check CHECK (row_version > 0)
);
CREATE TRIGGER scheduled_job_touch_trg BEFORE UPDATE ON plt.scheduled_job
  FOR EACH ROW EXECUTE FUNCTION plt.touch_row();
COMMENT ON TABLE plt.scheduled_job IS 'DB-PLT-SCHEDULED-JOB | K2 | rp-plt-scheduled-job | trigger: job retired from the schedule and its runs purged';
COMMENT ON COLUMN plt.scheduled_job.customer_id IS 'xref DB-TNT-CUSTOMER; null means platform-wide (scope = platform)';

CREATE TABLE plt.job_run (
  job_run_id           uuid          NOT NULL DEFAULT uuidv7(),
  scheduled_job_id     uuid          NOT NULL,
  scope                text          NOT NULL,
  customer_id          uuid,
  scheduled_for        timestamptz   NOT NULL,
  started_at           timestamptz,
  finished_at          timestamptz   NOT NULL,
  status               text          NOT NULL,
  detail_ref           text,
  CONSTRAINT job_run_pkey PRIMARY KEY (job_run_id),
  CONSTRAINT job_run_scheduled_job_id_scheduled_for_key UNIQUE (scheduled_job_id, scheduled_for),
  CONSTRAINT job_run_job_run_id_check CHECK (uuid_extract_version(job_run_id) = 7),
  CONSTRAINT job_run_scope_check CHECK (scope IN ('platform', 'customer')
    AND (scope = 'platform') = (customer_id IS NULL)),
  CONSTRAINT job_run_status_check CHECK (status IN ('succeeded', 'failed', 'skipped')),
  CONSTRAINT job_run_started_at_check CHECK (status = 'skipped' OR started_at IS NOT NULL),
  CONSTRAINT job_run_finished_at_check CHECK (finished_at >= started_at),
  CONSTRAINT job_run_detail_ref_check CHECK (char_length(detail_ref) BETWEEN 1 AND 500),
  CONSTRAINT job_run_scheduled_job_id_fkey FOREIGN KEY (scheduled_job_id)
    REFERENCES plt.scheduled_job (scheduled_job_id) ON DELETE RESTRICT
);
CREATE INDEX job_run_finished_at_idx ON plt.job_run (finished_at);
CREATE TRIGGER job_run_append_only_trg BEFORE UPDATE ON plt.job_run
  FOR EACH ROW EXECUTE FUNCTION plt.refuse_update();
COMMENT ON TABLE plt.job_run IS 'DB-PLT-JOB-RUN | K5 | rp-plt-job-run-log | trigger: finished_at + derived application-log window';
COMMENT ON COLUMN plt.job_run.customer_id IS 'xref DB-TNT-CUSTOMER; null for a platform-wide run (scope = platform)';

-- The seeded definition (TRD-223: at least weekly, Monday 03:00 UTC).
INSERT INTO plt.scheduled_job (scope, job_kind, cron_expression, created_by_kind, updated_by_kind)
VALUES ('platform', 'footprint_measurement', '0 3 * * 1', 'system', 'system');
