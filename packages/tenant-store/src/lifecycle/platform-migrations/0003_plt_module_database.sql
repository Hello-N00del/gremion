-- gremion_platform, 0003: plt.module_database [A] (TASK-021 §5 Q2): the
-- visible, resumable state of one (customer, module) database, written by
-- @gremion/tenant-store/lifecycle BEFORE each destructive step (D13, TRD-424).
--   enabling  -> the database may or may not exist yet; enableModule resumes
--   enabled   -> created, owned by m_<module>, migrated to the manifest
--   disabling -> the export is being taken; the database still exists
--   dropped   -> exported, verified, recorded, and only then dropped
-- The export columns are the record of the last verified export; a row can
-- reach 'dropped' only with one (module_database_dropped_export_check), so
-- drop-before-export is refused by the database as well as by the code.
CREATE TABLE plt.module_database (
  customer_id    uuid        NOT NULL,
  module_id      uuid        NOT NULL,
  db_name        text        NOT NULL,
  state          text        NOT NULL DEFAULT 'enabling',
  export_path    text,
  export_sha256  text,
  export_bytes   bigint,
  exported_at    timestamptz,
  dropped_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  row_version    bigint      NOT NULL DEFAULT 1,
  CONSTRAINT module_database_pkey PRIMARY KEY (customer_id, module_id),
  CONSTRAINT module_database_db_name_key UNIQUE (db_name),
  CONSTRAINT module_database_db_name_check
    CHECK (db_name ~ '^t_[0-9a-f]{32}__[a-z][a-z0-9]*(_[a-z0-9]+)*$' AND octet_length(db_name) <= 63),
  CONSTRAINT module_database_state_check CHECK (state IN ('enabling', 'enabled', 'disabling', 'dropped')),
  CONSTRAINT module_database_export_check CHECK (
        (export_path IS NULL) = (export_sha256 IS NULL)
    AND (export_path IS NULL) = (export_bytes IS NULL)
    AND (export_path IS NULL) = (exported_at IS NULL)),
  CONSTRAINT module_database_export_path_check CHECK (char_length(export_path) BETWEEN 1 AND 1000),
  CONSTRAINT module_database_export_sha256_check CHECK (export_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT module_database_export_bytes_check CHECK (export_bytes > 0),
  CONSTRAINT module_database_dropped_at_check CHECK ((state = 'dropped') = (dropped_at IS NOT NULL)),
  CONSTRAINT module_database_dropped_export_check CHECK (state <> 'dropped' OR exported_at IS NOT NULL),
  CONSTRAINT module_database_row_version_check CHECK (row_version > 0),
  CONSTRAINT module_database_module_id_fkey FOREIGN KEY (module_id)
    REFERENCES plt.module (module_id) ON DELETE RESTRICT
);
CREATE INDEX module_database_module_id_idx ON plt.module_database (module_id);
CREATE TRIGGER module_database_touch_trg BEFORE UPDATE ON plt.module_database
  FOR EACH ROW EXECUTE FUNCTION plt.touch_row();
COMMENT ON TABLE plt.module_database IS 'DB-PLT-MODULE-DATABASE [A] | K2 | rp-plt-module-enablement | trigger: customer erased';
COMMENT ON COLUMN plt.module_database.customer_id IS 'xref DB-TNT-CUSTOMER';
COMMENT ON COLUMN plt.module_database.export_path IS 'where the verified pg_dump -Fc export of this database was written before its drop (TRD-424); the open-format export is TASK-091''s';
