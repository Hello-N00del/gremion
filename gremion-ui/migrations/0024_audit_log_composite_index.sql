-- gremion-ui/migrations/024_audit_log_composite_index.sql
-- G-076: the audit-trail-by-field query (Stage 1 M-§5.1-A pattern) filters
-- on `field = $1` and orders by `created_at DESC`. The two single-column
-- indexes from 009_audit_log.sql can only serve one half of that predicate;
-- a composite (field, created_at DESC) lets the planner index-scan straight
-- to the most-recent rows for a given field without a separate sort.
--
-- Pre-flight (against dev postgres 2026-05-27): the existing indexes on
-- audit_log are not dropped — keeping them avoids regressing any query that
-- filters on `field` alone or scans `created_at` across all fields.

CREATE INDEX IF NOT EXISTS idx_audit_log_field_created_at
  ON audit_log (field, created_at DESC);
