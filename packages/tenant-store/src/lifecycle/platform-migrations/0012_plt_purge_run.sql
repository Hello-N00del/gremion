-- gremion:phase expand
-- gremion_platform, 0012 (TRD-144 / TRD-145, TASK-033-a): the scheduled purge run.
--
-- (1) plt.job_run.detail: the run's structured outcome. The existing columns say
--     THAT a run happened (status, window, detail_ref pointer, at most 500
--     characters); the purge run has to say WHAT it deleted per retention
--     category and which customer databases failed, which a 500-character
--     pointer cannot carry. Nullable, so the footprint writer (0005) and every
--     earlier row are untouched. job_run stays BEFORE UPDATE-refusing
--     (append-only) and DELETE-able for rp-plt-job-run-log (the purge's own
--     RC-OPS-RUN rule deletes it).
-- (2) The seeded definition of the daily purge: scope platform, cron
--     '30 2 * * *' (02:30 UTC), written by the system. gremion-purge.timer fires
--     the same moment; `tenant-create purge-run` writes one plt.job_run row per
--     run against this definition. One schedule, stated once.
SET lock_timeout = '5s';

ALTER TABLE plt.job_run ADD COLUMN detail jsonb;
ALTER TABLE plt.job_run ADD CONSTRAINT job_run_detail_check
  CHECK (detail IS NULL OR (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 65536));
COMMENT ON COLUMN plt.job_run.detail IS 'the run''s structured outcome (purge_run: {categories: {<row>/<table>: deleted}, errors: [...], skipped: [...], tenants_scanned}); at most 64 KiB';

INSERT INTO plt.scheduled_job (scope, job_kind, cron_expression, created_by_kind, updated_by_kind)
VALUES ('platform', 'purge_run', '30 2 * * *', 'system', 'system');
