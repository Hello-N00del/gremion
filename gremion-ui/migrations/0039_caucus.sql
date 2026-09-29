-- 039_caucus.sql
-- P2.2-data (#202): orthogonal caucus/Fraktion dimension (design D1, §3.5(c)).
-- Off-by-default: zero rows = feature disabled (StuRa seeds none).
CREATE TABLE caucus (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  council_org_unit_id UUID NOT NULL REFERENCES org_units(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  color               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (council_org_unit_id, name),
  UNIQUE (id, council_org_unit_id)  -- composite FK target (D-CD)
);

-- one-faction-per-member-per-council is a plain constraint thanks to the
-- denormalized council_org_unit_id kept consistent by the composite FK.
CREATE TABLE caucus_membership (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caucus_id           UUID NOT NULL,
  council_org_unit_id UUID NOT NULL,
  user_keycloak_id    TEXT NOT NULL,
  term_start          DATE,
  term_end            DATE,
  joined_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (caucus_id, council_org_unit_id)
    REFERENCES caucus(id, council_org_unit_id) ON DELETE CASCADE,
  UNIQUE (council_org_unit_id, user_keycloak_id)
);
CREATE INDEX caucus_membership_user_idx ON caucus_membership (user_keycloak_id);
