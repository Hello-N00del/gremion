-- migrations/004_committee_elections.sql
-- B2: committee_elections bridges Helios UUIDs to gremion DB committees
-- Prerequisite: migrations/001_governance_schema.sql (A1) must have run first
-- to create the committees table.

CREATE TABLE IF NOT EXISTS committee_elections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  helios_uuid     TEXT NOT NULL UNIQUE,
  committee_id    UUID NOT NULL REFERENCES committees(id),
  created_by      UUID NOT NULL,
  calendar_linked BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS committee_elections_committee_id_idx
  ON committee_elections(committee_id);
