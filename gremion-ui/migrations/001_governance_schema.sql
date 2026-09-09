-- 001_governance_schema.sql

CREATE TABLE committees (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  description       TEXT,
  parent_id         UUID REFERENCES committees(id) ON DELETE RESTRICT,
  visibility        TEXT NOT NULL DEFAULT 'all_members'
                    CHECK (visibility IN ('all_members', 'committee_only')),
  keycloak_group_id TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE committee_groups (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  committee_id      UUID NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT,
  keycloak_group_id TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE committee_roles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  committee_id      UUID NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  election_method   TEXT NOT NULL DEFAULT 'manual'
                    CHECK (election_method IN ('helios', 'poll', 'manual')),
  is_elected        BOOLEAN NOT NULL DEFAULT true,
  grace_period_days INT NOT NULL DEFAULT 14
);

CREATE TABLE role_assignments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id                 UUID NOT NULL REFERENCES committee_roles(id) ON DELETE CASCADE,
  user_keycloak_id        TEXT NOT NULL,
  start_date              DATE NOT NULL,
  end_date                DATE NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'grace', 'expired', 'vacated')),
  assigned_by_keycloak_id TEXT NOT NULL,
  helios_election_id      TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role_assignment_history (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id          UUID NOT NULL REFERENCES committee_roles(id) ON DELETE CASCADE,
  user_keycloak_id TEXT NOT NULL,
  start_date       DATE NOT NULL,
  end_date         DATE NOT NULL,
  ended_reason     TEXT NOT NULL
                   CHECK (ended_reason IN ('expired', 'resigned', 'removed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE committee_members (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  committee_id     UUID NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
  user_keycloak_id TEXT NOT NULL,
  group_id         UUID REFERENCES committee_groups(id) ON DELETE SET NULL,
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (committee_id, user_keycloak_id)
);

CREATE TABLE scheduled_notifications (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type                  TEXT NOT NULL
                        CHECK (type IN ('term_reminder', 'grace_start', 'grace_expiry')),
  role_assignment_id    UUID NOT NULL REFERENCES role_assignments(id) ON DELETE CASCADE,
  recipient_keycloak_id TEXT NOT NULL,
  scheduled_for         TIMESTAMPTZ NOT NULL,
  sent_at               TIMESTAMPTZ,
  failed_at             TIMESTAMPTZ,
  failure_reason        TEXT
);

CREATE TABLE sync_warnings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('committee', 'group', 'assignment')),
  entity_id    UUID NOT NULL,
  message      TEXT NOT NULL,
  is_critical  BOOLEAN NOT NULL DEFAULT false,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
