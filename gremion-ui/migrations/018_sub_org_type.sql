-- 018_sub_org_type.sql
-- Governance metadata: a catalog of sub-org "types" (e.g. "AG", "Referat",
-- "Projektgruppe") that a sub-org (an org_unit + finance_unit pair) can be
-- classified under. Live alongside org_units in the public schema since the
-- existing org_units table also lives there (committees were renamed to
-- org_units in migration 010 and never moved into a schema).
--
-- WP-Write Task 21 (sub-org CRUD): this table is consumed by the upcoming
-- sub-org-types-db repo (Commit 2) and indirectly by finance/services/write/
-- sub-org.ts (next dispatch). Sub-orgs themselves continue to live in
-- org_units; this table only stores the catalog of available types.

CREATE TABLE sub_org_type (
  id          BIGSERIAL   PRIMARY KEY,
  name        TEXT        NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
