-- gremion:phase expand
-- 0063_module_switch_request.sql
-- Karenz phase 1 (Task 10): the tenant-side record of a council module switch.
--
-- A council admin switches a feature module from the settings page. The request
-- itself lives in the platform (plt.provisioning_request, origin 'council') and
-- is run by the host executor. This table is the TENANT's own record of that
-- switch: it lets the settings page show what is pending or failed, and lets the
-- reconciler apply the result to config.modules once the platform enablement has
-- succeeded. module_id is the CATALOGUE id (what the platform knows), not the
-- manifest id (the config.modules key); gremion-ui/src/lib/modules/catalogue-map.ts
-- relates the two.
--
-- States:
--   queued     submitted, the executor has not finished it
--   succeeded  the platform finished the request, config.modules not yet applied
--   applying   a reconciler pass holds the row (claimed_at is its lease)
--   applied    config.modules follows the platform; finished
--   failed     the executor reported a failure (outcome says which)
--   refused    a gate refused the request (outcome carries the code)
--   expired    the executor never claimed the request in time
--   dead       the pass gave up after repeated errors (config_error says why)
--
-- Tenant-local (db-per-tenant), additive expand-only. No file-level BEGIN/COMMIT:
-- the runner wraps each file and its schema_migrations insert in one transaction.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS module_switch_request (
  request_id    uuid        PRIMARY KEY,
  module_id     text        NOT NULL,
  action        text        NOT NULL CHECK (action IN ('enable', 'disable')),
  actor_user_id text        NOT NULL,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  state         text        NOT NULL DEFAULT 'queued'
                            CHECK (state IN ('queued', 'succeeded', 'applying', 'applied', 'failed', 'refused', 'expired', 'dead')),
  outcome       text,
  config_error  text,
  applied_at    timestamptz,
  finished_at   timestamptz,
  notified_at   timestamptz,
  claimed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS module_switch_request_state_submitted_idx
  ON module_switch_request (state, submitted_at);
