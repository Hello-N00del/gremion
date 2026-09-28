-- 041_protocol_resolution_global_nr_unique.sql
-- #235 (defect 2): committee+year-scoped uniqueness BACKSTOP on
-- protocol_resolutions.global_nr.
--
-- The official Beschluss number (global_nr, format `B-{year}-{NNN}`) is scoped
-- to a committee. The publish flow now assigns these numbers sequentially inside
-- one transaction (assignGlobalNrs), which prevents the duplicate-numbering race
-- that previously handed every resolution in a protocol the SAME number. This
-- migration adds the last line of defence at the schema level so a future code
-- path, a concurrent publish, or a manual edit can never persist two identical
-- official numbers within the same committee.
--
-- protocol_resolutions has no committee_id of its own (it lives on the parent
-- protocols row), and a partial UNIQUE index cannot reach across a join. We
-- therefore denormalise committee_id onto the resolution row and keep it correct
-- with a BEFORE INSERT/UPDATE trigger that copies it from the parent protocol —
-- so application code (addResolution, updateResolution) needs no change and the
-- column can never drift. The year is already encoded inside global_nr itself,
-- so a UNIQUE over (committee_id, global_nr) is implicitly committee+year-scoped
-- (different years yield different global_nr strings).
--
-- BEGIN/COMMIT wraps the whole change so the column add + backfill + trigger +
-- index land atomically (G-078). All steps are IF [NOT] EXISTS / OR REPLACE so a
-- partial replay is safe.

BEGIN;

-- 1. Denormalised committee_id (nullable; populated by backfill + trigger below).
--    FK targets org_units: the `committees` table was renamed to `org_units` in
--    migration 010 (committee-provisioning redesign), so a `REFERENCES committees`
--    here fails with "relation committees does not exist" on every DB past 010.
ALTER TABLE protocol_resolutions
  ADD COLUMN IF NOT EXISTS committee_id UUID REFERENCES org_units(id);

-- 2. Backfill existing rows from the parent protocol.
UPDATE protocol_resolutions r
  SET committee_id = p.committee_id
  FROM protocols p
  WHERE p.id = r.protocol_id
    AND r.committee_id IS DISTINCT FROM p.committee_id;

-- 3. Keep committee_id in lock-step with the parent protocol's committee. The
--    resolution's committee is wholly derived from its protocol, so we always
--    overwrite from the parent rather than trusting any supplied value.
CREATE OR REPLACE FUNCTION protocol_resolution_set_committee_id()
RETURNS TRIGGER AS $$
BEGIN
  SELECT p.committee_id INTO NEW.committee_id
  FROM protocols p
  WHERE p.id = NEW.protocol_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS protocol_resolution_set_committee_id_trg ON protocol_resolutions;
CREATE TRIGGER protocol_resolution_set_committee_id_trg
  BEFORE INSERT OR UPDATE OF protocol_id ON protocol_resolutions
  FOR EACH ROW
  EXECUTE FUNCTION protocol_resolution_set_committee_id();

-- 4. The backstop: at most one resolution per committee may carry a given
--    official number. Partial (WHERE global_nr IS NOT NULL) so the many
--    not-yet-published resolutions (NULL global_nr) are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS protocol_resolutions_committee_global_nr_uniq
  ON protocol_resolutions (committee_id, global_nr)
  WHERE global_nr IS NOT NULL;

COMMIT;
