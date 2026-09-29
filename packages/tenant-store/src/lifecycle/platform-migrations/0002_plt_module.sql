-- gremion_platform, 0002: DB-PLT-MODULE, DB-PLT-MODULE-VERSION and
-- DB-PLT-MODULE-ENABLEMENT, verbatim from SCHEMA-gremion.md (plt.module :1385,
-- plt.module_version :1473, plt.module_enablement :1709) with ONE named
-- deviation (TASK-021 §5 Q2): the three foreign keys to
-- plt.isolation_test_result are omitted, because TASK-044 implements
-- DB-PLT-ISOLATION-TEST-RESULT. The generated columns they key on stay, so
-- TASK-044 adds them by ALTER TABLE:
--   module_version_isol_result_id_module_id_kind_passed_fkey
--   module_enablement_isol_result_id_module_id_kind_passed_fkey
--   module_enablement_xbody_result_id_module_id_kind_passed_fkey
-- dpia_decision_id is an xref with no FK (SCHEMA §1 item 7). The level-1 gate
-- (module_enablement_gate_check, TRD-063) is in the table as specified.
CREATE TABLE plt.module (
  module_id            uuid          NOT NULL DEFAULT uuidv7(),
  module_key           text          NOT NULL,
  name                 text          NOT NULL,
  owning_context_code  text          NOT NULL,
  toggleable           boolean       NOT NULL,
  description          text,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  created_by_kind      text          NOT NULL,
  created_by           uuid,
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  updated_by_kind      text          NOT NULL,
  updated_by           uuid,
  row_version          bigint        NOT NULL DEFAULT 1,
  CONSTRAINT module_pkey PRIMARY KEY (module_id),
  CONSTRAINT module_module_key_key UNIQUE (module_key),
  CONSTRAINT module_module_id_check CHECK (uuid_extract_version(module_id) = 7),
  CONSTRAINT module_module_key_check CHECK (module_key ~ '^[a-z][a-z_]{1,39}$'),
  CONSTRAINT module_name_check CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT module_owning_context_code_check CHECK (owning_context_code IN ('tnt', 'idt', 'oac', 'gov',
    'brd', 'cal', 'fil', 'msg', 'hnd', 'pwd', 'pub', 'nws', 'mail', 'ntf', 'plt', 'ops', 'fin', 'ele')),
  CONSTRAINT module_description_check CHECK (char_length(description) BETWEEN 1 AND 2000),
  CONSTRAINT module_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT module_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT module_row_version_check CHECK (row_version > 0)
);
CREATE TRIGGER module_touch_trg BEFORE UPDATE ON plt.module
  FOR EACH ROW EXECUTE FUNCTION plt.touch_row();
COMMENT ON TABLE plt.module IS 'DB-PLT-MODULE | K2 | rp-plt-module-catalogue | trigger: module permanently withdrawn from the distribution';

CREATE TABLE plt.module_version (
  module_version_id    uuid          NOT NULL DEFAULT uuidv7(),
  module_id            uuid          NOT NULL,
  semver               text          NOT NULL,
  settings_schema_ref  text,
  settings_schema_sha256 bytea,
  retention_profile_default_id text  NOT NULL,
  isolation_test_result_id uuid,
  isolation_test_kind  text          GENERATED ALWAYS AS ('cross_customer') STORED,
  isolation_passed     boolean       GENERATED ALWAYS AS (true) STORED,
  status               text          NOT NULL DEFAULT 'draft',
  created_at           timestamptz   NOT NULL DEFAULT now(),
  created_by_kind      text          NOT NULL,
  created_by           uuid,
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  updated_by_kind      text          NOT NULL,
  updated_by           uuid,
  row_version          bigint        NOT NULL DEFAULT 1,
  CONSTRAINT module_version_pkey PRIMARY KEY (module_version_id),
  CONSTRAINT module_version_module_version_id_module_id_key UNIQUE (module_version_id, module_id),
  CONSTRAINT module_version_module_id_semver_key UNIQUE (module_id, semver),
  CONSTRAINT module_version_module_version_id_check CHECK (uuid_extract_version(module_version_id) = 7),
  CONSTRAINT module_version_semver_check
    CHECK (semver ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]{1,40})?$'),
  CONSTRAINT module_version_settings_schema_ref_check CHECK (char_length(settings_schema_ref) BETWEEN 1 AND 500),
  CONSTRAINT module_version_settings_schema_sha256_check CHECK (octet_length(settings_schema_sha256) = 32),
  CONSTRAINT module_version_settings_schema_check
    CHECK ((settings_schema_ref IS NULL) = (settings_schema_sha256 IS NULL)),
  CONSTRAINT module_version_retention_profile_default_id_check
    CHECK (retention_profile_default_id ~ '^rp-[a-z]+-[a-z0-9-]+$'),
  CONSTRAINT module_version_status_check CHECK (status IN ('draft', 'active', 'deprecated')),
  CONSTRAINT module_version_activation_check CHECK (status = 'draft' OR isolation_test_result_id IS NOT NULL),
  CONSTRAINT module_version_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT module_version_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT module_version_row_version_check CHECK (row_version > 0),
  CONSTRAINT module_version_module_id_fkey FOREIGN KEY (module_id)
    REFERENCES plt.module (module_id) ON DELETE RESTRICT
  -- omitted until TASK-044 (DB-PLT-ISOLATION-TEST-RESULT):
  -- module_version_isol_result_id_module_id_kind_passed_fkey
);
CREATE INDEX module_version_isolation_test_result_id_idx ON plt.module_version (isolation_test_result_id)
  WHERE isolation_test_result_id IS NOT NULL;
