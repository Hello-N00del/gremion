-- gremion:phase expand
SET lock_timeout = '5s';
-- Standard infrastructure tables of one service database (SCHEMA §0.6, TASK-079):
-- binding, current_customer_id(), touch_row(), outbox, inbox, applied_aggregate_version, job.
-- Template: idt is the context code, IDT its upper-case form. Rendered by plumbingSql(ctx)
-- in @gremion/events and copied BYTE-FOR-BYTE as the first block of a service's first migration
-- (checkPlumbingMigration). Deviations from SCHEMA §0.6 [A, TASK-079 Q5]: the lint-clean form of
-- the same DDL. The RLS loop is unrolled (no anonymous block), the database-level settings and the
-- public-schema privilege change belong to database creation, and the migration ledger is the runner's.
CREATE SCHEMA IF NOT EXISTS idt;

-- database_binding has NO row level security, on purpose (SCHEMA §0.6: it is metadata about the database
-- itself, not tenant rows). It is the BOOTSTRAP of the tenant context: every transaction reads its one row
-- to learn the customer and then sets gremion.customer_id from it, so a policy keyed on
-- current_customer_id() would hide the row from exactly the read that establishes the context. The table
-- is a singleton (one customer, one context, CHECKed) written only at provisioning.
CREATE TABLE idt.database_binding (
  singleton     boolean     NOT NULL DEFAULT true,
  customer_id   uuid        NOT NULL,
  tenant_token  text        NOT NULL,
  context_code  text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT database_binding_pkey PRIMARY KEY (singleton),
  CONSTRAINT database_binding_singleton_check CHECK (singleton),
  CONSTRAINT database_binding_customer_id_check CHECK (uuid_extract_version(customer_id) = 7),
  CONSTRAINT database_binding_tenant_token_check CHECK (tenant_token ~ '^[a-z][a-z0-9_]{2,39}$'),
  CONSTRAINT database_binding_context_code_check CHECK (context_code IN ('idt', 'gov', 'brd', 'cal',
    'fil', 'msg', 'hnd', 'pwd', 'vlt', 'pub', 'nws', 'mail', 'ntf', 'fin', 'ele'))
);

CREATE FUNCTION idt.current_customer_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN nullif(current_setting('gremion.customer_id', true), '')::uuid;

CREATE FUNCTION idt.touch_row() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'customer_id and created_at are immutable (%)', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at  := now();
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END
$$;

