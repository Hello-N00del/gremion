-- 010_org_units.sql
-- Committee provisioning redesign: unified org-unit tree + provisioning ledger.
-- Structural-only — safe because production has 0 committees.

-- 1. committees -> org_units
ALTER TABLE committees RENAME TO org_units;
ALTER TABLE org_units ADD COLUMN kind TEXT NOT NULL DEFAULT 'committee'
  CHECK (kind IN ('council', 'committee', 'group'));
ALTER TABLE org_units ALTER COLUMN kind DROP DEFAULT;
ALTER TABLE org_units ADD COLUMN wants_matrix_room BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE org_units ADD COLUMN wants_nextcloud_folder BOOLEAN NOT NULL DEFAULT true;
-- keycloak_group_id is now redundant — the provisioning ledger owns external IDs.
ALTER TABLE org_units DROP COLUMN keycloak_group_id;

-- 2. committee_members -> org_unit_members
ALTER TABLE committee_members RENAME TO org_unit_members;
ALTER TABLE org_unit_members RENAME COLUMN committee_id TO org_unit_id;
ALTER TABLE org_unit_members DROP COLUMN group_id;
ALTER TABLE org_unit_members ADD COLUMN membership_type TEXT NOT NULL DEFAULT 'unelected'
  CHECK (membership_type IN ('elected', 'unelected', 'employee'));
ALTER TABLE org_unit_members ADD COLUMN term_start DATE;
ALTER TABLE org_unit_members ADD COLUMN term_end DATE;

-- 3. drop committee_groups (0 rows; subgroups are child org_units)
DROP TABLE committee_groups;

-- 4. re-point roles & elections (FKs auto-follow the table rename)
ALTER TABLE committee_roles RENAME COLUMN committee_id TO org_unit_id;
ALTER TABLE committee_elections RENAME COLUMN committee_id TO org_unit_id;
ALTER TABLE role_assignments ALTER COLUMN start_date DROP NOT NULL;
ALTER TABLE role_assignments ALTER COLUMN end_date DROP NOT NULL;

-- 5. provisioning ledger (single source of truth + work queue)
CREATE TABLE provisioning_resources (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_unit_id     UUID NOT NULL REFERENCES org_units(id) ON DELETE CASCADE,
  subsystem       TEXT NOT NULL CHECK (subsystem IN ('keycloak', 'matrix', 'nextcloud')),
  external_id     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'failed')),
  attempts        INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_error      TEXT,
  synced_at       TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_unit_id, subsystem)
);
CREATE INDEX provisioning_resources_due_idx
  ON provisioning_resources (next_attempt_at) WHERE status <> 'ok';

-- 6. drop sync_warnings — the ledger's status + last_error replace it
DROP TABLE sync_warnings;
