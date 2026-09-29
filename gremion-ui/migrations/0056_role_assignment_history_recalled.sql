-- 056_role_assignment_history_recalled.sql
--
-- #320 Phase 3 / INV-3 recall: ending a mandate via the contestability/recall
-- channel archives the assignment with ended_reason = 'recalled' (a recorded,
-- attributable governance act — see revokeMandate in governance-db.ts, which
-- pairs the archive with a 'mandate.revoked' audit_log act in one transaction).
-- Widen the 001 CHECK constraint to accept the new reason.
--
-- Expand-only (README "Expand/contract"): a widening CHECK swap — every
-- existing row already satisfies the extended rule set.
-- No BEGIN/COMMIT (README house rule 3): the verified runner wraps this file and
-- its schema_migrations INSERT in one transaction (G-078).
--
-- Rollback (manual):
--   ALTER TABLE role_assignment_history
--     DROP CONSTRAINT role_assignment_history_ended_reason_check,
--     ADD CONSTRAINT role_assignment_history_ended_reason_check
--       CHECK (ended_reason IN ('expired', 'resigned', 'removed'));

ALTER TABLE role_assignment_history
  DROP CONSTRAINT role_assignment_history_ended_reason_check;

ALTER TABLE role_assignment_history
  ADD CONSTRAINT role_assignment_history_ended_reason_check
  CHECK (ended_reason IN ('expired', 'resigned', 'removed', 'recalled'));
