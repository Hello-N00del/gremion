-- 054_resolution_adoption_mode.sql
-- #320 Phase 2 (T1): acclamation-aware adoption for protocol resolutions.
--
-- Adds `adoption_mode` ('tally' | 'acclamation', DEFAULT 'tally' — every
-- pre-054 row IS a counted tally), makes the three vote-tally columns
-- NULLABLE, and enforces the vote/mode CHECK matrix in the DB:
--   * 'tally' rows must carry ALL THREE tallies (votes_yes/no/abstain NOT NULL);
--   * 'acclamation' rows carry either NO tallies (pure acclamation) or ALL
--     THREE (acclamation with a recorded count) — a partial tally is never
--     storable in either mode.
-- Extends the required_majority rule set (042) with 'consent' and
-- 'support_threshold', and adds `decision_rule_params` JSONB (nullable,
-- DEFAULT NULL): free-form per-rule parameters (e.g. a support-threshold
-- ratio), interpreted at the service layer.
--
-- NOTE: required_majority is INERT for acclamation rows. An acclamation
-- decision is adopted without a counted majority, so the column is retained
-- only as declarative metadata on such rows — the server never evaluates the
-- rule for adoption_mode = 'acclamation'.
--
-- Expand-only (README "Expand/contract"): additive columns, a NOT NULL drop
-- (widening), and a CHECK extension. Every existing row satisfies the new
-- matrix (all tallies NOT NULL + adoption_mode defaulting to 'tally').
-- No BEGIN/COMMIT (README house rule 3): the verified runner already wraps this
-- file AND its schema_migrations INSERT in ONE transaction (G-078); an explicit
-- COMMIT here would split that atomic applied-but-recorded pair. (042 carries a
-- standalone BEGIN/COMMIT — that is the deprecated pattern the README says not to
-- copy, not a precedent to follow.)
--
-- Rollback (manual):
--   ALTER TABLE protocol_resolutions
--     DROP CONSTRAINT protocol_resolutions_votes_mode_check,
--     DROP COLUMN adoption_mode,
--     DROP COLUMN decision_rule_params,
--     ALTER COLUMN votes_yes SET NOT NULL,
--     ALTER COLUMN votes_no SET NOT NULL,
--     ALTER COLUMN votes_abstain SET NOT NULL;
--   ALTER TABLE protocol_resolutions
--     DROP CONSTRAINT protocol_resolutions_required_majority_check,
--     ADD CONSTRAINT protocol_resolutions_required_majority_check
--       CHECK (required_majority IN ('simple', 'two_thirds', 'absolute'));

ALTER TABLE protocol_resolutions
  ALTER COLUMN votes_yes DROP NOT NULL,
  ALTER COLUMN votes_no DROP NOT NULL,
  ALTER COLUMN votes_abstain DROP NOT NULL,
  ADD COLUMN adoption_mode TEXT NOT NULL DEFAULT 'tally'
    CHECK (adoption_mode IN ('tally', 'acclamation')),
  ADD COLUMN decision_rule_params JSONB;

-- 042 named this inline column CHECK implicitly; extend it under the same name.
ALTER TABLE protocol_resolutions
  DROP CONSTRAINT protocol_resolutions_required_majority_check,
  ADD CONSTRAINT protocol_resolutions_required_majority_check
    CHECK (required_majority IN ('simple', 'two_thirds', 'absolute', 'consent', 'support_threshold'));

-- The vote/mode matrix (validated against existing rows on ADD).
ALTER TABLE protocol_resolutions
  ADD CONSTRAINT protocol_resolutions_votes_mode_check CHECK (
    (adoption_mode = 'tally'
      AND votes_yes IS NOT NULL AND votes_no IS NOT NULL AND votes_abstain IS NOT NULL)
    OR
    (adoption_mode = 'acclamation'
      AND ((votes_yes IS NULL AND votes_no IS NULL AND votes_abstain IS NULL)
        OR (votes_yes IS NOT NULL AND votes_no IS NOT NULL AND votes_abstain IS NOT NULL)))
  );