CREATE TRIGGER module_version_touch_trg BEFORE UPDATE ON plt.module_version
  FOR EACH ROW EXECUTE FUNCTION plt.touch_row();
COMMENT ON TABLE plt.module_version IS 'DB-PLT-MODULE-VERSION | K2 | rp-plt-module-version | trigger: version deprecated and no customer still runs it';
COMMENT ON COLUMN plt.module_version.retention_profile_default_id IS 'xref DB-OPS-RETENTION-PROFILE';

CREATE TABLE plt.module_enablement (
  module_enablement_id uuid          NOT NULL DEFAULT uuidv7(),
  customer_id          uuid          NOT NULL,
  module_id            uuid          NOT NULL,
  module_version_id    uuid          NOT NULL,
  state                text          NOT NULL DEFAULT 'disabled',
  enabled              boolean       GENERATED ALWAYS AS (state = 'enabled') STORED,
  isolation_test_result_id uuid,
  isolation_test_kind  text          GENERATED ALWAYS AS ('cross_customer') STORED,
  cross_body_test_result_id uuid,
  cross_body_test_kind text          GENERATED ALWAYS AS ('cross_body') STORED,
  isolation_passed     boolean       GENERATED ALWAYS AS (true) STORED,
  dpia_decision_id     uuid,
  requested_by_kind    text,
  requested_by         uuid,
  enabled_by_kind      text,
  enabled_by           uuid,
  enabled_at           timestamptz,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  created_by_kind      text          NOT NULL,
  created_by           uuid,
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  updated_by_kind      text          NOT NULL,
  updated_by           uuid,
  row_version          bigint        NOT NULL DEFAULT 1,
  CONSTRAINT module_enablement_pkey PRIMARY KEY (module_enablement_id),
  CONSTRAINT module_enablement_customer_id_module_id_key UNIQUE (customer_id, module_id),
  CONSTRAINT module_enablement_module_enablement_id_check
    CHECK (uuid_extract_version(module_enablement_id) = 7),
  CONSTRAINT module_enablement_state_check
    CHECK (state IN ('disabled', 'awaiting_isolation_test', 'test_failed', 'enabled')),
  CONSTRAINT module_enablement_requested_by_check CHECK ((requested_by_kind IS NULL) = (requested_by IS NULL)
    AND (requested_by_kind IS NULL OR requested_by_kind IN ('person', 'operator'))),
  CONSTRAINT module_enablement_enabled_by_check CHECK ((enabled_by_kind IS NULL) = (enabled_by IS NULL)
    AND (enabled_by_kind IS NULL OR enabled_by_kind IN ('person', 'operator'))),
  CONSTRAINT module_enablement_gate_check CHECK (state <> 'enabled'
    OR (isolation_test_result_id IS NOT NULL AND dpia_decision_id IS NOT NULL
        AND enabled_by IS NOT NULL AND enabled_at IS NOT NULL)),
  CONSTRAINT module_enablement_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT module_enablement_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT module_enablement_row_version_check CHECK (row_version > 0),
  CONSTRAINT module_enablement_module_id_fkey FOREIGN KEY (module_id)
    REFERENCES plt.module (module_id) ON DELETE RESTRICT,
  CONSTRAINT module_enablement_module_version_id_module_id_fkey FOREIGN KEY (module_version_id, module_id)
    REFERENCES plt.module_version (module_version_id, module_id) ON DELETE RESTRICT
  -- omitted until TASK-044 (DB-PLT-ISOLATION-TEST-RESULT):
  -- module_enablement_isol_result_id_module_id_kind_passed_fkey
  -- module_enablement_xbody_result_id_module_id_kind_passed_fkey
);
CREATE INDEX module_enablement_module_id_idx ON plt.module_enablement (module_id);
CREATE INDEX module_enablement_module_version_id_module_id_idx
  ON plt.module_enablement (module_version_id, module_id);
CREATE INDEX module_enablement_isolation_test_result_id_idx ON plt.module_enablement (isolation_test_result_id)
  WHERE isolation_test_result_id IS NOT NULL;
CREATE INDEX module_enablement_cross_body_test_result_id_idx ON plt.module_enablement (cross_body_test_result_id)
  WHERE cross_body_test_result_id IS NOT NULL;
CREATE TRIGGER module_enablement_touch_trg BEFORE UPDATE ON plt.module_enablement
  FOR EACH ROW EXECUTE FUNCTION plt.touch_row();
COMMENT ON TABLE plt.module_enablement IS 'DB-PLT-MODULE-ENABLEMENT | K2 | rp-plt-module-enablement | trigger: module disabled for that customer, or the customer erased';
COMMENT ON COLUMN plt.module_enablement.customer_id IS 'xref DB-TNT-CUSTOMER';
COMMENT ON COLUMN plt.module_enablement.dpia_decision_id IS 'xref DB-OPS-DPIA-DECISION';
COMMENT ON COLUMN plt.module_enablement.requested_by IS 'xref DB-IDT-PERSON or DB-OAC-OPERATOR by requested_by_kind';
COMMENT ON COLUMN plt.module_enablement.enabled_by IS 'xref DB-IDT-PERSON or DB-OAC-OPERATOR by enabled_by_kind';
