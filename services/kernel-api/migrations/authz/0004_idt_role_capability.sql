-- gremion:phase expand
-- kernel-api chain, authz (TASK-081): roles and capabilities. SCHEMA-gremion.md DB-IDT-*; deviations:
-- capability.module_id is NULL for the kernel idt.* capabilities (Q5); authz_grant.grant_id
-- has no DEFAULT uuidv7() (writers mint v7, TASK-079 Q5 precedent).
SET lock_timeout = '5s';

CREATE TABLE idt.role (
  role_key             text          NOT NULL,
  customer_id          uuid          NOT NULL,
  label_de             text          NOT NULL,
  label_en             text          NOT NULL,
  scope_level          text          NOT NULL,
  privileged           boolean       NOT NULL DEFAULT false,
  capability_keys      text[]        NOT NULL DEFAULT '{}',
  applicable_body_kinds text[]       NOT NULL DEFAULT '{}',
  origin               text          NOT NULL,
  state                text          NOT NULL DEFAULT 'active',
  created_at           timestamptz   NOT NULL DEFAULT now(),
  created_by_kind      text          NOT NULL,
  created_by           uuid,
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  updated_by_kind      text          NOT NULL,
  updated_by           uuid,
  row_version          bigint        NOT NULL DEFAULT 1,
  CONSTRAINT role_pkey PRIMARY KEY (role_key),
  CONSTRAINT role_role_key_check CHECK (role_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT role_label_de_check CHECK (char_length(label_de) BETWEEN 1 AND 100),
  CONSTRAINT role_label_en_check CHECK (char_length(label_en) BETWEEN 1 AND 100),
  CONSTRAINT role_scope_level_check CHECK (scope_level IN ('body', 'customer')),
  CONSTRAINT role_capability_keys_check CHECK (cardinality(capability_keys) <= 200),
  CONSTRAINT role_applicable_body_kinds_check CHECK (cardinality(applicable_body_kinds) <= 20),
  CONSTRAINT role_origin_check CHECK (origin IN ('vendor_default', 'customer_defined')),
  CONSTRAINT role_state_check CHECK (state IN ('active', 'retired')),
  CONSTRAINT role_finance_check
    CHECK (role_key <> 'finance' OR array_position(capability_keys, 'newsletter.send') IS NULL),
  CONSTRAINT role_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT role_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT role_row_version_check CHECK (row_version > 0)
);
CREATE TRIGGER role_touch_trg BEFORE UPDATE ON idt.role
  FOR EACH ROW EXECUTE FUNCTION idt.touch_row();
ALTER TABLE idt.role ENABLE ROW LEVEL SECURITY;
ALTER TABLE idt.role FORCE ROW LEVEL SECURITY;
CREATE POLICY role_tenant_pol ON idt.role
  USING (customer_id = (SELECT idt.current_customer_id()))
  WITH CHECK (customer_id = (SELECT idt.current_customer_id()));
COMMENT ON TABLE idt.role IS 'DB-IDT-ROLE | K2 | rp-idt-customer-config | trigger: customer erased; a retired role is kept while grants reference it';

CREATE TABLE idt.capability (
  capability_key       text          NOT NULL,
  customer_id          uuid          NOT NULL,
  module_id            uuid,
  manifest_version     text          NOT NULL,
  resource_kind        text,
  privileged           boolean       NOT NULL DEFAULT false,
  state                text          NOT NULL DEFAULT 'available',
  created_at           timestamptz   NOT NULL DEFAULT now(),
  created_by_kind      text          NOT NULL,
  created_by           uuid,
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  updated_by_kind      text          NOT NULL,
  updated_by           uuid,
  row_version          bigint        NOT NULL DEFAULT 1,
  CONSTRAINT capability_pkey PRIMARY KEY (capability_key),
  CONSTRAINT capability_capability_key_check
    CHECK (capability_key ~ '^[a-z][a-z_]{1,39}\.[a-z][a-z_.]{0,79}$'),
  CONSTRAINT capability_manifest_version_check
    CHECK (manifest_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]{1,40})?$'),
  CONSTRAINT capability_resource_kind_check CHECK (resource_kind ~ '^[a-z][a-z_]{0,39}$'),
  CONSTRAINT capability_state_check CHECK (state IN ('available', 'module_disabled')),
  CONSTRAINT capability_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT capability_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT capability_row_version_check CHECK (row_version > 0),
  CONSTRAINT capability_module_id_check CHECK ((module_id IS NULL) = (capability_key LIKE 'idt.%'))
);
CREATE INDEX capability_module_id_idx ON idt.capability (module_id);
CREATE TRIGGER capability_touch_trg BEFORE UPDATE ON idt.capability
  FOR EACH ROW EXECUTE FUNCTION idt.touch_row();
ALTER TABLE idt.capability ENABLE ROW LEVEL SECURITY;
ALTER TABLE idt.capability FORCE ROW LEVEL SECURITY;
CREATE POLICY capability_tenant_pol ON idt.capability
  USING (customer_id = (SELECT idt.current_customer_id()))
  WITH CHECK (customer_id = (SELECT idt.current_customer_id()));
COMMENT ON TABLE idt.capability IS 'DB-IDT-CAPABILITY | K2 | rp-idt-customer-config | trigger: customer erased, or module disabled and no grant references the capability';
COMMENT ON COLUMN idt.capability.module_id IS 'xref DB-PLT-MODULE; NULL only for the kernel idt.* capabilities (TASK-081 Q5)';
