-- 055_resolution_challenges.sql
-- #320 Phase 3 (charter §8 step 7): the contestability / recall channel.
--
-- 1. `resolution_challenges` — the standing channel by which those bound may
--    contest an adopted resolution (Pettit non-domination; the public register
--    stops being read-only). One row per raised challenge, FK'd to
--    `protocol_resolutions` ON DELETE CASCADE (a challenge has no life of its
--    own once the contested act is gone). Status machine:
--    'open' → 'upheld' | 'dismissed' | 'withdrawn'. `grounds` is mandatory and
--    bounded (1–4000 chars) — a challenge must state its grounds, and the
--    public register never renders unbounded text.
--    A partial-unique backstop allows at most ONE OPEN challenge per
--    (resolution, challenger); re-raising is possible after the previous one
--    is resolved or withdrawn.
--    `decision_note` (T2 admin disposition) is folded into the CREATE here —
--    nullable, bounded like `grounds` (1–4000 chars or NULL) — recording WHY a
--    challenge was upheld/dismissed, so the register can show the reasoning next
--    to the outcome (resolution_challenges carries the gremion_public_reader grant
--    below). A disposition without a note stays legal.
-- 2. gremion_public_reader SELECT grant in 008's idempotent DO-block form, so
--    the public Beschluss register can show challenge state (count-only).
--
-- The recall (Abwahl) half of the channel —
-- role_assignment_history.ended_reason 'recalled' — lands in its own
-- migration 056_role_assignment_history_recalled.sql (single owner per change).
--
-- Expand-only (README "Expand/contract"): a new table + new indexes only —
-- every existing row satisfies the extended rule set.
-- No BEGIN/COMMIT (README house rule 3): the verified runner already wraps this
-- file AND its schema_migrations INSERT in ONE transaction (G-078). The
-- DO-block's plpgsql delimiters below are deliberately lowercase — they are
-- block syntax, not transaction control, and the uppercase spelling is what
-- the no-BEGIN/COMMIT convention greps for.
--
-- Rollback (manual):
--   DROP TABLE resolution_challenges;  -- indexes + GRANTs fall with it

CREATE TABLE resolution_challenges (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resolution_id UUID NOT NULL REFERENCES protocol_resolutions(id) ON DELETE CASCADE,
  raised_by     TEXT NOT NULL,
  grounds       TEXT NOT NULL CHECK (char_length(grounds) BETWEEN 1 AND 4000),
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'upheld', 'dismissed', 'withdrawn')),
  resolved_by   TEXT,
  resolved_at   TIMESTAMPTZ,
  decision_note TEXT
                CHECK (decision_note IS NULL OR char_length(decision_note) BETWEEN 1 AND 4000),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Register reads are per resolution.
CREATE INDEX idx_resolution_challenges_resolution
  ON resolution_challenges (resolution_id);

-- Backstop: at most one OPEN challenge per (resolution, challenger). The
-- service layer will refuse duplicates politely; this partial-unique index is
-- the last-line defence against a double-submit race (041 precedent).
CREATE UNIQUE INDEX resolution_challenges_one_open_per_challenger
  ON resolution_challenges (resolution_id, raised_by)
  WHERE status = 'open';

-- Read-only public-portal grant (008's idempotent DO-block form). The role
-- itself is created by docker/postgres/init-databases.sh; environments without
-- it skip the GRANT with a notice.
DO $$
begin
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'gremion_public_reader') THEN
    GRANT SELECT ON resolution_challenges TO gremion_public_reader;
  ELSE
    RAISE NOTICE 'gremion_public_reader role not found — skipping GRANT. Create it via docker/postgres/init-databases.sh and re-run this migration, or grant manually.';
  END IF;
end
$$;
