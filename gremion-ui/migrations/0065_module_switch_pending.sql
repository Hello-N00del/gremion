-- gremion:phase expand
-- 0065_module_switch_pending.sql
-- Module self-service: a confirmed module switch that waits for the second factor.
--
-- A council admin confirms a switch on the settings page. When the session has no
-- fresh second factor, the browser leaves for the sign-in service and comes back to
-- the same page. This table keeps the confirmed switch for that round trip, so the
-- page can carry out the SAME action once the second factor is there, instead of
-- asking the admin to do it all again.
--
--   token_hash         SHA-256 (hex) of a random handle. The handle itself lives only
--                      in an HttpOnly cookie of the browser that confirmed the switch;
--                      it is never stored here.
--   idempotency_key    the key the platform request is submitted under, fixed when the
--                      switch is confirmed: a second submit of the same switch is the
--                      same platform request, never a new one.
--   user_id            the person who confirmed. Nobody else can carry the switch out.
--   armed_auth_time    the second-factor time (epoch seconds, 0 for none) of the session
--                      that confirmed. Only a session with a NEWER one carries it out.
--   payload            the confirmed input (module, action, typed name, DPIA decision).
--   expires_at         the DB clock, a few minutes after created_at. A row past it is
--                      refused and removed.
--
-- A row is single-use: it is removed by the statement that reads it (DELETE ...
-- RETURNING), whatever the outcome of the checks that follow. A person has at most
-- one row: a new confirmation replaces the earlier one. Rows past expires_at are
-- removed by the next confirmation or read in the same tenant database. Rows are
-- short-lived working state, not a record: the switch that is carried out is
-- recorded in module_switch_request and in audit_log, as before.
--
-- Tenant-local (db-per-tenant), additive expand-only. No file-level BEGIN/COMMIT:
-- the runner wraps each file and its schema_migrations insert in one transaction.
-- Inverse: DROP TABLE module_switch_pending;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS module_switch_pending (
  token_hash      text        PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key uuid        NOT NULL,
  user_id         text        NOT NULL CHECK (user_id <> ''),
  armed_auth_time bigint      NOT NULL CHECK (armed_auth_time >= 0),
  payload         jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 4096),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  -- short-lived by construction: no caller can park a switch for longer than ten minutes
  CONSTRAINT module_switch_pending_short_lived CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);

CREATE INDEX IF NOT EXISTS module_switch_pending_user_idx ON module_switch_pending (user_id);
CREATE INDEX IF NOT EXISTS module_switch_pending_expires_idx ON module_switch_pending (expires_at);
