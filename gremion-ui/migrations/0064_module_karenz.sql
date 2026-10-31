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
--   karenz_data_key         the per-tenant data keys, wrapped by a key-encryption key.
--   module_karenz_erasure   Art. 17 subject ids erased while a module is off, replayed
--                           before the module comes back. Subject ids ONLY: no user
--                           name, e-mail or other personal data is stored here.
--   retained_sink_state     the per-tenant state of a publishing sink (folder and group
--                           ids), stored at creation and used from here, never found by
--                           name in a shared service.
--
-- The platform row id (karenz_id) is a uuid that lives in another database, so there
-- is no foreign key to it. Tenant-local (db-per-tenant), additive expand-only: CREATE
-- TABLE and CREATE INDEX only. No file-level BEGIN/COMMIT: the runner wraps each file
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
  PRIMARY KEY (karenz_id, step)
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
  PRIMARY KEY (karenz_id, kind, user_id)
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
