-- migrations/007_protocols.sql
-- B4: Meeting Minutes — all protocol tables
-- Prerequisites: 001_governance_schema.sql (committees)
-- Uses keycloak_id TEXT pattern (no users table — identities live in Keycloak)

CREATE TABLE protocols (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  committee_id             UUID NOT NULL REFERENCES committees(id),
  meeting_date             DATE NOT NULL,
  location                 TEXT,
  title                    TEXT NOT NULL,
  body_html                TEXT,
  nextcloud_draft_path     TEXT,
  nextcloud_published_path TEXT,
  status                   TEXT NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'submitted', 'published')),
  guest_edit_enabled       BOOLEAN NOT NULL DEFAULT false,
  approval_poll_id         TEXT,
  revision_notes           TEXT,
  created_by               TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX protocols_committee_id_idx ON protocols(committee_id);
CREATE INDEX protocols_status_idx ON protocols(status);
CREATE INDEX protocols_meeting_date_idx ON protocols(meeting_date);

CREATE TABLE protocol_attendance (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol_id       UUID NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
  user_keycloak_id  TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('present', 'absent', 'excused')),
  UNIQUE (protocol_id, user_keycloak_id)
);

-- Resolutions (Beschluesse) -- always structured, never parsed from prose
-- sequence_nr: per-protocol ordering (1, 2, 3...)
-- global_nr: set on publish -- format B-{year}-{NNN} scoped to committee
CREATE TABLE protocol_resolutions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol_id   UUID NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
  sequence_nr   INT NOT NULL,
  global_nr     TEXT,
  text          TEXT NOT NULL,
  votes_yes     INT NOT NULL DEFAULT 0,
  votes_no      INT NOT NULL DEFAULT 0,
  votes_abstain INT NOT NULL DEFAULT 0,
  result        TEXT NOT NULL CHECK (result IN ('passed', 'rejected', 'withdrawn')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (protocol_id, sequence_nr)
);

CREATE TABLE protocol_action_items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol_id           UUID NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
  assignee_keycloak_id  TEXT,
  text                  TEXT NOT NULL,
  due_date              DATE,
  completed             BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE beschluss_register_settings (
  committee_id        UUID PRIMARY KEY REFERENCES committees(id) ON DELETE CASCADE,
  include_protocols   BOOLEAN NOT NULL DEFAULT true,
  include_polls       BOOLEAN NOT NULL DEFAULT true,
  include_elections   BOOLEAN NOT NULL DEFAULT true
);