CREATE TABLE idt.outbox (
  event_id          uuid        NOT NULL DEFAULT uuidv7(),
  customer_id       uuid        NOT NULL,
  specversion       text        NOT NULL DEFAULT '1.0',
  event_type        text        NOT NULL,
  source            text        NOT NULL,
  subject           text,
  tenantid          text        NOT NULL,
  event_time        timestamptz NOT NULL DEFAULT now(),
  datacontenttype   text        NOT NULL DEFAULT 'application/json',
  dataschema        text,
  data              jsonb       NOT NULL,
  traceparent       text,
  aggregate_type    text        NOT NULL,
  aggregate_id      uuid        NOT NULL,
  aggregate_version bigint      NOT NULL,
  test_run_id       uuid,
  relay_state       text        NOT NULL DEFAULT 'pending',
  attempt_count     integer     NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  last_error_code   text,
  published_at      timestamptz,
  dead_lettered_at  timestamptz,
  CONSTRAINT outbox_pkey PRIMARY KEY (event_id),
  CONSTRAINT outbox_event_type_aggregate_id_aggregate_version_key
    UNIQUE (event_type, aggregate_id, aggregate_version),
  CONSTRAINT outbox_event_id_check CHECK (uuid_extract_version(event_id) = 7),
  CONSTRAINT outbox_specversion_check CHECK (specversion = '1.0'),
  CONSTRAINT outbox_event_type_check
    CHECK (event_type ~ '^de\.gremion\.[a-z]+\.[a-z]+\.[a-z]+\.v[1-9][0-9]*$'),
  CONSTRAINT outbox_source_check CHECK (source ~ '^/gremion/[a-z]{2,4}$'),
  CONSTRAINT outbox_subject_check CHECK (char_length(subject) BETWEEN 1 AND 200),
  CONSTRAINT outbox_tenantid_check CHECK (tenantid = customer_id::text),
  CONSTRAINT outbox_datacontenttype_check CHECK (datacontenttype = 'application/json'),
  CONSTRAINT outbox_dataschema_check CHECK (char_length(dataschema) BETWEEN 1 AND 500),
  CONSTRAINT outbox_data_check CHECK (jsonb_typeof(data) = 'object'
    AND (data ->> 'aggregate_version') = aggregate_version::text),
  CONSTRAINT outbox_traceparent_check
    CHECK (traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'),
  CONSTRAINT outbox_aggregate_type_check CHECK (aggregate_type ~ '^[a-z]{1,40}$'),
  CONSTRAINT outbox_aggregate_version_check CHECK (aggregate_version > 0),
  CONSTRAINT outbox_relay_state_check
    CHECK (relay_state IN ('pending', 'published', 'dead_lettered')),
  CONSTRAINT outbox_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT outbox_last_error_code_check CHECK (char_length(last_error_code) BETWEEN 1 AND 64),
  CONSTRAINT outbox_state_times_check CHECK (
        (relay_state = 'pending'       AND published_at IS NULL     AND dead_lettered_at IS NULL)
     OR (relay_state = 'published'     AND published_at IS NOT NULL AND dead_lettered_at IS NULL)
     OR (relay_state = 'dead_lettered' AND published_at IS NULL     AND dead_lettered_at IS NOT NULL)),
  CONSTRAINT outbox_data_no_prose_check CHECK (NOT jsonb_path_exists(data,
    'strict $.** ? (@.type() == "string" && @ like_regex "\\s")'))
);
CREATE INDEX outbox_next_attempt_at_idx ON idt.outbox (next_attempt_at) WHERE relay_state = 'pending';
CREATE INDEX outbox_published_at_idx ON idt.outbox (published_at) WHERE relay_state = 'published';
CREATE INDEX outbox_dead_lettered_at_idx ON idt.outbox (dead_lettered_at) WHERE relay_state = 'dead_lettered';
CREATE INDEX outbox_test_run_id_idx ON idt.outbox (test_run_id) WHERE test_run_id IS NOT NULL;
CREATE INDEX outbox_aggregate_unpublished_idx ON idt.outbox (aggregate_type, aggregate_id, aggregate_version) WHERE relay_state <> 'published';

CREATE TABLE idt.inbox (
  source            text        NOT NULL,
  event_id          text        NOT NULL,
  customer_id       uuid        NOT NULL,
  event_type        text        NOT NULL,
  subject           text,
  tenantid          text        NOT NULL,
  event_time        timestamptz,
  traceparent       text,
  aggregate_type    text,
  aggregate_id      uuid,
  aggregate_version bigint,
  test_run_id       uuid,
  processing_state  text        NOT NULL DEFAULT 'received',
  attempt_count     integer     NOT NULL DEFAULT 0,
  last_error_code   text,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  dead_lettered_at  timestamptz,
  CONSTRAINT inbox_pkey PRIMARY KEY (source, event_id),
  CONSTRAINT inbox_source_check CHECK (char_length(source) BETWEEN 1 AND 200),
  CONSTRAINT inbox_event_id_check CHECK (char_length(event_id) BETWEEN 1 AND 128),
  CONSTRAINT inbox_event_type_check CHECK (char_length(event_type) BETWEEN 1 AND 200),
  CONSTRAINT inbox_subject_check CHECK (char_length(subject) BETWEEN 1 AND 200),
  CONSTRAINT inbox_tenantid_check CHECK (tenantid = customer_id::text),
  CONSTRAINT inbox_traceparent_check
    CHECK (traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'),
  CONSTRAINT inbox_aggregate_check CHECK ((aggregate_id IS NULL) = (aggregate_version IS NULL)
                                      AND (aggregate_id IS NULL) = (aggregate_type IS NULL)),
  CONSTRAINT inbox_processing_state_check CHECK (processing_state IN
    ('received', 'processed', 'skipped_stale', 'skipped_test', 'failed', 'dead_lettered')),
  CONSTRAINT inbox_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT inbox_last_error_code_check CHECK (char_length(last_error_code) BETWEEN 1 AND 64),
  CONSTRAINT inbox_state_times_check CHECK (
        (processing_state IN ('received', 'failed') AND processed_at IS NULL)
     OR (processing_state IN ('processed', 'skipped_stale', 'skipped_test') AND processed_at IS NOT NULL)
     OR (processing_state = 'dead_lettered' AND dead_lettered_at IS NOT NULL))
);
CREATE INDEX inbox_received_at_idx ON idt.inbox (received_at);
CREATE INDEX inbox_retry_idx ON idt.inbox (received_at) WHERE processing_state IN ('received', 'failed');
CREATE INDEX inbox_test_run_id_idx ON idt.inbox (test_run_id) WHERE test_run_id IS NOT NULL;

CREATE TABLE idt.applied_aggregate_version (
  source_context    text        NOT NULL,
  aggregate_type    text        NOT NULL,
  aggregate_id      uuid        NOT NULL,
  customer_id       uuid        NOT NULL,
  applied_version   bigint      NOT NULL,
  applied_event_id  text        NOT NULL,
  applied_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT applied_aggregate_version_pkey
    PRIMARY KEY (source_context, aggregate_type, aggregate_id),
  CONSTRAINT applied_aggregate_version_source_context_check CHECK (source_context ~ '^[a-z]{2,4}$'),
  CONSTRAINT applied_aggregate_version_aggregate_type_check CHECK (aggregate_type ~ '^[a-z]{1,40}$'),
  CONSTRAINT applied_aggregate_version_applied_version_check CHECK (applied_version > 0)
);

CREATE TABLE idt.job (
  job_id            uuid        NOT NULL DEFAULT uuidv7(),
  customer_id       uuid        NOT NULL,
  body_id           uuid,
  kind              text        NOT NULL,
  idempotency_key   text        NOT NULL,
  due_at            timestamptz NOT NULL,
  payload           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  state             text        NOT NULL DEFAULT 'pending',
  locked_by         text,
  locked_until      timestamptz,
  attempt           integer     NOT NULL DEFAULT 0,
  max_attempts      integer     NOT NULL DEFAULT 5,
  last_error_code   text,
  completed_at      timestamptz,
  test_run_id       uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       bigint      NOT NULL DEFAULT 1,
  CONSTRAINT job_pkey PRIMARY KEY (job_id),
  CONSTRAINT job_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT job_kind_check CHECK (kind ~ '^[a-z]+(_[a-z]+)*$' AND char_length(kind) <= 64),
  CONSTRAINT job_idempotency_key_check
    CHECK (idempotency_key ~ '^[a-z_]+:[0-9a-f-]{36}:[a-z_]+:[0-9]{9,11}$'),
  CONSTRAINT job_payload_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT job_state_check
    CHECK (state IN ('pending', 'running', 'done', 'cancelled', 'failed', 'dead')),
  CONSTRAINT job_lock_check
    CHECK ((state = 'running') = (locked_by IS NOT NULL AND locked_until IS NOT NULL)),
  CONSTRAINT job_locked_by_check CHECK (locked_by ~ '^(blue|green):[A-Za-z0-9._-]{1,100}$'),
  CONSTRAINT job_attempt_check
    CHECK (max_attempts BETWEEN 1 AND 100 AND attempt BETWEEN 0 AND max_attempts),
  CONSTRAINT job_last_error_code_check CHECK (char_length(last_error_code) BETWEEN 1 AND 64),
  CONSTRAINT job_completed_at_check
    CHECK ((state IN ('done', 'cancelled', 'dead')) = (completed_at IS NOT NULL)),
  CONSTRAINT job_row_version_check CHECK (row_version > 0)
);
CREATE INDEX job_due_at_idx ON idt.job (due_at) WHERE state IN ('pending', 'failed');
CREATE INDEX job_locked_until_idx ON idt.job (locked_until) WHERE state = 'running';
CREATE INDEX job_completed_at_idx ON idt.job (completed_at) WHERE state IN ('done', 'cancelled', 'dead');
CREATE INDEX job_body_id_idx ON idt.job (body_id) WHERE state = 'pending';
CREATE INDEX job_test_run_id_idx ON idt.job (test_run_id) WHERE test_run_id IS NOT NULL;
CREATE TRIGGER job_touch_trg BEFORE UPDATE ON idt.job
  FOR EACH ROW EXECUTE FUNCTION idt.touch_row();

ALTER TABLE idt.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE idt.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_tenant_pol ON idt.outbox USING (customer_id = (SELECT idt.current_customer_id()))
  WITH CHECK (customer_id = (SELECT idt.current_customer_id()));
ALTER TABLE idt.inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE idt.inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY inbox_tenant_pol ON idt.inbox USING (customer_id = (SELECT idt.current_customer_id()))
  WITH CHECK (customer_id = (SELECT idt.current_customer_id()));
ALTER TABLE idt.applied_aggregate_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE idt.applied_aggregate_version FORCE ROW LEVEL SECURITY;
CREATE POLICY applied_aggregate_version_tenant_pol ON idt.applied_aggregate_version
  USING (customer_id = (SELECT idt.current_customer_id()))
  WITH CHECK (customer_id = (SELECT idt.current_customer_id()));
ALTER TABLE idt.job ENABLE ROW LEVEL SECURITY;
ALTER TABLE idt.job FORCE ROW LEVEL SECURITY;
CREATE POLICY job_tenant_pol ON idt.job USING (customer_id = (SELECT idt.current_customer_id()))
  WITH CHECK (customer_id = (SELECT idt.current_customer_id()));

COMMENT ON TABLE idt.database_binding IS 'DB-IDT-BINDING | none | none | trigger: none, dropped with the database';
COMMENT ON TABLE idt.outbox IS 'DB-IDT-OUTBOX | K1 | rp-idt-plumbing | trigger: published + dedup window + inspection period';
COMMENT ON TABLE idt.inbox IS 'DB-IDT-INBOX | K1 | rp-idt-plumbing | trigger: beyond the stream redelivery horizon';
COMMENT ON TABLE idt.applied_aggregate_version IS 'DB-IDT-APPLIED-VERSION | K1 | rp-idt-plumbing | trigger: source aggregate erased';
COMMENT ON TABLE idt.job IS 'DB-IDT-JOB | K1 | rp-idt-plumbing | trigger: done, cancelled or dead + grace';
COMMENT ON COLUMN idt.job.body_id IS 'xref DB-IDT-BODY';
COMMENT ON COLUMN idt.job.test_run_id IS 'xref DB-OPS-TEST-RUN';
COMMENT ON COLUMN idt.outbox.test_run_id IS 'xref DB-OPS-TEST-RUN';
COMMENT ON COLUMN idt.inbox.test_run_id IS 'xref DB-OPS-TEST-RUN';

-- idt.refuse_delete(): the shared never-DELETE trigger function (SCHEMA §0.4).
-- refuse_update() is 0001's; touch_row() and current_customer_id() are the
-- plumbing prefix above.
CREATE FUNCTION idt.refuse_delete() RETURNS trigger
  LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION '%.% rows are never deleted', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$body$;

-- DB-IDT-ORGUNITKIND
CREATE FUNCTION idt.org_unit_kind_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.kind_key, NEW.level, NEW.is_organ) IS DISTINCT FROM (OLD.kind_key, OLD.level, OLD.is_organ) THEN
    RAISE EXCEPTION 'kind_key, level and is_organ of kind % are immutable', OLD.kind_key
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TABLE idt.org_unit_kind (
  kind_key             text          NOT NULL,
  customer_id          uuid          NOT NULL,
  level                text          NOT NULL,
  label_de             text          NOT NULL,
  label_en             text          NOT NULL,
  is_organ             boolean       NOT NULL DEFAULT false,
  can_hold_seats       boolean       NOT NULL DEFAULT false,
  may_adopt_beschluesse text         NOT NULL DEFAULT 'undecided',
  allowed_parent_kinds text[]        NOT NULL DEFAULT '{}',
  origin               text          NOT NULL,
  state                text          NOT NULL DEFAULT 'active',
  created_at           timestamptz   NOT NULL DEFAULT now(),
  created_by_kind      text          NOT NULL,
  created_by           uuid,
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  updated_by_kind      text          NOT NULL,
  updated_by           uuid,
  row_version          bigint        NOT NULL DEFAULT 1,
  CONSTRAINT org_unit_kind_pkey PRIMARY KEY (kind_key),
  CONSTRAINT org_unit_kind_kind_key_level_key UNIQUE (kind_key, level),
  CONSTRAINT org_unit_kind_kind_key_check CHECK (kind_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT org_unit_kind_level_check CHECK (level IN ('body', 'unit')),
  CONSTRAINT org_unit_kind_label_de_check CHECK (char_length(label_de) BETWEEN 1 AND 100),
  CONSTRAINT org_unit_kind_label_en_check CHECK (char_length(label_en) BETWEEN 1 AND 100),
  CONSTRAINT org_unit_kind_may_adopt_beschluesse_check
    CHECK (may_adopt_beschluesse IN ('yes', 'no', 'undecided')),
  CONSTRAINT org_unit_kind_allowed_parent_kinds_check CHECK (cardinality(allowed_parent_kinds) <= 20),
  CONSTRAINT org_unit_kind_origin_check CHECK (origin IN ('vendor_default', 'customer_defined')),
  CONSTRAINT org_unit_kind_state_check CHECK (state IN ('active', 'retired')),
  CONSTRAINT org_unit_kind_is_organ_check CHECK (NOT is_organ OR level = 'unit'),
  CONSTRAINT org_unit_kind_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT org_unit_kind_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT org_unit_kind_row_version_check CHECK (row_version > 0)
);
CREATE TRIGGER org_unit_kind_guard_trg BEFORE UPDATE ON idt.org_unit_kind
  FOR EACH ROW EXECUTE FUNCTION idt.org_unit_kind_guard();
CREATE TRIGGER org_unit_kind_touch_trg BEFORE UPDATE ON idt.org_unit_kind
  FOR EACH ROW EXECUTE FUNCTION idt.touch_row();
ALTER TABLE idt.org_unit_kind ENABLE ROW LEVEL SECURITY;
ALTER TABLE idt.org_unit_kind FORCE ROW LEVEL SECURITY;
CREATE POLICY org_unit_kind_tenant_pol ON idt.org_unit_kind
  USING (customer_id = (SELECT idt.current_customer_id()))
  WITH CHECK (customer_id = (SELECT idt.current_customer_id()));
COMMENT ON TABLE idt.org_unit_kind IS 'DB-IDT-ORGUNITKIND | K2 | rp-idt-customer-config | trigger: customer erased; a retired kind is kept while referenced';

-- DB-IDT-BODY
CREATE FUNCTION idt.body_acyclic() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_body_id IS NOT NULL AND EXISTS (
       WITH RECURSIVE up (body_id, parent_body_id) AS (
         SELECT b.body_id, b.parent_body_id FROM idt.body AS b WHERE b.body_id = NEW.parent_body_id
         UNION
         SELECT b.body_id, b.parent_body_id FROM idt.body AS b JOIN up ON b.body_id = up.parent_body_id)
       SELECT 1 FROM up WHERE up.body_id = NEW.body_id) THEN
    RAISE EXCEPTION 'body % would form a cycle', NEW.body_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TABLE idt.body (
  body_id              uuid          NOT NULL DEFAULT uuidv7(),
  customer_id          uuid          NOT NULL,
  kind_key             text          NOT NULL,
  kind_level           text          GENERATED ALWAYS AS ('body') STORED,
  name                 text          NOT NULL,
  short_name           text,
  parent_body_id       uuid,
  state                text          NOT NULL DEFAULT 'active',
  archived_at          timestamptz,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  created_by_kind      text          NOT NULL,
  created_by           uuid,
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  updated_by_kind      text          NOT NULL,
  updated_by           uuid,
  row_version          bigint        NOT NULL DEFAULT 1,
  CONSTRAINT body_pkey PRIMARY KEY (body_id),
  CONSTRAINT body_body_id_check CHECK (uuid_extract_version(body_id) = 7),
  CONSTRAINT body_name_check CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT body_short_name_check CHECK (char_length(short_name) BETWEEN 1 AND 40),
  CONSTRAINT body_state_check CHECK (state IN ('active', 'archived')),
  CONSTRAINT body_archived_at_check CHECK ((state = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT body_parent_body_id_check CHECK (parent_body_id <> body_id),
  CONSTRAINT body_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT body_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT body_row_version_check CHECK (row_version > 0),
  CONSTRAINT body_kind_key_kind_level_fkey FOREIGN KEY (kind_key, kind_level)
    REFERENCES idt.org_unit_kind (kind_key, level) ON DELETE RESTRICT,
  CONSTRAINT body_parent_body_id_fkey FOREIGN KEY (parent_body_id)
    REFERENCES idt.body (body_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX body_name_key ON idt.body (lower(name)) WHERE state = 'active';
CREATE UNIQUE INDEX body_kind_key_key ON idt.body (kind_key) WHERE kind_key = 'verwaltung';
CREATE INDEX body_kind_key_kind_level_idx ON idt.body (kind_key, kind_level);
CREATE INDEX body_parent_body_id_idx ON idt.body (parent_body_id) WHERE parent_body_id IS NOT NULL;
CREATE TRIGGER body_acyclic_trg BEFORE INSERT OR UPDATE OF parent_body_id ON idt.body
  FOR EACH ROW EXECUTE FUNCTION idt.body_acyclic();
CREATE TRIGGER body_no_delete_trg BEFORE DELETE ON idt.body
  FOR EACH ROW EXECUTE FUNCTION idt.refuse_delete();
CREATE TRIGGER body_touch_trg BEFORE UPDATE ON idt.body
  FOR EACH ROW EXECUTE FUNCTION idt.touch_row();
ALTER TABLE idt.body ENABLE ROW LEVEL SECURITY;
ALTER TABLE idt.body FORCE ROW LEVEL SECURITY;
CREATE POLICY body_tenant_pol ON idt.body
  USING (customer_id = (SELECT idt.current_customer_id()))
  WITH CHECK (customer_id = (SELECT idt.current_customer_id()));
COMMENT ON TABLE idt.body IS 'DB-IDT-BODY | K3 | rp-idt-structure | trigger: customer erased (database dropped); archived, never deleted';
COMMENT ON COLUMN idt.body.customer_id IS 'xref DB-TNT-CUSTOMER';

-- DB-IDT-ORGUNIT
CREATE FUNCTION idt.org_unit_acyclic() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_org_unit_id IS NOT NULL AND EXISTS (
       WITH RECURSIVE up (org_unit_id, parent_org_unit_id) AS (
         SELECT u.org_unit_id, u.parent_org_unit_id FROM idt.org_unit AS u
          WHERE u.org_unit_id = NEW.parent_org_unit_id
         UNION
         SELECT u.org_unit_id, u.parent_org_unit_id FROM idt.org_unit AS u
           JOIN up ON u.org_unit_id = up.parent_org_unit_id)
       SELECT 1 FROM up WHERE up.org_unit_id = NEW.org_unit_id) THEN
    RAISE EXCEPTION 'org unit % would form a cycle', NEW.org_unit_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TABLE idt.org_unit (
  org_unit_id          uuid          NOT NULL DEFAULT uuidv7(),
  customer_id          uuid          NOT NULL,
  body_id              uuid          NOT NULL,
  parent_org_unit_id   uuid,
  kind_key             text          NOT NULL,
  kind_level           text          GENERATED ALWAYS AS ('unit') STORED,
  name                 text          NOT NULL,
  state                text          NOT NULL DEFAULT 'active',
  archived_at          timestamptz,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  created_by_kind      text          NOT NULL,
  created_by           uuid,
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  updated_by_kind      text          NOT NULL,
  updated_by           uuid,
  row_version          bigint        NOT NULL DEFAULT 1,
  CONSTRAINT org_unit_pkey PRIMARY KEY (org_unit_id),
  CONSTRAINT org_unit_org_unit_id_body_id_key UNIQUE (org_unit_id, body_id),
  CONSTRAINT org_unit_org_unit_id_check CHECK (uuid_extract_version(org_unit_id) = 7),
  CONSTRAINT org_unit_name_check CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT org_unit_state_check CHECK (state IN ('active', 'archived')),
  CONSTRAINT org_unit_archived_at_check CHECK ((state = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT org_unit_parent_org_unit_id_check CHECK (parent_org_unit_id <> org_unit_id),
  CONSTRAINT org_unit_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT org_unit_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT org_unit_row_version_check CHECK (row_version > 0),
  CONSTRAINT org_unit_body_id_fkey FOREIGN KEY (body_id)
    REFERENCES idt.body (body_id) ON DELETE RESTRICT,
  CONSTRAINT org_unit_parent_org_unit_id_body_id_fkey FOREIGN KEY (parent_org_unit_id, body_id)
    REFERENCES idt.org_unit (org_unit_id, body_id) ON DELETE RESTRICT,
  CONSTRAINT org_unit_kind_key_kind_level_fkey FOREIGN KEY (kind_key, kind_level)
    REFERENCES idt.org_unit_kind (kind_key, level) ON DELETE RESTRICT
);
CREATE INDEX org_unit_body_id_idx ON idt.org_unit (body_id);
CREATE INDEX org_unit_parent_org_unit_id_body_id_idx ON idt.org_unit (parent_org_unit_id, body_id)
  WHERE parent_org_unit_id IS NOT NULL;
CREATE INDEX org_unit_kind_key_kind_level_idx ON idt.org_unit (kind_key, kind_level);
CREATE TRIGGER org_unit_acyclic_trg BEFORE INSERT OR UPDATE OF parent_org_unit_id ON idt.org_unit
  FOR EACH ROW EXECUTE FUNCTION idt.org_unit_acyclic();
CREATE TRIGGER org_unit_no_delete_trg BEFORE DELETE ON idt.org_unit
  FOR EACH ROW EXECUTE FUNCTION idt.refuse_delete();
CREATE TRIGGER org_unit_touch_trg BEFORE UPDATE ON idt.org_unit
  FOR EACH ROW EXECUTE FUNCTION idt.touch_row();
ALTER TABLE idt.org_unit ENABLE ROW LEVEL SECURITY;
ALTER TABLE idt.org_unit FORCE ROW LEVEL SECURITY;
CREATE POLICY org_unit_tenant_pol ON idt.org_unit
  USING (customer_id = (SELECT idt.current_customer_id()))
  WITH CHECK (customer_id = (SELECT idt.current_customer_id()));
COMMENT ON TABLE idt.org_unit IS 'DB-IDT-ORGUNIT | K3 | rp-idt-structure | trigger: customer erased (database dropped); archived, never deleted';

-- DB-IDT-SEAT (conferred_role_key without its FK: idt.role is TASK-081, Q3)
CREATE TABLE idt.seat (
  seat_id              uuid          NOT NULL DEFAULT uuidv7(),
  customer_id          uuid          NOT NULL,
  body_id              uuid          NOT NULL,
  org_unit_id          uuid,
  title                text          NOT NULL,
  seat_kind            text          NOT NULL,
  fill_mode            text          NOT NULL,
  delegating_body_id   uuid,
  conferred_role_key   text,
  holder_cardinality   text          NOT NULL DEFAULT 'single',
  voting               boolean       NOT NULL,
  state                text          NOT NULL DEFAULT 'active',
  retired_at           timestamptz,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  created_by_kind      text          NOT NULL,
  created_by           uuid,
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  updated_by_kind      text          NOT NULL,
  updated_by           uuid,
  row_version          bigint        NOT NULL DEFAULT 1,
  CONSTRAINT seat_pkey PRIMARY KEY (seat_id),
  CONSTRAINT seat_seat_id_body_id_holder_cardinality_key UNIQUE (seat_id, body_id, holder_cardinality),
  CONSTRAINT seat_seat_id_check CHECK (uuid_extract_version(seat_id) = 7),
  CONSTRAINT seat_title_check CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT seat_seat_kind_check CHECK (seat_kind IN ('voting_member', 'office', 'advisory')),
  CONSTRAINT seat_fill_mode_check CHECK (fill_mode IN ('direct_election', 'delegation', 'appointment')),
  CONSTRAINT seat_holder_cardinality_check CHECK (holder_cardinality IN ('single', 'multiple')),
  CONSTRAINT seat_state_check CHECK (state IN ('active', 'retired')),
  CONSTRAINT seat_retired_at_check CHECK ((state = 'retired') = (retired_at IS NOT NULL)),
  CONSTRAINT seat_delegation_check CHECK ((fill_mode = 'delegation') = (delegating_body_id IS NOT NULL)
    AND delegating_body_id IS DISTINCT FROM body_id),
  CONSTRAINT seat_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT seat_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT seat_row_version_check CHECK (row_version > 0),
  CONSTRAINT seat_body_id_fkey FOREIGN KEY (body_id) REFERENCES idt.body (body_id) ON DELETE RESTRICT,
  CONSTRAINT seat_org_unit_id_body_id_fkey FOREIGN KEY (org_unit_id, body_id)
    REFERENCES idt.org_unit (org_unit_id, body_id) ON DELETE RESTRICT,
  CONSTRAINT seat_delegating_body_id_fkey FOREIGN KEY (delegating_body_id)
    REFERENCES idt.body (body_id) ON DELETE RESTRICT
);
CREATE INDEX seat_body_id_idx ON idt.seat (body_id);
CREATE INDEX seat_org_unit_id_body_id_idx ON idt.seat (org_unit_id, body_id) WHERE org_unit_id IS NOT NULL;
CREATE INDEX seat_delegating_body_id_idx ON idt.seat (delegating_body_id) WHERE delegating_body_id IS NOT NULL;
CREATE INDEX seat_conferred_role_key_idx ON idt.seat (conferred_role_key) WHERE conferred_role_key IS NOT NULL;
CREATE TRIGGER seat_no_delete_trg BEFORE DELETE ON idt.seat
  FOR EACH ROW EXECUTE FUNCTION idt.refuse_delete();
CREATE TRIGGER seat_touch_trg BEFORE UPDATE ON idt.seat
  FOR EACH ROW EXECUTE FUNCTION idt.touch_row();
ALTER TABLE idt.seat ENABLE ROW LEVEL SECURITY;
ALTER TABLE idt.seat FORCE ROW LEVEL SECURITY;
CREATE POLICY seat_tenant_pol ON idt.seat
  USING (customer_id = (SELECT idt.current_customer_id()))
  WITH CHECK (customer_id = (SELECT idt.current_customer_id()));
COMMENT ON TABLE idt.seat IS 'DB-IDT-SEAT | K3 | rp-idt-structure | trigger: customer erased (database dropped); retired, never deleted';
