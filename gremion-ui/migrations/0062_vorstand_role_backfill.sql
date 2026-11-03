-- gremion:phase expand
-- 0062_vorstand_role_backfill.sql
-- Karenz phase 1 (Task 8): queue the standard `vorstand` realm role for the people
-- who already sit on a council's Vorstand committee.
--
-- The role itself lives in Keycloak (realm template plus the `vorstand-role`
-- reconcile check), so a migration cannot assign it. This file creates the queue
-- and fills it ONCE from the committee-name match the role replaces; the boot
-- worker drainRoleBackfill (src/lib/server/governance/vorstand-backfill.ts) applies
-- the queue and marks each row. From here on the role, not a committee's name, says
-- who is Vorstand: this INSERT is the last place the name match exists.
--
-- A committee counts when its kind is 'committee' and its display label or its name
-- is 'Vorstand'. A member counts when the term has not ended. Councils whose Vorstand
-- committee has another name queue nobody and assign the role in the member admin.
--
-- Additive expand-only; the INSERT targets the table created above in this same file.
-- No file-level BEGIN/COMMIT: the runner wraps each file and its schema_migrations
-- insert in one transaction. Re-runnable: IF NOT EXISTS and ON CONFLICT DO NOTHING.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS role_backfill (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  role             text        NOT NULL,
  user_keycloak_id text        NOT NULL,
  source           text        NOT NULL,
  queued_at        timestamptz NOT NULL DEFAULT now(),
  applied_at       timestamptz,
  last_error       text,
  attempts         int         NOT NULL DEFAULT 0,
  UNIQUE (role, user_keycloak_id)
);

CREATE INDEX IF NOT EXISTS role_backfill_pending_idx
  ON role_backfill (attempts, queued_at)
  WHERE applied_at IS NULL;

INSERT INTO role_backfill (role, user_keycloak_id, source)
SELECT DISTINCT 'vorstand', m.user_keycloak_id, 'committee-name:Vorstand'
  FROM org_units u
  JOIN org_unit_members m ON m.org_unit_id = u.id
 WHERE u.kind = 'committee'
   AND (u.kind_label = 'Vorstand' OR u.name = 'Vorstand')
   AND (m.term_end IS NULL OR m.term_end >= CURRENT_DATE)
ON CONFLICT DO NOTHING;
