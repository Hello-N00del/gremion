-- P0.3a: durable membership-remove outbox + time-based terminal for the resource ledger.
-- The resource ledger (provisioning_resources) is keyed (org_unit_id, subsystem) with one
-- row, so it cannot represent N pending per-(unit,user,subsystem) member ops. This table is
-- the remove-op outbox the reconcile worker drains. No tenant_id: Pillar-2 silos per tenant DB.
CREATE TABLE provisioning_member_ops (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_unit_id      UUID NOT NULL REFERENCES org_units(id) ON DELETE CASCADE,
  user_keycloak_id TEXT NOT NULL,
  subsystem        TEXT NOT NULL CHECK (subsystem IN ('keycloak', 'matrix', 'nextcloud')),
  op               TEXT NOT NULL CHECK (op IN ('remove')),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'failed')),
  attempts         INT  NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ,
  first_failed_at  TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX provisioning_member_ops_due_idx ON provisioning_member_ops (created_at) WHERE status <> 'ok';

-- Time-based terminal-failure clock for the resource ledger (P0.3a design §5.6).
ALTER TABLE provisioning_resources ADD COLUMN first_failed_at TIMESTAMPTZ;
