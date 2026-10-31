-- gremion:phase expand
-- 0064_module_karenz.sql
-- Karenz phase 2 (Task 7): the tenant-side tables of the 30-day module switch-off.
--
-- The authoritative clock of a switch-off is one platform row (plt.module_karenz).
-- Everything that needs the tenant (mail, chat rooms, Polls and Helios deadlines,
-- sealed records, erasure) runs here as an idempotent per-tenant pass, and this
-- migration holds what that pass remembers between runs:
--
--   module_karenz_step      the step ledger: one row per (karenz row, step), with the
--                           attempt count and the last error. platform bridge results
--                           are reported from it.
--   module_karenz_item      the external things a participant locked or archived (a
--                           Nextcloud poll, a Helios election, a chat room), with the
--                           state they had, so a switch-on can put each one back.
--   module_karenz_notice    one row per person mailed (switch-off, day 23, day 29), so
--                           a retried pass never mails the same person twice.
--   retained_record         a sealed (AES-256-GCM) read-only copy of the records a
--                           retention class obliges the council to keep, written AT
--                           switch-off. Append-only for the app role (tenant-store
--                           audit-append-only.ts revokes UPDATE, DELETE, TRUNCATE).
--   karenz_data_key         the per-tenant data keys, wrapped by a key-encryption key. The
--                           wrapped key of a sealed copy lives here and nowhere else, so a row
--                           is never deleted and "wrapped" is replaced only through
--                           karenz_rewrap_data_key() (below), never by a bare UPDATE.
--   module_karenz_erasure   Art. 17 subject ids erased while a module is off, replayed
--                           before the module comes back. Subject ids ONLY: no user
--                           name, e-mail or other personal data is stored here.
--   retained_sink_state     the per-tenant state of a publishing sink (folder and group
--                           ids), stored at creation and used from here, never found by
--                           name in a shared service.
--
-- The platform row id (karenz_id) is a uuid that lives in another database, so there
-- is no foreign key to it. Tenant-local (db-per-tenant), additive expand-only: CREATE
-- TABLE, CREATE INDEX and, on the tables this file creates, one row guard (trigger and its
-- functions). No file-level BEGIN/COMMIT: the runner wraps each file
-- and its schema_migrations insert in one transaction.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS module_karenz_step (
  karenz_id        uuid        NOT NULL,
  step             text        NOT NULL,
  state            text        NOT NULL CHECK (state IN ('pending', 'done', 'failed', 'skipped')),
  attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error       text,
  last_reported_at timestamptz,
  done_at          timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (karenz_id, step),
  -- a failed step always says why: the settings page and the ops alert read this text
  CONSTRAINT module_karenz_step_failed_error CHECK (state <> 'failed' OR last_error IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS module_karenz_item (
  item_id     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  karenz_id   uuid        NOT NULL,
  kind        text        NOT NULL,
  external_id text        NOT NULL,
  state       text        NOT NULL DEFAULT 'recorded'
                          CHECK (state IN ('recorded', 'locked', 'lock_failed', 'restored', 'unlock_failed', 'kept', 'deleted', 'gone')),
  payload     jsonb,
  detail      text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (karenz_id, kind, external_id)
);

CREATE TABLE IF NOT EXISTS module_karenz_notice (
  karenz_id  uuid        NOT NULL,
  kind       text        NOT NULL CHECK (kind IN ('switchoff', 't23', 't29')),
  user_id    text        NOT NULL,
  state      text        NOT NULL CHECK (state IN ('sent', 'failed')),
  attempts   integer     NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  sent_at    timestamptz,
  last_error text,
  PRIMARY KEY (karenz_id, kind, user_id),
  -- a notice that failed always says why (the settings page lists it)
  CONSTRAINT module_karenz_notice_failed_error CHECK (state <> 'failed' OR last_error IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS karenz_data_key (
  key_id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  wrapped     bytea       NOT NULL,
  kek_version integer     NOT NULL DEFAULT 1 CHECK (kek_version >= 1),
  created_at  timestamptz NOT NULL DEFAULT now(),
  retired_at  timestamptz
);

CREATE TABLE IF NOT EXISTS retained_record (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  karenz_id        uuid        NOT NULL,
  catalogue_id     text        NOT NULL,
  retention_class  text        NOT NULL,
  extractor_id     text        NOT NULL,
  line_count       integer     NOT NULL CHECK (line_count >= 0),
  plaintext_sha256 text        NOT NULL CHECK (plaintext_sha256 ~ '^[0-9a-f]{64}$'),
  key_id           uuid        NOT NULL REFERENCES karenz_data_key (key_id),
  nonce            bytea       NOT NULL,
  ciphertext       bytea       NOT NULL,
  -- the hashed subjectRef(tenantId, personId) values of the persons in the lines, never the ids
  subject_refs     text[]      NOT NULL DEFAULT '{}',
  hold_until       date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (karenz_id, extractor_id)
);

-- the retained-record reader looks copies up by hashed subject (redaction after an erasure)
CREATE INDEX IF NOT EXISTS retained_record_subject_refs_idx
  ON retained_record USING gin (subject_refs);

CREATE TABLE IF NOT EXISTS module_karenz_erasure (
  subject_id   text        PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS retained_sink_state (
  sink        text        PRIMARY KEY,
  external_id text        NOT NULL,
  group_id    text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A data key row is the only copy of the wrapped key of every record sealed under it. The app
-- role holds UPDATE on this table (a key is retired by stamping retired_at), so the row guard
-- below refuses what would silently destroy sealed records: deleting a row, renaming it,
-- un-retiring it, and replacing "wrapped" or kek_version by a bare UPDATE (42501). The
-- one way to replace "wrapped" is karenz_rewrap_data_key(), the AUTH_SECRET rotation step: it
-- compares the version the caller read, bumps it by exactly one, and tells the guard (a
-- transaction-local setting that names this key and is cleared again) that this UPDATE is the
-- re-wrap. This is a guard against a bug or a stray statement in the application, the same
-- honest limit as the append-only revoke on retained_record: the owner role could still drop
-- the trigger, and the reconcile verify mode is where that would be noticed.
CREATE FUNCTION karenz_data_key_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'karenz_data_key: a data key row is never deleted (every sealed copy under it would be unreadable)'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.key_id IS DISTINCT FROM OLD.key_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'karenz_data_key: key_id and created_at never change'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION 'karenz_data_key: a retired key stays retired'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.wrapped IS DISTINCT FROM OLD.wrapped OR NEW.kek_version IS DISTINCT FROM OLD.kek_version THEN
    IF pg_catalog.current_setting('gremion.karenz_rewrap', true) IS DISTINCT FROM OLD.key_id::pg_catalog.text THEN
      RAISE EXCEPTION 'karenz_data_key: wrapped and kek_version change only through karenz_rewrap_data_key()'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.kek_version <> OLD.kek_version + 1 THEN
      RAISE EXCEPTION 'karenz_data_key: a re-wrap raises kek_version by exactly one'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER karenz_data_key_guard_trg
  BEFORE UPDATE OR DELETE ON karenz_data_key
  FOR EACH ROW EXECUTE FUNCTION karenz_data_key_guard();

-- The re-wrap path (AUTH_SECRET rotation): replaces "wrapped" of one key with a value wrapped
-- under the new key-encryption key. True when the row was at p_expected_kek_version and was
-- re-wrapped, false when it was not (nothing changes, the caller re-reads and decides).
CREATE FUNCTION karenz_rewrap_data_key(p_key_id uuid, p_expected_kek_version integer, p_new_wrapped bytea)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF p_new_wrapped IS NULL OR pg_catalog.octet_length(p_new_wrapped) = 0 THEN
    RAISE EXCEPTION 'karenz_rewrap_data_key: the new wrapped key is empty'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.set_config('gremion.karenz_rewrap', p_key_id::pg_catalog.text, true);
  UPDATE public.karenz_data_key
     SET wrapped = p_new_wrapped, kek_version = kek_version + 1
   WHERE key_id = p_key_id AND kek_version = p_expected_kek_version;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_catalog.set_config('gremion.karenz_rewrap', '', true);
  RETURN n = 1;
END
$$;
