-- 038_org_unit_kind_catalog.sql
-- P2.2-data (#202): demote the closed kind taxonomy to a per-tenant reference
-- table (design §3.5(a)); add per-kind root policy (D-RB), per-unit display
-- label override (D-KL), committee authority + member voting flags (§3.5(d)).
-- Additive + one-time backfill; StuRa rendering stays byte-identical.

-- 1. per-tenant kind catalog
CREATE TABLE org_unit_kind (
  key                  TEXT PRIMARY KEY,
  label                TEXT NOT NULL,
  child_term           TEXT,
  allowed_parent_kinds TEXT[] NOT NULL DEFAULT '{}',
  can_be_root          BOOLEAN NOT NULL DEFAULT false,
  root_min             INT NOT NULL DEFAULT 0,
  root_max             INT,           -- NULL = unbounded
  sort_order           INT NOT NULL DEFAULT 0
);

-- 2. StuRa defaults (tenant #1 vocabulary; per-tenant blueprints upsert overrides)
INSERT INTO org_unit_kind
  (key, label, child_term, allowed_parent_kinds, can_be_root, root_min, root_max, sort_order)
VALUES
  ('council',   'Gremium', 'Referate',       '{}',                          true,  1, 1,    0),
  ('committee', 'Referat', 'Arbeitsgruppen', '{council,committee}',         false, 0, 0,    1),
  ('group',     'Gruppe',  NULL,             '{council,committee,group}',   true,  0, NULL, 2);

-- 3. kind: CHECK -> FK (the 010 inline column CHECK is auto-named org_units_kind_check)
ALTER TABLE org_units DROP CONSTRAINT IF EXISTS org_units_kind_check;
ALTER TABLE org_units
  ADD CONSTRAINT org_units_kind_fkey FOREIGN KEY (kind) REFERENCES org_unit_kind(key);

-- 4. per-unit display-label override (D-KL); backfill ONLY where today's
--    name-sniffed kindFriendly() output differs from the catalog label.
ALTER TABLE org_units ADD COLUMN kind_label TEXT;
UPDATE org_units SET kind_label = CASE
  WHEN kind = 'committee' AND name = 'Vorstand'                THEN 'Vorstand'
  WHEN kind = 'group'     AND lower(name) LIKE 'fachschaft%'   THEN 'Fachschaft'
  WHEN kind = 'group'     AND lower(name) LIKE 'ag %'          THEN 'AG'
  WHEN kind = 'group'     AND lower(name) LIKE 'initiative%'   THEN 'Initiative'
  ELSE NULL END;

-- 5. committee authority (beratend vs beschließend) — StuRa-compatible default
ALTER TABLE org_units ADD COLUMN authority TEXT NOT NULL DEFAULT 'deciding'
  CHECK (authority IN ('advisory', 'deciding'));

-- 6. member voting flag (sachkundige Bürger sit without a vote) — default true
ALTER TABLE org_unit_members ADD COLUMN voting BOOLEAN NOT NULL DEFAULT true;
