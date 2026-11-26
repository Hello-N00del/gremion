-- gremion:phase expand
-- 0067_protocol_approval.sql
-- Minutes: who submitted a protocol and who approved (published) it, with the times.
--
-- Publishing minutes needs a second person: the person who approves is not the person who
-- submitted, and not the person who created the protocol. The server decides that from
-- these two pairs of columns.
--
--   submitted_by / submitted_at   set when the protocol leaves 'draft' for 'submitted'
--   approved_by  / approved_at    set when the protocol goes 'submitted' -> 'published'
--
-- The *_by columns hold a Keycloak user id (text, like created_by), never a name: names are
-- resolved live where they are shown.
--
-- Additive, nullable, no default. Protocols that were submitted or published before this
-- migration keep NULL in all four columns; nothing is backfilled, so their state stays as it
-- was. An older copy of the app does not know the columns and never touches them.
-- Tenant-local (db-per-tenant). No file-level BEGIN/COMMIT: the runner wraps each file.
-- Inverse: ALTER TABLE protocols DROP COLUMN submitted_by, DROP COLUMN submitted_at,
--          DROP COLUMN approved_by, DROP COLUMN approved_at;
SET LOCAL lock_timeout = '5s';

ALTER TABLE protocols
  ADD COLUMN IF NOT EXISTS submitted_by text,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by  text,
  ADD COLUMN IF NOT EXISTS approved_at  timestamptz;
