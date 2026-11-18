-- gremion:phase expand
-- 0066_board_location.sql
-- Board: where a customer's board data lives.
--
-- A board is stored either in this database (the tables board, stack, card) or in the
-- board module's own database. Which of the two serves a customer is one fact, kept in
-- this one-row table, so every running copy of the app reads the same answer and no copy
-- needs to be told by a restart or a setting.
--
--   location     kernel  the board lives here (every customer before a move, and the default)
--                moving  a move is running: reads still come from here, writes are refused
--                        for the few seconds the copy takes
--                module  the board lives in the module database
--   changed_at   when the location last changed. While a move runs it is refreshed every
--                30 seconds; a 'moving' row that has not been refreshed for 300 seconds is
--                the trace of a move that died and is read as 'kernel'.
--   moved_state  at the flip: the row counts and one fingerprint per board table of this
--                database, as hashes and numbers only (no names, no ids). Written by the
--                move, never by the app.
--
-- ONE row at most (id is the constant true). NO row means 'kernel': this migration inserts
-- none, so a customer that was never moved has nothing to read and nothing to clean up.
-- The app only reads this table; the move writes it. An older copy of the app does not know
-- the table and simply never touches it.
--
-- Tenant-local (db-per-tenant), additive expand-only. No file-level BEGIN/COMMIT: the
-- runner wraps each file and its schema_migrations insert in one transaction.
-- Inverse: DROP TABLE board_location;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS board_location (
  id          boolean     PRIMARY KEY DEFAULT true CHECK (id),
  location    text        NOT NULL DEFAULT 'kernel' CHECK (location IN ('kernel', 'moving', 'module')),
  changed_at  timestamptz NOT NULL DEFAULT now(),
  moved_state jsonb       CHECK (moved_state IS NULL OR jsonb_typeof(moved_state) = 'object')
);
