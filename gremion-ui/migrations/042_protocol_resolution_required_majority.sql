-- 042_protocol_resolution_required_majority.sql
-- Civitas Governance Core INV-5 (binding force from a pre-declared procedure):
-- bind each resolution to a required-majority rule, fixed at creation and validated
-- at adoption. The server computes `result` from this rule + the tallies instead of
-- trusting client-supplied free-hand input. Wrapped BEGIN/COMMIT (G-078).
BEGIN;

ALTER TABLE protocol_resolutions
  ADD COLUMN required_majority TEXT NOT NULL DEFAULT 'simple'
    CHECK (required_majority IN ('simple', 'two_thirds', 'absolute'));

COMMIT;
