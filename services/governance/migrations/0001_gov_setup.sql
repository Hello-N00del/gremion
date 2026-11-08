-- gremion:phase expand
SET lock_timeout = '5s';
-- Standard infrastructure tables of one service database (SCHEMA §0.6, TASK-079):
-- binding, current_customer_id(), touch_row(), outbox, inbox, applied_aggregate_version, job.
-- Template: gov is the context code, GOV its upper-case form. Rendered by plumbingSql(ctx)
-- in @gremion/events and copied BYTE-FOR-BYTE as the first block of a service's first migration
-- (checkPlumbingMigration). Deviations from SCHEMA §0.6 [A, TASK-079 Q5]: the lint-clean form of
-- the same DDL. The RLS loop is unrolled (no anonymous block), the database-level settings and the
-- public-schema privilege change belong to database creation, and the migration ledger is the runner's.
CREATE SCHEMA IF NOT EXISTS gov;

-- database_binding has NO row level security, on purpose (SCHEMA §0.6: it is metadata about the database
-- itself, not tenant rows). It is the BOOTSTRAP of the tenant context: every transaction reads its one row
-- to learn the customer and then sets gremion.customer_id from it, so a policy keyed on
-- current_customer_id() would hide the row from exactly the read that establishes the context. The table
-- is a singleton (one customer, one context, CHECKed) written only at provisioning.
CREATE TABLE gov.database_binding (
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

CREATE FUNCTION gov.current_customer_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN nullif(current_setting('gremion.customer_id', true), '')::uuid;

CREATE FUNCTION gov.touch_row() RETURNS trigger
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

CREATE TABLE gov.outbox (
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
CREATE INDEX outbox_next_attempt_at_idx ON gov.outbox (next_attempt_at) WHERE relay_state = 'pending';
CREATE INDEX outbox_published_at_idx ON gov.outbox (published_at) WHERE relay_state = 'published';
CREATE INDEX outbox_dead_lettered_at_idx ON gov.outbox (dead_lettered_at) WHERE relay_state = 'dead_lettered';
CREATE INDEX outbox_test_run_id_idx ON gov.outbox (test_run_id) WHERE test_run_id IS NOT NULL;
CREATE INDEX outbox_aggregate_unpublished_idx ON gov.outbox (aggregate_type, aggregate_id, aggregate_version) WHERE relay_state <> 'published';

CREATE TABLE gov.inbox (
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
        (processing_state IN ('received', 'failed') AND processed_at IS NULL     AND dead_lettered_at IS NULL)
     OR (processing_state IN ('processed', 'skipped_stale', 'skipped_test')
                                                     AND processed_at IS NOT NULL AND dead_lettered_at IS NULL)
     OR (processing_state = 'dead_lettered'          AND processed_at IS NULL     AND dead_lettered_at IS NOT NULL))
);
CREATE INDEX inbox_received_at_idx ON gov.inbox (received_at);
CREATE INDEX inbox_retry_idx ON gov.inbox (received_at) WHERE processing_state IN ('received', 'failed');
CREATE INDEX inbox_test_run_id_idx ON gov.inbox (test_run_id) WHERE test_run_id IS NOT NULL;

CREATE TABLE gov.applied_aggregate_version (
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

CREATE TABLE gov.job (
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
CREATE INDEX job_due_at_idx ON gov.job (due_at) WHERE state IN ('pending', 'failed');
CREATE INDEX job_locked_until_idx ON gov.job (locked_until) WHERE state = 'running';
CREATE INDEX job_completed_at_idx ON gov.job (completed_at) WHERE state IN ('done', 'cancelled', 'dead');
CREATE INDEX job_body_id_idx ON gov.job (body_id) WHERE state = 'pending';
CREATE INDEX job_test_run_id_idx ON gov.job (test_run_id) WHERE test_run_id IS NOT NULL;
CREATE TRIGGER job_touch_trg BEFORE UPDATE ON gov.job
  FOR EACH ROW EXECUTE FUNCTION gov.touch_row();

ALTER TABLE gov.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_tenant_pol ON gov.outbox USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));
ALTER TABLE gov.inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY inbox_tenant_pol ON gov.inbox USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));
ALTER TABLE gov.applied_aggregate_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.applied_aggregate_version FORCE ROW LEVEL SECURITY;
CREATE POLICY applied_aggregate_version_tenant_pol ON gov.applied_aggregate_version
  USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));
ALTER TABLE gov.job ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.job FORCE ROW LEVEL SECURITY;
CREATE POLICY job_tenant_pol ON gov.job USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));

COMMENT ON TABLE gov.database_binding IS 'DB-GOV-BINDING | none | none | trigger: none, dropped with the database';
COMMENT ON TABLE gov.outbox IS 'DB-GOV-OUTBOX | K1 | rp-gov-plumbing | trigger: published + dedup window + inspection period';
COMMENT ON TABLE gov.inbox IS 'DB-GOV-INBOX | K1 | rp-gov-plumbing | trigger: beyond the stream redelivery horizon';
COMMENT ON TABLE gov.applied_aggregate_version IS 'DB-GOV-APPLIED-VERSION | K1 | rp-gov-plumbing | trigger: source aggregate erased';
COMMENT ON TABLE gov.job IS 'DB-GOV-JOB | K1 | rp-gov-plumbing | trigger: done, cancelled or dead + grace';
COMMENT ON COLUMN gov.job.body_id IS 'xref DB-IDT-BODY';
COMMENT ON COLUMN gov.job.test_run_id IS 'xref DB-OPS-TEST-RUN';
COMMENT ON COLUMN gov.outbox.test_run_id IS 'xref DB-OPS-TEST-RUN';
COMMENT ON COLUMN gov.inbox.test_run_id IS 'xref DB-OPS-TEST-RUN';

CREATE FUNCTION gov.root_keys_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.body_id IS DISTINCT FROM OLD.body_id
     OR NEW.test_run_id IS DISTINCT FROM OLD.test_run_id THEN
    RAISE EXCEPTION 'body_id and test_run_id are immutable (%)', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION gov.erasure_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_old        jsonb;
  v_new        jsonb := to_jsonb(NEW);
  v_erasable   text[] := TG_ARGV[1:TG_NARGS - 1];
  v_changed    text[];
  v_redaction  uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF v_new ->> 'erased_at' IS NOT NULL THEN
      RAISE EXCEPTION 'a row is never inserted as erased (%)', TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  v_old := to_jsonb(OLD);
  SELECT coalesce(array_agg(k ORDER BY k), '{}') INTO v_changed
    FROM jsonb_object_keys(v_new) AS k
   WHERE k <> 'erased_at'
     AND (v_new -> k) IS DISTINCT FROM (v_old -> k)
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a
                      WHERE a.attrelid = TG_RELID AND a.attname = k AND a.attgenerated <> '');
  IF cardinality(v_erasable) = 0 OR cardinality(v_changed) = 0
     OR NOT v_changed <@ v_erasable
     OR EXISTS (SELECT 1 FROM unnest(v_changed) AS c WHERE v_new -> c <> 'null'::jsonb)
     OR v_new ->> 'erased_at' IS NULL THEN
    RAISE EXCEPTION '% is append-only; only an erasure of % to NULL, with erased_at set, is allowed',
      TG_TABLE_NAME, v_erasable USING ERRCODE = 'check_violation';
  END IF;
  v_redaction := nullif(current_setting('gremion.redaction_id', true), '')::uuid;
  IF v_redaction IS NULL
     OR NOT gov.redaction_covers(v_redaction, TG_TABLE_NAME, v_old ->> TG_ARGV[0], v_changed) THEN
    RAISE EXCEPTION 'erasure on % needs an active redaction that lists this row and these columns',
      TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

CREATE TABLE gov.body_ref (
  body_ref_id             bigint       GENERATED ALWAYS AS IDENTITY,
  customer_id             uuid         NOT NULL,
  body_id                 uuid         NOT NULL,
  org_unit_id             uuid,
  name                    text         NOT NULL,
  kind_key                text         NOT NULL,
  is_organ                boolean      NOT NULL DEFAULT false,
  archived                boolean      NOT NULL DEFAULT false,
  voting_seat_count       integer      NOT NULL DEFAULT 0,
  current_wahlperiode_id  uuid,
  wp_start                date,
  wp_end                  date,
  wp_state                text,
  form_of_address         text         NOT NULL DEFAULT 'du',
  default_locale          text         NOT NULL DEFAULT 'de',
  time_zone               text,
  active_branding_id      uuid,
  palette_version         text,
  created_at              timestamptz  NOT NULL DEFAULT now(),
  created_by_kind         text         NOT NULL DEFAULT 'system',
  created_by              uuid,
  updated_at              timestamptz  NOT NULL DEFAULT now(),
  updated_by_kind         text         NOT NULL DEFAULT 'system',
  updated_by              uuid,
  row_version             bigint       NOT NULL DEFAULT 1,
  CONSTRAINT body_ref_pkey PRIMARY KEY (body_ref_id),
  CONSTRAINT body_ref_body_id_org_unit_id_key UNIQUE NULLS NOT DISTINCT (body_id, org_unit_id),
  CONSTRAINT body_ref_name_check CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT body_ref_kind_key_check CHECK (kind_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT body_ref_voting_seat_count_check CHECK (voting_seat_count BETWEEN 0 AND 10000),
  CONSTRAINT body_ref_wp_state_check CHECK (wp_state IN ('planned', 'current', 'closed')),
  CONSTRAINT body_ref_wahlperiode_check CHECK ((current_wahlperiode_id IS NULL) = (wp_state IS NULL)
    AND (current_wahlperiode_id IS NULL) = (wp_start IS NULL) AND wp_end >= wp_start),
  CONSTRAINT body_ref_form_of_address_check CHECK (form_of_address IN ('du', 'sie')),
  CONSTRAINT body_ref_default_locale_check CHECK (default_locale IN ('de', 'en')),
  CONSTRAINT body_ref_time_zone_check CHECK (char_length(time_zone) BETWEEN 1 AND 64
    AND time_zone ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+){0,2}$'),
  CONSTRAINT body_ref_palette_version_check
    CHECK (palette_version ~ '^[0-9]{1,4}(\.[0-9]{1,4}){0,2}$'),
  CONSTRAINT body_ref_branding_check CHECK ((active_branding_id IS NULL) = (palette_version IS NULL)),
  CONSTRAINT body_ref_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT body_ref_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT body_ref_row_version_check CHECK (row_version > 0)
);
CREATE INDEX body_ref_org_unit_id_idx ON gov.body_ref (org_unit_id) WHERE org_unit_id IS NOT NULL;
CREATE TRIGGER body_ref_touch_trg BEFORE UPDATE ON gov.body_ref
  FOR EACH ROW EXECUTE FUNCTION gov.touch_row();
ALTER TABLE gov.body_ref ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.body_ref FORCE ROW LEVEL SECURITY;
CREATE POLICY body_ref_tenant_pol ON gov.body_ref
  USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));
COMMENT ON TABLE gov.body_ref IS 'DB-GOV-BODY-REF | K2 | rp-gov-projection | trigger: body archived + grace';
COMMENT ON COLUMN gov.body_ref.body_id IS 'xref DB-IDT-BODY';
COMMENT ON COLUMN gov.body_ref.org_unit_id IS 'xref DB-IDT-ORGUNIT';
COMMENT ON COLUMN gov.body_ref.current_wahlperiode_id IS 'xref DB-IDT-WAHLPERIODE';
COMMENT ON COLUMN gov.body_ref.active_branding_id IS 'xref DB-IDT-BRANDING';

CREATE TABLE gov.member_ref (
  member_ref_id           bigint       GENERATED ALWAYS AS IDENTITY,
  customer_id             uuid         NOT NULL,
  body_id                 uuid         NOT NULL,
  person_id               uuid         NOT NULL,
  org_unit_id             uuid,
  membership_id           uuid         NOT NULL,
  seat_id                 uuid,
  tenure_id               uuid,
  seat_kind               text,
  voting_right            boolean      NOT NULL DEFAULT false,
  term_start              date         NOT NULL,
  term_end                date,
  display_name            text,
  display_name_stale      boolean      NOT NULL DEFAULT false,
  account_disabled        boolean      NOT NULL DEFAULT false,
  wahlperiode_warning     boolean      NOT NULL DEFAULT false,
  created_at              timestamptz  NOT NULL DEFAULT now(),
  created_by_kind         text         NOT NULL DEFAULT 'system',
  created_by              uuid,
  updated_at              timestamptz  NOT NULL DEFAULT now(),
  updated_by_kind         text         NOT NULL DEFAULT 'system',
  updated_by              uuid,
  row_version             bigint       NOT NULL DEFAULT 1,
  CONSTRAINT member_ref_pkey PRIMARY KEY (member_ref_id),
  CONSTRAINT member_ref_membership_id_key UNIQUE (membership_id),
  CONSTRAINT member_ref_seat_kind_check CHECK (seat_kind IN ('voting_member', 'office', 'advisory')),
  CONSTRAINT member_ref_tenure_check CHECK ((tenure_id IS NULL) OR (seat_id IS NOT NULL)),
  CONSTRAINT member_ref_term_check CHECK (term_end >= term_start),
  CONSTRAINT member_ref_display_name_check CHECK (char_length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT member_ref_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT member_ref_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT member_ref_row_version_check CHECK (row_version > 0)
);
CREATE INDEX member_ref_person_id_idx ON gov.member_ref (person_id);
CREATE INDEX member_ref_body_id_org_unit_id_idx ON gov.member_ref (body_id, org_unit_id)
  WHERE voting_right;
CREATE TRIGGER member_ref_touch_trg BEFORE UPDATE ON gov.member_ref
  FOR EACH ROW EXECUTE FUNCTION gov.touch_row();
ALTER TABLE gov.member_ref ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.member_ref FORCE ROW LEVEL SECURITY;
CREATE POLICY member_ref_tenant_pol ON gov.member_ref
  USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));
COMMENT ON TABLE gov.member_ref IS 'DB-GOV-MEMBER-REF | K2 | rp-gov-projection | trigger: term ended + grace, or person erased';
COMMENT ON COLUMN gov.member_ref.body_id IS 'xref DB-IDT-BODY';
COMMENT ON COLUMN gov.member_ref.person_id IS 'xref DB-IDT-PERSON';
COMMENT ON COLUMN gov.member_ref.org_unit_id IS 'xref DB-IDT-ORGUNIT';
COMMENT ON COLUMN gov.member_ref.membership_id IS 'xref DB-IDT-MEMBERSHIP';
COMMENT ON COLUMN gov.member_ref.seat_id IS 'xref DB-IDT-SEAT';
COMMENT ON COLUMN gov.member_ref.tenure_id IS 'xref DB-IDT-TENURE';

CREATE TABLE gov.body_settings (
  body_settings_id              uuid         NOT NULL DEFAULT uuidv7(),
  customer_id                   uuid         NOT NULL,
  body_id                       uuid         NOT NULL,
  org_unit_id                   uuid,
  notice_period_days            integer      NOT NULL,
  motion_deadline_offset_hours  integer      NOT NULL,
  public_motion_intake          boolean      NOT NULL DEFAULT false,
  circular_enabled              boolean      NOT NULL DEFAULT false,
  open_poll_enabled             boolean      NOT NULL DEFAULT false,
  secret_poll_enabled           boolean      NOT NULL DEFAULT false,
  register_nonpublic_display    text         NOT NULL DEFAULT 'omit',
  release_roles                 text[]       NOT NULL DEFAULT ARRAY['chair', 'protocol_taker']::text[],
  valid_from                    timestamptz  NOT NULL DEFAULT now(),
  created_at                    timestamptz  NOT NULL DEFAULT now(),
  created_by_kind               text         NOT NULL,
  created_by                    uuid,
  CONSTRAINT body_settings_pkey PRIMARY KEY (body_settings_id),
  CONSTRAINT body_settings_body_id_org_unit_id_valid_from_key
    UNIQUE NULLS NOT DISTINCT (body_id, org_unit_id, valid_from),
  CONSTRAINT body_settings_body_settings_id_check CHECK (uuid_extract_version(body_settings_id) = 7),
  CONSTRAINT body_settings_notice_period_days_check CHECK (notice_period_days BETWEEN 0 AND 365),
  CONSTRAINT body_settings_motion_deadline_offset_hours_check
    CHECK (motion_deadline_offset_hours BETWEEN 0 AND 8760),
  CONSTRAINT body_settings_register_nonpublic_display_check
    CHECK (register_nonpublic_display IN ('omit', 'placeholder')),
  CONSTRAINT body_settings_release_roles_check CHECK (cardinality(release_roles) BETWEEN 1 AND 2
    AND release_roles <@ ARRAY['chair', 'protocol_taker']::text[]),
  CONSTRAINT body_settings_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL))
);
CREATE TRIGGER body_settings_append_only_trg BEFORE INSERT OR UPDATE ON gov.body_settings
  FOR EACH ROW EXECUTE FUNCTION gov.erasure_guard('body_settings_id');
ALTER TABLE gov.body_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.body_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY body_settings_tenant_pol ON gov.body_settings
  USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));
COMMENT ON TABLE gov.body_settings IS 'DB-GOV-BODY-SETTINGS | K2 | rp-gov-body-config | trigger: body archived + grace';
COMMENT ON COLUMN gov.body_settings.body_id IS 'xref DB-IDT-BODY';
COMMENT ON COLUMN gov.body_settings.org_unit_id IS 'xref DB-IDT-ORGUNIT';
COMMENT ON COLUMN gov.body_settings.created_by IS 'xref DB-IDT-PERSON or DB-OAC-OPERATOR by created_by_kind';

CREATE TABLE gov.curing_basis (
  curing_basis_id     uuid         NOT NULL DEFAULT uuidv7(),
  customer_id         uuid         NOT NULL,
  body_id             uuid         NOT NULL,
  org_unit_id         uuid,
  version             integer      NOT NULL,
  basis_text          text         NOT NULL,
  source_citation     text         NOT NULL,
  valid_from          timestamptz  NOT NULL DEFAULT now(),
  created_at          timestamptz  NOT NULL DEFAULT now(),
  created_by_kind     text         NOT NULL,
  created_by          uuid,
  CONSTRAINT curing_basis_pkey PRIMARY KEY (curing_basis_id),
  CONSTRAINT curing_basis_curing_basis_id_version_body_id_key UNIQUE (curing_basis_id, version, body_id),
  CONSTRAINT curing_basis_body_id_org_unit_id_version_key
    UNIQUE NULLS NOT DISTINCT (body_id, org_unit_id, version),
  CONSTRAINT curing_basis_curing_basis_id_check CHECK (uuid_extract_version(curing_basis_id) = 7),
  CONSTRAINT curing_basis_version_check CHECK (version > 0),
  CONSTRAINT curing_basis_basis_text_check CHECK (char_length(basis_text) BETWEEN 1 AND 10000),
  CONSTRAINT curing_basis_source_citation_check CHECK (char_length(source_citation) BETWEEN 1 AND 500),
  CONSTRAINT curing_basis_created_by_check CHECK (created_by_kind = 'person' AND created_by IS NOT NULL)
);
CREATE TRIGGER curing_basis_append_only_trg BEFORE INSERT OR UPDATE ON gov.curing_basis
  FOR EACH ROW EXECUTE FUNCTION gov.erasure_guard('curing_basis_id');
ALTER TABLE gov.curing_basis ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.curing_basis FORCE ROW LEVEL SECURITY;
CREATE POLICY curing_basis_tenant_pol ON gov.curing_basis
  USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));
COMMENT ON TABLE gov.curing_basis IS 'DB-GOV-CURING-BASIS | K3 | rp-gov-resolution-record | trigger: no notice_override references the version';
COMMENT ON COLUMN gov.curing_basis.body_id IS 'xref DB-IDT-BODY';
COMMENT ON COLUMN gov.curing_basis.org_unit_id IS 'xref DB-IDT-ORGUNIT';
COMMENT ON COLUMN gov.curing_basis.created_by IS 'xref DB-IDT-PERSON (set_by_person_id)';

CREATE TABLE gov.meeting (
  meeting_id                   uuid         NOT NULL DEFAULT uuidv7(),
  customer_id                  uuid         NOT NULL,
  body_id                      uuid         NOT NULL,
  org_unit_id                  uuid,
  wahlperiode_id               uuid,
  meeting_number               integer,
  title                        text         NOT NULL,
  content_language             text         NOT NULL DEFAULT 'de',
  scheduled_start              timestamptz  NOT NULL,
  scheduled_end                timestamptz,
  location                     text,
  call_link_id                 uuid,
  state                        text         NOT NULL DEFAULT 'planned',
  notice_period_days_snapshot  integer      NOT NULL,
  notice_due_at                timestamptz  NOT NULL,
  motion_deadline_at           timestamptz,
  opened_at                    timestamptz,
  closed_at                    timestamptz,
  cancel_reason                text,
  test_run_id                  uuid,
  is_test                      boolean      GENERATED ALWAYS AS (test_run_id IS NOT NULL) STORED,
  title_vector                 tsvector     GENERATED ALWAYS AS (to_tsvector(
                                 CASE content_language WHEN 'en' THEN 'english'::regconfig
                                                       ELSE 'german'::regconfig END, title)) STORED,
  created_at                   timestamptz  NOT NULL DEFAULT now(),
  created_by_kind              text         NOT NULL,
  created_by                   uuid,
  updated_at                   timestamptz  NOT NULL DEFAULT now(),
  updated_by_kind              text         NOT NULL,
  updated_by                   uuid,
  row_version                  bigint       NOT NULL DEFAULT 1,
  CONSTRAINT meeting_pkey PRIMARY KEY (meeting_id),
  CONSTRAINT meeting_meeting_id_body_id_key UNIQUE (meeting_id, body_id),
  CONSTRAINT meeting_meeting_id_check CHECK (uuid_extract_version(meeting_id) = 7),
  CONSTRAINT meeting_meeting_number_check CHECK (meeting_number BETWEEN 1 AND 100000),
  CONSTRAINT meeting_title_check CHECK (char_length(title) BETWEEN 1 AND 300),
  CONSTRAINT meeting_content_language_check CHECK (content_language IN ('de', 'en')),
  CONSTRAINT meeting_scheduled_end_check CHECK (scheduled_end > scheduled_start),
  CONSTRAINT meeting_location_check CHECK (char_length(location) BETWEEN 1 AND 500),
  CONSTRAINT meeting_state_check CHECK (state IN ('planned', 'invited', 'in_session', 'suspended',
    'closed', 'cancelled')),
  CONSTRAINT meeting_notice_period_days_snapshot_check CHECK (notice_period_days_snapshot BETWEEN 0 AND 365),
  CONSTRAINT meeting_notice_due_at_check CHECK (notice_due_at <= scheduled_start),
  CONSTRAINT meeting_motion_deadline_at_check CHECK (motion_deadline_at <= scheduled_start),
  CONSTRAINT meeting_opened_at_check
    CHECK ((state IN ('in_session', 'suspended', 'closed')) = (opened_at IS NOT NULL)),
  CONSTRAINT meeting_closed_at_check
    CHECK ((state = 'closed') = (closed_at IS NOT NULL) AND closed_at >= opened_at),
  CONSTRAINT meeting_cancel_reason_check CHECK (cancel_reason IN ('chair_cancelled', 'body_archived',
    'org_unit_archived', 'customer_offboarding')),
  CONSTRAINT meeting_cancelled_check CHECK ((state = 'cancelled') = (cancel_reason IS NOT NULL)),
  CONSTRAINT meeting_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT meeting_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT meeting_row_version_check CHECK (row_version > 0)
);
CREATE INDEX meeting_body_id_scheduled_start_idx ON gov.meeting (body_id, scheduled_start);
CREATE INDEX meeting_org_unit_id_scheduled_start_idx ON gov.meeting (org_unit_id, scheduled_start)
  WHERE org_unit_id IS NOT NULL;
CREATE INDEX meeting_test_run_id_idx ON gov.meeting (test_run_id) WHERE test_run_id IS NOT NULL;
CREATE TRIGGER meeting_touch_trg BEFORE UPDATE ON gov.meeting
  FOR EACH ROW EXECUTE FUNCTION gov.touch_row();
CREATE TRIGGER meeting_root_keys_trg BEFORE UPDATE ON gov.meeting
  FOR EACH ROW EXECUTE FUNCTION gov.root_keys_immutable();
ALTER TABLE gov.meeting ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.meeting FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_tenant_pol ON gov.meeting
  USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));
COMMENT ON TABLE gov.meeting IS 'DB-GOV-MEETING | K3 | rp-gov-meeting-record | trigger: meeting closed; test rows hard-deleted by test_run_id';
COMMENT ON COLUMN gov.meeting.body_id IS 'xref DB-IDT-BODY';
COMMENT ON COLUMN gov.meeting.org_unit_id IS 'xref DB-IDT-ORGUNIT';
COMMENT ON COLUMN gov.meeting.wahlperiode_id IS 'xref DB-IDT-WAHLPERIODE';
COMMENT ON COLUMN gov.meeting.call_link_id IS 'xref DB-MSG-CALL_LINK';
COMMENT ON COLUMN gov.meeting.test_run_id IS 'xref DB-OPS-TEST-RUN';
COMMENT ON COLUMN gov.meeting.created_by IS 'xref DB-IDT-PERSON or DB-OAC-OPERATOR by created_by_kind';
COMMENT ON COLUMN gov.meeting.updated_by IS 'xref DB-IDT-PERSON or DB-OAC-OPERATOR by updated_by_kind';

CREATE TABLE gov.agenda_section (
  agenda_section_id   bigint       GENERATED ALWAYS AS IDENTITY,
  customer_id         uuid         NOT NULL,
  body_id             uuid         NOT NULL,
  meeting_id          uuid         NOT NULL,
  position            integer      NOT NULL,
  title               text         NOT NULL,
  publication_class   text         NOT NULL DEFAULT 'non_public',
  created_at          timestamptz  NOT NULL DEFAULT now(),
  created_by_kind     text         NOT NULL,
  created_by          uuid,
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  updated_by_kind     text         NOT NULL,
  updated_by          uuid,
  row_version         bigint       NOT NULL DEFAULT 1,
  CONSTRAINT agenda_section_pkey PRIMARY KEY (agenda_section_id),
  CONSTRAINT agenda_section_agenda_section_id_meeting_id_key UNIQUE (agenda_section_id, meeting_id),
  CONSTRAINT agenda_section_meeting_id_position_key UNIQUE (meeting_id, position)
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT agenda_section_meeting_id_body_id_fkey FOREIGN KEY (meeting_id, body_id)
    REFERENCES gov.meeting (meeting_id, body_id) ON DELETE CASCADE,
  CONSTRAINT agenda_section_position_check CHECK (position BETWEEN 1 AND 1000),
  CONSTRAINT agenda_section_title_check CHECK (char_length(title) BETWEEN 1 AND 300),
  CONSTRAINT agenda_section_publication_class_check CHECK (publication_class IN ('public', 'non_public')),
  CONSTRAINT agenda_section_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT agenda_section_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT agenda_section_row_version_check CHECK (row_version > 0)
);
CREATE INDEX agenda_section_meeting_id_body_id_idx ON gov.agenda_section (meeting_id, body_id);
CREATE TRIGGER agenda_section_touch_trg BEFORE UPDATE ON gov.agenda_section
  FOR EACH ROW EXECUTE FUNCTION gov.touch_row();
ALTER TABLE gov.agenda_section ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.agenda_section FORCE ROW LEVEL SECURITY;
CREATE POLICY agenda_section_tenant_pol ON gov.agenda_section
  USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));
COMMENT ON TABLE gov.agenda_section IS 'DB-GOV-AGENDA-SECTION | K3 | rp-gov-meeting-record | trigger: with its meeting';
COMMENT ON COLUMN gov.agenda_section.body_id IS 'xref DB-IDT-BODY';

CREATE TABLE gov.agenda_item (
  agenda_item_id         uuid         NOT NULL DEFAULT uuidv7(),
  customer_id            uuid         NOT NULL,
  body_id                uuid         NOT NULL,
  meeting_id             uuid         NOT NULL,
  agenda_section_id      bigint,
  position               integer,
  item_number            text,
  title                  text         NOT NULL,
  description            text,
  content_language       text         NOT NULL DEFAULT 'de',
  kind                   text         NOT NULL DEFAULT 'misc',
  own_publication_class  text,
  state                  text         NOT NULL DEFAULT 'proposed',
  proposer_person_id     uuid,
  outcome                text,
  retention_profile_id   text         GENERATED ALWAYS AS (CASE WHEN agenda_section_id IS NULL
                           THEN 'rp-gov-proposal-unplaced' ELSE 'rp-gov-meeting-record' END) STORED,
  item_vector            tsvector     GENERATED ALWAYS AS (to_tsvector(
                           CASE content_language WHEN 'en' THEN 'english'::regconfig
                                                 ELSE 'german'::regconfig END,
                           title || ' ' || coalesce(description, ''))) STORED,
  created_at             timestamptz  NOT NULL DEFAULT now(),
  created_by_kind        text         NOT NULL,
  created_by             uuid,
  updated_at             timestamptz  NOT NULL DEFAULT now(),
  updated_by_kind        text         NOT NULL,
  updated_by             uuid,
  row_version            bigint       NOT NULL DEFAULT 1,
  CONSTRAINT agenda_item_pkey PRIMARY KEY (agenda_item_id),
  CONSTRAINT agenda_item_agenda_item_id_body_id_key UNIQUE (agenda_item_id, body_id),
  CONSTRAINT agenda_item_agenda_section_id_position_key UNIQUE (agenda_section_id, position)
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT agenda_item_meeting_id_body_id_fkey FOREIGN KEY (meeting_id, body_id)
    REFERENCES gov.meeting (meeting_id, body_id) ON DELETE CASCADE,
  CONSTRAINT agenda_item_agenda_section_id_meeting_id_fkey FOREIGN KEY (agenda_section_id, meeting_id)
    REFERENCES gov.agenda_section (agenda_section_id, meeting_id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT agenda_item_agenda_item_id_check CHECK (uuid_extract_version(agenda_item_id) = 7),
  CONSTRAINT agenda_item_position_check CHECK (position BETWEEN 1 AND 1000),
  CONSTRAINT agenda_item_item_number_check CHECK (char_length(item_number) BETWEEN 1 AND 20),
  CONSTRAINT agenda_item_title_check CHECK (char_length(title) BETWEEN 1 AND 300),
  CONSTRAINT agenda_item_description_check CHECK (char_length(description) BETWEEN 1 AND 20000),
  CONSTRAINT agenda_item_content_language_check CHECK (content_language IN ('de', 'en')),
  CONSTRAINT agenda_item_kind_check CHECK (kind IN ('report', 'motion', 'previous_protocol_approval',
    'election', 'misc')),
  CONSTRAINT agenda_item_own_publication_class_check
    CHECK (own_publication_class IN ('public', 'non_public')),
  CONSTRAINT agenda_item_state_check CHECK (state IN ('proposed', 'placed', 'declined', 'withdrawn',
    'called', 'dealt', 'adjourned')),
  CONSTRAINT agenda_item_placement_check CHECK ((agenda_section_id IS NULL) = (position IS NULL)
    AND (state NOT IN ('placed', 'called', 'dealt', 'adjourned') OR agenda_section_id IS NOT NULL)
    AND (state NOT IN ('proposed', 'declined') OR agenda_section_id IS NULL)),
  CONSTRAINT agenda_item_outcome_check CHECK (outcome IN ('noted', 'resolved', 'rejected', 'referred',
    'no_decision')),
  CONSTRAINT agenda_item_dealt_check CHECK ((state = 'dealt') = (outcome IS NOT NULL)),
  CONSTRAINT agenda_item_retention_profile_id_check
    CHECK (retention_profile_id ~ '^rp-[a-z]+-[a-z0-9-]+$'),
  CONSTRAINT agenda_item_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT agenda_item_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT agenda_item_row_version_check CHECK (row_version > 0)
);
CREATE INDEX agenda_item_meeting_id_body_id_idx ON gov.agenda_item (meeting_id, body_id);
CREATE INDEX agenda_item_agenda_section_id_meeting_id_idx ON gov.agenda_item (agenda_section_id, meeting_id)
  WHERE agenda_section_id IS NOT NULL;
CREATE UNIQUE INDEX agenda_item_meeting_id_previous_protocol_key ON gov.agenda_item (meeting_id)
  WHERE kind = 'previous_protocol_approval' AND state NOT IN ('declined', 'withdrawn');
CREATE INDEX agenda_item_proposer_person_id_idx ON gov.agenda_item (proposer_person_id)
  WHERE proposer_person_id IS NOT NULL;
CREATE TRIGGER agenda_item_touch_trg BEFORE UPDATE ON gov.agenda_item
  FOR EACH ROW EXECUTE FUNCTION gov.touch_row();
ALTER TABLE gov.agenda_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.agenda_item FORCE ROW LEVEL SECURITY;
CREATE POLICY agenda_item_tenant_pol ON gov.agenda_item
  USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));
COMMENT ON TABLE gov.agenda_item IS 'DB-GOV-AGENDA-ITEM | K3 or K2 per row | retention_profile_id | trigger: rp-gov-meeting-record with its meeting; rp-gov-proposal-unplaced meeting closed + grace';
COMMENT ON COLUMN gov.agenda_item.body_id IS 'xref DB-IDT-BODY';
COMMENT ON COLUMN gov.agenda_item.proposer_person_id IS 'xref DB-IDT-PERSON';

CREATE TABLE gov.agenda_snapshot (
  agenda_snapshot_id  bigint       GENERATED ALWAYS AS IDENTITY,
  customer_id         uuid         NOT NULL,
  body_id             uuid         NOT NULL,
  meeting_id          uuid         NOT NULL,
  version             integer      NOT NULL,
  content_hash        bytea        NOT NULL,
  rendered_content    text,
  erased_at           timestamptz,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  created_by_kind     text         NOT NULL,
  created_by          uuid,
  CONSTRAINT agenda_snapshot_pkey PRIMARY KEY (agenda_snapshot_id),
  CONSTRAINT agenda_snapshot_agenda_snapshot_id_meeting_id_key UNIQUE (agenda_snapshot_id, meeting_id),
  CONSTRAINT agenda_snapshot_meeting_id_version_key UNIQUE (meeting_id, version),
  CONSTRAINT agenda_snapshot_meeting_id_body_id_fkey FOREIGN KEY (meeting_id, body_id)
    REFERENCES gov.meeting (meeting_id, body_id) ON DELETE CASCADE,
  CONSTRAINT agenda_snapshot_version_check CHECK (version > 0),
  CONSTRAINT agenda_snapshot_content_hash_check CHECK (octet_length(content_hash) = 32),
  CONSTRAINT agenda_snapshot_rendered_content_check
    CHECK (char_length(rendered_content) BETWEEN 1 AND 1000000),
  CONSTRAINT agenda_snapshot_erased_check CHECK ((rendered_content IS NULL) = (erased_at IS NOT NULL)),
  CONSTRAINT agenda_snapshot_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL))
);
CREATE INDEX agenda_snapshot_meeting_id_body_id_idx ON gov.agenda_snapshot (meeting_id, body_id);
CREATE TRIGGER agenda_snapshot_append_only_trg BEFORE INSERT OR UPDATE ON gov.agenda_snapshot
  FOR EACH ROW EXECUTE FUNCTION gov.erasure_guard('agenda_snapshot_id', 'rendered_content');
ALTER TABLE gov.agenda_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.agenda_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY agenda_snapshot_tenant_pol ON gov.agenda_snapshot
  USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));
COMMENT ON TABLE gov.agenda_snapshot IS 'DB-GOV-AGENDA-SNAPSHOT | K3 | rp-gov-meeting-record | trigger: with its meeting';
COMMENT ON COLUMN gov.agenda_snapshot.body_id IS 'xref DB-IDT-BODY';
COMMENT ON COLUMN gov.agenda_snapshot.created_by IS 'xref DB-IDT-PERSON or DB-OAC-OPERATOR by created_by_kind';

CREATE TABLE gov.invitation (
  invitation_id            uuid         NOT NULL DEFAULT uuidv7(),
  customer_id              uuid         NOT NULL,
  body_id                  uuid         NOT NULL,
  meeting_id               uuid         NOT NULL,
  version                  integer      NOT NULL,
  agenda_snapshot_id       bigint       NOT NULL,
  mail_connector_id        uuid,
  state                    text         NOT NULL DEFAULT 'draft',
  notice_met               boolean,
  sent_at                  timestamptz,
  sender_person_id         uuid,
  recipient_count          integer,
  dispatch_refused_reason  text,
  created_at               timestamptz  NOT NULL DEFAULT now(),
  created_by_kind          text         NOT NULL,
  created_by               uuid,
  updated_at               timestamptz  NOT NULL DEFAULT now(),
  updated_by_kind          text         NOT NULL,
  updated_by               uuid,
  row_version              bigint       NOT NULL DEFAULT 1,
  CONSTRAINT invitation_pkey PRIMARY KEY (invitation_id),
  CONSTRAINT invitation_invitation_id_body_id_key UNIQUE (invitation_id, body_id),
  CONSTRAINT invitation_invitation_id_meeting_id_body_id_key UNIQUE (invitation_id, meeting_id, body_id),
  CONSTRAINT invitation_meeting_id_version_key UNIQUE (meeting_id, version),
  CONSTRAINT invitation_meeting_id_body_id_fkey FOREIGN KEY (meeting_id, body_id)
    REFERENCES gov.meeting (meeting_id, body_id) ON DELETE CASCADE,
  CONSTRAINT invitation_agenda_snapshot_id_meeting_id_fkey FOREIGN KEY (agenda_snapshot_id, meeting_id)
    REFERENCES gov.agenda_snapshot (agenda_snapshot_id, meeting_id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT invitation_invitation_id_check CHECK (uuid_extract_version(invitation_id) = 7),
  CONSTRAINT invitation_version_check CHECK (version > 0),
  CONSTRAINT invitation_state_check CHECK (state IN ('draft', 'checked', 'blocked', 'override_logged',
    'dispatching', 'dispatch_refused', 'partly_failed', 'sent')),
  CONSTRAINT invitation_notice_met_check CHECK ((state IN ('draft', 'checked') OR notice_met IS NOT NULL)
    AND (state NOT IN ('blocked', 'override_logged') OR NOT notice_met)),
  CONSTRAINT invitation_sent_check CHECK (state NOT IN ('dispatching', 'partly_failed', 'sent')
    OR (sent_at IS NOT NULL AND sender_person_id IS NOT NULL)),
  CONSTRAINT invitation_recipient_count_check CHECK (recipient_count BETWEEN 0 AND 100000),
  CONSTRAINT invitation_dispatch_refused_reason_check
    CHECK (dispatch_refused_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT invitation_dispatch_refused_check
    CHECK (state <> 'dispatch_refused' OR dispatch_refused_reason IS NOT NULL),
  CONSTRAINT invitation_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT invitation_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT invitation_row_version_check CHECK (row_version > 0)
);
CREATE INDEX invitation_meeting_id_body_id_idx ON gov.invitation (meeting_id, body_id);
CREATE INDEX invitation_agenda_snapshot_id_meeting_id_idx ON gov.invitation (agenda_snapshot_id, meeting_id);
CREATE INDEX invitation_sender_person_id_idx ON gov.invitation (sender_person_id)
  WHERE sender_person_id IS NOT NULL;

CREATE FUNCTION gov.invitation_notice_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_notice_due_at timestamptz;
BEGIN
  IF NEW.sent_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
          OR NEW.notice_met IS DISTINCT FROM OLD.notice_met) THEN
    SELECT m.notice_due_at INTO v_notice_due_at
      FROM gov.meeting AS m WHERE m.meeting_id = NEW.meeting_id;
    IF NEW.notice_met IS DISTINCT FROM (NEW.sent_at <= v_notice_due_at) THEN
      RAISE EXCEPTION 'notice_met must equal sent_at <= meeting.notice_due_at (invitation %)',
        NEW.invitation_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.notice_met IS FALSE
     AND NEW.state IN ('override_logged', 'dispatching', 'dispatch_refused', 'partly_failed', 'sent')
     AND NOT EXISTS (SELECT 1 FROM gov.notice_override AS o
                      WHERE o.invitation_id = NEW.invitation_id) THEN
    RAISE EXCEPTION 'a missed Ladungsfrist needs its notice_override before dispatch (invitation %)',
      NEW.invitation_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER invitation_touch_trg BEFORE UPDATE ON gov.invitation
  FOR EACH ROW EXECUTE FUNCTION gov.touch_row();
CREATE TRIGGER invitation_notice_guard_trg BEFORE INSERT OR UPDATE ON gov.invitation
  FOR EACH ROW EXECUTE FUNCTION gov.invitation_notice_guard();
ALTER TABLE gov.invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.invitation FORCE ROW LEVEL SECURITY;
CREATE POLICY invitation_tenant_pol ON gov.invitation
  USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));
COMMENT ON TABLE gov.invitation IS 'DB-GOV-INVITATION | K3 | rp-gov-meeting-record | trigger: with its meeting, as evidence of proper Ladung';
COMMENT ON COLUMN gov.invitation.body_id IS 'xref DB-IDT-BODY';
COMMENT ON COLUMN gov.invitation.mail_connector_id IS 'xref DB-MAIL-CONNECTOR';
COMMENT ON COLUMN gov.invitation.sender_person_id IS 'xref DB-IDT-PERSON';

CREATE TABLE gov.notice_override (
  notice_override_id     bigint       GENERATED ALWAYS AS IDENTITY,
  customer_id            uuid         NOT NULL,
  body_id                uuid         NOT NULL,
  invitation_id          uuid         NOT NULL,
  meeting_id             uuid         NOT NULL,
  days_short             integer      NOT NULL,
  reason                 text,
  curing_basis_id        uuid,
  curing_basis_version   integer,
  curing_basis_snapshot  text         NOT NULL,
  erased_at              timestamptz,
  created_at             timestamptz  NOT NULL DEFAULT now(),
  created_by_kind        text         NOT NULL,
  created_by             uuid,
  CONSTRAINT notice_override_pkey PRIMARY KEY (notice_override_id),
  CONSTRAINT notice_override_invitation_id_key UNIQUE (invitation_id),
  CONSTRAINT notice_override_notice_override_id_meeting_id_body_id_key
    UNIQUE (notice_override_id, meeting_id, body_id),
  CONSTRAINT notice_override_invitation_id_meeting_id_body_id_fkey
    FOREIGN KEY (invitation_id, meeting_id, body_id)
    REFERENCES gov.invitation (invitation_id, meeting_id, body_id) ON DELETE CASCADE,
  CONSTRAINT notice_override_curing_basis_id_version_body_id_fkey
    FOREIGN KEY (curing_basis_id, curing_basis_version, body_id)
    REFERENCES gov.curing_basis (curing_basis_id, version, body_id) ON DELETE RESTRICT,
  CONSTRAINT notice_override_days_short_check CHECK (days_short BETWEEN 1 AND 365),
  CONSTRAINT notice_override_reason_check CHECK (char_length(reason) BETWEEN 1 AND 2000),
  CONSTRAINT notice_override_erased_check CHECK ((reason IS NULL) = (erased_at IS NOT NULL)),
  CONSTRAINT notice_override_curing_basis_check
    CHECK ((curing_basis_id IS NULL) = (curing_basis_version IS NULL)),
  CONSTRAINT notice_override_curing_basis_snapshot_check
    CHECK (char_length(curing_basis_snapshot) BETWEEN 1 AND 12000),
  CONSTRAINT notice_override_created_by_check CHECK (created_by_kind = 'person' AND created_by IS NOT NULL)
);
CREATE INDEX notice_override_invitation_id_meeting_id_body_id_idx
  ON gov.notice_override (invitation_id, meeting_id, body_id);
CREATE INDEX notice_override_meeting_id_idx ON gov.notice_override (meeting_id);
CREATE INDEX notice_override_curing_basis_id_version_body_id_idx
  ON gov.notice_override (curing_basis_id, curing_basis_version, body_id)
  WHERE curing_basis_id IS NOT NULL;
CREATE INDEX notice_override_created_by_idx ON gov.notice_override (created_by);

CREATE FUNCTION gov.notice_override_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM gov.invitation AS i
                  WHERE i.invitation_id = NEW.invitation_id
                    AND i.state = 'blocked' AND i.notice_met IS FALSE) THEN
    RAISE EXCEPTION 'an override is recorded only for a blocked invitation with notice_met = false (invitation %)',
      NEW.invitation_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER notice_override_guard_trg BEFORE INSERT ON gov.notice_override
  FOR EACH ROW EXECUTE FUNCTION gov.notice_override_guard();
CREATE TRIGGER notice_override_append_only_trg BEFORE INSERT OR UPDATE ON gov.notice_override
  FOR EACH ROW EXECUTE FUNCTION gov.erasure_guard('notice_override_id', 'reason');
ALTER TABLE gov.notice_override ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.notice_override FORCE ROW LEVEL SECURITY;
CREATE POLICY notice_override_tenant_pol ON gov.notice_override
  USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));
COMMENT ON TABLE gov.notice_override IS 'DB-GOV-NOTICE-OVERRIDE | K3 | rp-gov-meeting-record | trigger: with its meeting; kept while any resolution carries it';
COMMENT ON COLUMN gov.notice_override.body_id IS 'xref DB-IDT-BODY';
COMMENT ON COLUMN gov.notice_override.created_by IS 'xref DB-IDT-PERSON (actor_person_id: the chair who recorded the override)';

CREATE TABLE gov.invitation_recipient (
  invitation_recipient_id  uuid         NOT NULL DEFAULT uuidv7(),
  customer_id              uuid         NOT NULL,
  body_id                  uuid         NOT NULL,
  invitation_id            uuid         NOT NULL,
  person_id                uuid         NOT NULL,
  delivery_evidence_id     uuid,
  delivery_state           text         NOT NULL DEFAULT 'queued',
  bounce_class             text,
  submitted_at             timestamptz,
  in_app_delivered         boolean      NOT NULL DEFAULT false,
  created_at               timestamptz  NOT NULL DEFAULT now(),
  created_by_kind          text         NOT NULL,
  created_by               uuid,
  updated_at               timestamptz  NOT NULL DEFAULT now(),
  updated_by_kind          text         NOT NULL,
  updated_by               uuid,
  row_version              bigint       NOT NULL DEFAULT 1,
  CONSTRAINT invitation_recipient_pkey PRIMARY KEY (invitation_recipient_id),
  CONSTRAINT invitation_recipient_invitation_id_person_id_key UNIQUE (invitation_id, person_id),
  CONSTRAINT invitation_recipient_invitation_id_body_id_fkey FOREIGN KEY (invitation_id, body_id)
    REFERENCES gov.invitation (invitation_id, body_id) ON DELETE CASCADE,
  CONSTRAINT invitation_recipient_invitation_recipient_id_check
    CHECK (uuid_extract_version(invitation_recipient_id) = 7),
  CONSTRAINT invitation_recipient_delivery_state_check CHECK (delivery_state IN ('queued', 'submitted',
    'failed', 'bounced', 'no_connector')),
  CONSTRAINT invitation_recipient_bounce_class_check CHECK (bounce_class IN ('hard', 'soft', 'unknown')),
  CONSTRAINT invitation_recipient_bounce_check
    CHECK ((delivery_state = 'bounced') = (bounce_class IS NOT NULL)),
  CONSTRAINT invitation_recipient_submitted_check CHECK (delivery_state <> 'submitted'
    OR (submitted_at IS NOT NULL AND delivery_evidence_id IS NOT NULL)),
  CONSTRAINT invitation_recipient_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT invitation_recipient_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT invitation_recipient_row_version_check CHECK (row_version > 0)
);
CREATE INDEX invitation_recipient_invitation_id_body_id_idx ON gov.invitation_recipient (invitation_id, body_id);
CREATE INDEX invitation_recipient_person_id_idx ON gov.invitation_recipient (person_id);
CREATE INDEX invitation_recipient_undelivered_idx ON gov.invitation_recipient (invitation_id)
  WHERE delivery_state IN ('failed', 'bounced', 'no_connector');
CREATE TRIGGER invitation_recipient_touch_trg BEFORE UPDATE ON gov.invitation_recipient
  FOR EACH ROW EXECUTE FUNCTION gov.touch_row();
ALTER TABLE gov.invitation_recipient ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.invitation_recipient FORCE ROW LEVEL SECURITY;
CREATE POLICY invitation_recipient_tenant_pol ON gov.invitation_recipient
  USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));
COMMENT ON TABLE gov.invitation_recipient IS 'DB-GOV-INVITATION-RECIPIENT | K2 | rp-gov-invitation-evidence | trigger: end of the challenge period for the meeting''s Beschluesse + grace';
COMMENT ON COLUMN gov.invitation_recipient.body_id IS 'xref DB-IDT-BODY';
COMMENT ON COLUMN gov.invitation_recipient.person_id IS 'xref DB-IDT-PERSON';
COMMENT ON COLUMN gov.invitation_recipient.delivery_evidence_id IS 'xref DB-MAIL-DELIVERYEVIDENCE';

CREATE TABLE gov.motion (
  motion_id            uuid         NOT NULL DEFAULT uuidv7(),
  customer_id          uuid         NOT NULL,
  body_id              uuid         NOT NULL,
  target_meeting_id    uuid,
  agenda_item_id       uuid,
  reference_label      text,
  title                text         NOT NULL,
  motion_text          text         NOT NULL,
  rationale            text,
  content_language     text         NOT NULL DEFAULT 'de',
  submitter_kind       text         NOT NULL,
  submitter_person_id  uuid,
  submitted_at         timestamptz,
  deadline_snapshot    timestamptz,
  is_late              boolean      GENERATED ALWAYS AS (submitted_at > deadline_snapshot) STORED,
  state                text         NOT NULL DEFAULT 'draft',
  publication_class    text         NOT NULL DEFAULT 'non_public',
  retention_profile_id text         GENERATED ALWAYS AS (CASE WHEN agenda_item_id IS NULL
                         AND state IN ('draft', 'pending_verification', 'withdrawn', 'expired')
                         THEN 'rp-gov-motion-lapsed' ELSE 'rp-gov-meeting-record' END) STORED,
  test_run_id          uuid,
  is_test              boolean      GENERATED ALWAYS AS (test_run_id IS NOT NULL) STORED,
  motion_vector        tsvector     GENERATED ALWAYS AS (to_tsvector(
                         CASE content_language WHEN 'en' THEN 'english'::regconfig
                                               ELSE 'german'::regconfig END,
                         title || ' ' || motion_text || ' ' || coalesce(rationale, ''))) STORED,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  created_by_kind      text         NOT NULL,
  created_by           uuid,
  updated_at           timestamptz  NOT NULL DEFAULT now(),
  updated_by_kind      text         NOT NULL,
  updated_by           uuid,
  row_version          bigint       NOT NULL DEFAULT 1,
  CONSTRAINT motion_pkey PRIMARY KEY (motion_id),
  CONSTRAINT motion_motion_id_body_id_key UNIQUE (motion_id, body_id),
  CONSTRAINT motion_agenda_item_id_key UNIQUE (agenda_item_id),
  CONSTRAINT motion_target_meeting_id_body_id_fkey FOREIGN KEY (target_meeting_id, body_id)
    REFERENCES gov.meeting (meeting_id, body_id) ON DELETE RESTRICT,
  CONSTRAINT motion_agenda_item_id_body_id_fkey FOREIGN KEY (agenda_item_id, body_id)
    REFERENCES gov.agenda_item (agenda_item_id, body_id) ON DELETE RESTRICT,
  CONSTRAINT motion_motion_id_check CHECK (uuid_extract_version(motion_id) = 7),
  CONSTRAINT motion_reference_label_check CHECK (char_length(reference_label) BETWEEN 1 AND 40),
  CONSTRAINT motion_title_check CHECK (char_length(title) BETWEEN 1 AND 300),
  CONSTRAINT motion_motion_text_check CHECK (char_length(motion_text) BETWEEN 1 AND 50000),
  CONSTRAINT motion_rationale_check CHECK (char_length(rationale) BETWEEN 1 AND 50000),
  CONSTRAINT motion_content_language_check CHECK (content_language IN ('de', 'en')),
  CONSTRAINT motion_submitter_kind_check CHECK (submitter_kind IN ('member', 'helper', 'public')),
  CONSTRAINT motion_submitter_check CHECK ((submitter_kind = 'public') = (submitter_person_id IS NULL)),
  CONSTRAINT motion_state_check CHECK (state IN ('draft', 'pending_verification', 'submitted', 'withheld',
    'on_agenda', 'deferred', 'adjourned', 'decided', 'withdrawn', 'expired')),
  CONSTRAINT motion_submitted_check
    CHECK (state IN ('draft', 'pending_verification', 'expired') OR submitted_at IS NOT NULL),
  CONSTRAINT motion_public_intake_check
    CHECK (state NOT IN ('pending_verification', 'expired') OR submitter_kind = 'public'),
  CONSTRAINT motion_draft_check CHECK (state <> 'draft' OR submitter_kind <> 'public'),
  CONSTRAINT motion_withheld_check CHECK (state <> 'withheld' OR submitted_at > deadline_snapshot),
  CONSTRAINT motion_on_agenda_check
    CHECK (state NOT IN ('on_agenda', 'decided') OR agenda_item_id IS NOT NULL),
  CONSTRAINT motion_publication_class_check CHECK (publication_class IN ('public', 'non_public')),
  CONSTRAINT motion_retention_profile_id_check CHECK (retention_profile_id ~ '^rp-[a-z]+-[a-z0-9-]+$'),
  CONSTRAINT motion_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT motion_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT motion_row_version_check CHECK (row_version > 0)
);
CREATE INDEX motion_target_meeting_id_body_id_idx ON gov.motion (target_meeting_id, body_id)
  WHERE target_meeting_id IS NOT NULL;
CREATE INDEX motion_agenda_item_id_body_id_idx ON gov.motion (agenda_item_id, body_id)
  WHERE agenda_item_id IS NOT NULL;
CREATE INDEX motion_body_id_state_idx ON gov.motion (body_id, state);
CREATE INDEX motion_submitter_person_id_idx ON gov.motion (submitter_person_id)
  WHERE submitter_person_id IS NOT NULL;
CREATE INDEX motion_test_run_id_idx ON gov.motion (test_run_id) WHERE test_run_id IS NOT NULL;

CREATE FUNCTION gov.motion_admission_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'on_agenda' AND NEW.submitted_at > NEW.deadline_snapshot
     AND (TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM NEW.state)
     AND NOT EXISTS (SELECT 1 FROM gov.motion_admission AS a
                      WHERE a.motion_id = NEW.motion_id AND a.outcome = 'admit') THEN
    RAISE EXCEPTION 'a late motion is placed only after an admit decision (motion %)', NEW.motion_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER motion_touch_trg BEFORE UPDATE ON gov.motion
  FOR EACH ROW EXECUTE FUNCTION gov.touch_row();
CREATE TRIGGER motion_root_keys_trg BEFORE UPDATE ON gov.motion
  FOR EACH ROW EXECUTE FUNCTION gov.root_keys_immutable();
CREATE TRIGGER motion_admission_guard_trg BEFORE INSERT OR UPDATE ON gov.motion
  FOR EACH ROW EXECUTE FUNCTION gov.motion_admission_guard();
ALTER TABLE gov.motion ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.motion FORCE ROW LEVEL SECURITY;
CREATE POLICY motion_tenant_pol ON gov.motion
  USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));
COMMENT ON TABLE gov.motion IS 'DB-GOV-MOTION | K3 or K2 per row | retention_profile_id | trigger: rp-gov-meeting-record meeting closed; rp-gov-motion-lapsed withdrawal or deferral lapse + grace; test rows hard-deleted by test_run_id';
COMMENT ON COLUMN gov.motion.body_id IS 'xref DB-IDT-BODY';
COMMENT ON COLUMN gov.motion.submitter_person_id IS 'xref DB-IDT-PERSON';
COMMENT ON COLUMN gov.motion.test_run_id IS 'xref DB-OPS-TEST-RUN';

CREATE TABLE gov.motion_admission (
  motion_admission_id     bigint       GENERATED ALWAYS AS IDENTITY,
  customer_id             uuid         NOT NULL,
  body_id                 uuid         NOT NULL,
  motion_id               uuid         NOT NULL,
  outcome                 text         NOT NULL,
  deferred_to_meeting_id  uuid,
  defer_to_next_meeting   boolean      NOT NULL DEFAULT false,
  created_at              timestamptz  NOT NULL DEFAULT now(),
  created_by_kind         text         NOT NULL,
  created_by              uuid,
  CONSTRAINT motion_admission_pkey PRIMARY KEY (motion_admission_id),
  CONSTRAINT motion_admission_motion_id_body_id_fkey FOREIGN KEY (motion_id, body_id)
    REFERENCES gov.motion (motion_id, body_id) ON DELETE CASCADE,
  CONSTRAINT motion_admission_deferred_to_meeting_id_body_id_fkey
    FOREIGN KEY (deferred_to_meeting_id, body_id)
    REFERENCES gov.meeting (meeting_id, body_id) ON DELETE RESTRICT,
  CONSTRAINT motion_admission_outcome_check CHECK (outcome IN ('admit', 'defer')),
  CONSTRAINT motion_admission_defer_check CHECK (CASE outcome
    WHEN 'admit' THEN deferred_to_meeting_id IS NULL AND NOT defer_to_next_meeting
    ELSE (deferred_to_meeting_id IS NOT NULL) <> defer_to_next_meeting END),
  CONSTRAINT motion_admission_created_by_check CHECK (created_by_kind = 'person' AND created_by IS NOT NULL)
);
CREATE INDEX motion_admission_motion_id_body_id_idx ON gov.motion_admission (motion_id, body_id);
CREATE INDEX motion_admission_deferred_to_meeting_id_body_id_idx
  ON gov.motion_admission (deferred_to_meeting_id, body_id) WHERE deferred_to_meeting_id IS NOT NULL;
CREATE INDEX motion_admission_created_by_idx ON gov.motion_admission (created_by);
CREATE TRIGGER motion_admission_append_only_trg BEFORE INSERT OR UPDATE ON gov.motion_admission
  FOR EACH ROW EXECUTE FUNCTION gov.erasure_guard('motion_admission_id');
ALTER TABLE gov.motion_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.motion_admission FORCE ROW LEVEL SECURITY;
CREATE POLICY motion_admission_tenant_pol ON gov.motion_admission
  USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));
COMMENT ON TABLE gov.motion_admission IS 'DB-GOV-MOTION-ADMISSION | K3 | rp-gov-meeting-record | trigger: with its motion';
COMMENT ON COLUMN gov.motion_admission.body_id IS 'xref DB-IDT-BODY';
COMMENT ON COLUMN gov.motion_admission.created_by IS 'xref DB-IDT-PERSON (actor_person_id: the chair)';

CREATE TABLE gov.public_submitter (
  public_submitter_id      bigint       GENERATED ALWAYS AS IDENTITY,
  customer_id              uuid         NOT NULL,
  body_id                  uuid         NOT NULL,
  motion_id                uuid         NOT NULL,
  display_name             text         NOT NULL,
  email                    text         NOT NULL,
  contact_hash             bytea        NOT NULL,
  affiliation              text,
  verification_token_hash  bytea,
  verification_expires_at  timestamptz  NOT NULL,
  verified_at              timestamptz,
  consent_text_version     text         NOT NULL,
  retention_profile_id     text         GENERATED ALWAYS AS (CASE WHEN verified_at IS NULL
                             THEN 'rp-gov-public-submitter-unverified'
                             ELSE 'rp-gov-public-submitter' END) STORED,
  created_at               timestamptz  NOT NULL DEFAULT now(),
  created_by_kind          text         NOT NULL DEFAULT 'system',
  created_by               uuid,
  updated_at               timestamptz  NOT NULL DEFAULT now(),
  updated_by_kind          text         NOT NULL DEFAULT 'system',
  updated_by               uuid,
  row_version              bigint       NOT NULL DEFAULT 1,
  CONSTRAINT public_submitter_pkey PRIMARY KEY (public_submitter_id),
  CONSTRAINT public_submitter_motion_id_key UNIQUE (motion_id),
  CONSTRAINT public_submitter_motion_id_body_id_fkey FOREIGN KEY (motion_id, body_id)
    REFERENCES gov.motion (motion_id, body_id) ON DELETE CASCADE,
  CONSTRAINT public_submitter_display_name_check CHECK (char_length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT public_submitter_email_check
    CHECK (char_length(email) BETWEEN 3 AND 254 AND email ~ '^[^@\s]+@[^@\s]+$'),
  CONSTRAINT public_submitter_contact_hash_check CHECK (octet_length(contact_hash) = 32),
  CONSTRAINT public_submitter_affiliation_check CHECK (char_length(affiliation) BETWEEN 1 AND 200),
  CONSTRAINT public_submitter_verification_token_hash_check
    CHECK (octet_length(verification_token_hash) = 32),
  CONSTRAINT public_submitter_verification_check
    CHECK ((verified_at IS NULL) = (verification_token_hash IS NOT NULL)),
  CONSTRAINT public_submitter_consent_text_version_check
    CHECK (char_length(consent_text_version) BETWEEN 1 AND 40),
  CONSTRAINT public_submitter_retention_profile_id_check
    CHECK (retention_profile_id ~ '^rp-[a-z]+-[a-z0-9-]+$'),
  CONSTRAINT public_submitter_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT public_submitter_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT public_submitter_row_version_check CHECK (row_version > 0)
);
CREATE INDEX public_submitter_motion_id_body_id_idx ON gov.public_submitter (motion_id, body_id);
CREATE INDEX public_submitter_contact_hash_idx ON gov.public_submitter (contact_hash);
CREATE INDEX public_submitter_verification_expires_at_idx ON gov.public_submitter (verification_expires_at)
  WHERE verified_at IS NULL;
CREATE TRIGGER public_submitter_touch_trg BEFORE UPDATE ON gov.public_submitter
  FOR EACH ROW EXECUTE FUNCTION gov.touch_row();
ALTER TABLE gov.public_submitter ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.public_submitter FORCE ROW LEVEL SECURITY;
CREATE POLICY public_submitter_tenant_pol ON gov.public_submitter
  USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));
COMMENT ON TABLE gov.public_submitter IS 'DB-GOV-PUBLIC-SUBMITTER | K2 or K1 per row | retention_profile_id | trigger: rp-gov-public-submitter motion decided or withdrawn + grace, or granted subject erasure; rp-gov-public-submitter-unverified token expiry';
COMMENT ON COLUMN gov.public_submitter.body_id IS 'xref DB-IDT-BODY';

CREATE TABLE gov.attachment_link (
  attachment_link_id   uuid         NOT NULL DEFAULT uuidv7(),
  customer_id          uuid         NOT NULL,
  body_id              uuid         NOT NULL,
  agenda_item_id       uuid,
  motion_id            uuid,
  file_ref             text         NOT NULL,
  link                 text         NOT NULL,
  display_name         text         NOT NULL,
  publication_class    text         NOT NULL DEFAULT 'non_public',
  released_copy_key    text,
  released_copy_hash   bytea,
  link_state           text         NOT NULL DEFAULT 'live',
  created_at           timestamptz  NOT NULL DEFAULT now(),
  created_by_kind      text         NOT NULL,
  created_by           uuid,
  updated_at           timestamptz  NOT NULL DEFAULT now(),
  updated_by_kind      text         NOT NULL,
  updated_by           uuid,
  row_version          bigint       NOT NULL DEFAULT 1,
  CONSTRAINT attachment_link_pkey PRIMARY KEY (attachment_link_id),
  CONSTRAINT attachment_link_agenda_item_id_body_id_fkey FOREIGN KEY (agenda_item_id, body_id)
    REFERENCES gov.agenda_item (agenda_item_id, body_id) ON DELETE CASCADE,
  CONSTRAINT attachment_link_motion_id_body_id_fkey FOREIGN KEY (motion_id, body_id)
    REFERENCES gov.motion (motion_id, body_id) ON DELETE CASCADE,
  CONSTRAINT attachment_link_attachment_link_id_check CHECK (uuid_extract_version(attachment_link_id) = 7),
  CONSTRAINT attachment_link_owner_check CHECK (num_nonnulls(agenda_item_id, motion_id) = 1),
  CONSTRAINT attachment_link_file_ref_check CHECK (char_length(file_ref) BETWEEN 1 AND 500),
  CONSTRAINT attachment_link_link_check CHECK (char_length(link) BETWEEN 1 AND 2000
    AND link ~ '^https?://'),
  CONSTRAINT attachment_link_display_name_check CHECK (char_length(display_name) BETWEEN 1 AND 300),
  CONSTRAINT attachment_link_publication_class_check CHECK (publication_class IN ('public', 'non_public')),
  CONSTRAINT attachment_link_released_copy_key_check CHECK (char_length(released_copy_key) BETWEEN 1 AND 500),
  CONSTRAINT attachment_link_released_copy_hash_check CHECK (octet_length(released_copy_hash) = 32),
  CONSTRAINT attachment_link_released_copy_check
    CHECK ((released_copy_key IS NULL) = (released_copy_hash IS NULL)),
  CONSTRAINT attachment_link_link_state_check CHECK (link_state IN ('live', 'target_missing')),
  CONSTRAINT attachment_link_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT attachment_link_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT attachment_link_row_version_check CHECK (row_version > 0)
);
CREATE INDEX attachment_link_agenda_item_id_body_id_idx ON gov.attachment_link (agenda_item_id, body_id)
  WHERE agenda_item_id IS NOT NULL;
CREATE INDEX attachment_link_motion_id_body_id_idx ON gov.attachment_link (motion_id, body_id)
  WHERE motion_id IS NOT NULL;
CREATE INDEX attachment_link_file_ref_idx ON gov.attachment_link (file_ref);

CREATE FUNCTION gov.attachment_link_released_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.released_copy_key IS NOT NULL AND pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'a released attachment leaves only with its owner (attachment %)',
        OLD.attachment_link_id USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.released_copy_key IS NOT NULL
     AND (NEW.released_copy_key IS DISTINCT FROM OLD.released_copy_key
          OR NEW.released_copy_hash IS DISTINCT FROM OLD.released_copy_hash) THEN
    RAISE EXCEPTION 'a released copy is never overwritten (attachment %)', OLD.attachment_link_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER attachment_link_touch_trg BEFORE UPDATE ON gov.attachment_link
  FOR EACH ROW EXECUTE FUNCTION gov.touch_row();
CREATE TRIGGER attachment_link_released_copy_trg BEFORE UPDATE OR DELETE ON gov.attachment_link
  FOR EACH ROW EXECUTE FUNCTION gov.attachment_link_released_guard();
ALTER TABLE gov.attachment_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.attachment_link FORCE ROW LEVEL SECURITY;
CREATE POLICY attachment_link_tenant_pol ON gov.attachment_link
  USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));
COMMENT ON TABLE gov.attachment_link IS 'DB-GOV-ATTACHMENT-LINK | K3 | rp-gov-meeting-record | trigger: with its owner; released copy K3 non-public or K6 rp-gov-public-record';
COMMENT ON COLUMN gov.attachment_link.body_id IS 'xref DB-IDT-BODY';
COMMENT ON COLUMN gov.attachment_link.file_ref IS 'opaque file reference owned by FIL (no DB id; key of fil.file.removed.v1)';

CREATE TABLE gov.external_ref (
  external_ref_id      uuid          NOT NULL DEFAULT uuidv7(),
  customer_id          uuid          NOT NULL,
  body_id              uuid          NOT NULL,
  agenda_item_id       uuid,
  resolution_id        uuid,
  system_name          text          NOT NULL,
  external_identifier  text          NOT NULL,
  link                 text,
  amount               numeric(14,2),
  currency_code        char(3),
  publication_class    text          NOT NULL DEFAULT 'non_public',
  created_at           timestamptz   NOT NULL DEFAULT now(),
  created_by_kind      text          NOT NULL,
  created_by           uuid,
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  updated_by_kind      text          NOT NULL,
  updated_by           uuid,
  row_version          bigint        NOT NULL DEFAULT 1,
  CONSTRAINT external_ref_pkey PRIMARY KEY (external_ref_id),
  CONSTRAINT external_ref_agenda_item_id_body_id_fkey FOREIGN KEY (agenda_item_id, body_id)
    REFERENCES gov.agenda_item (agenda_item_id, body_id) ON DELETE CASCADE,
  CONSTRAINT external_ref_external_ref_id_check CHECK (uuid_extract_version(external_ref_id) = 7),
  CONSTRAINT external_ref_owner_check CHECK (num_nonnulls(agenda_item_id, resolution_id) = 1),
  CONSTRAINT external_ref_system_name_check CHECK (char_length(system_name) BETWEEN 1 AND 100),
  CONSTRAINT external_ref_external_identifier_check
    CHECK (char_length(external_identifier) BETWEEN 1 AND 200),
  CONSTRAINT external_ref_link_check CHECK (char_length(link) BETWEEN 1 AND 2000 AND link ~ '^https?://'),
  CONSTRAINT external_ref_money_check CHECK ((amount IS NULL) = (currency_code IS NULL)),
  CONSTRAINT external_ref_currency_code_check CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT external_ref_publication_class_check CHECK (publication_class = 'non_public'),
  CONSTRAINT external_ref_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT external_ref_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT external_ref_row_version_check CHECK (row_version > 0)
);
CREATE INDEX external_ref_agenda_item_id_body_id_idx ON gov.external_ref (agenda_item_id, body_id)
  WHERE agenda_item_id IS NOT NULL;
CREATE INDEX external_ref_resolution_id_body_id_idx ON gov.external_ref (resolution_id, body_id)
  WHERE resolution_id IS NOT NULL;
CREATE TRIGGER external_ref_touch_trg BEFORE UPDATE ON gov.external_ref
  FOR EACH ROW EXECUTE FUNCTION gov.touch_row();
ALTER TABLE gov.external_ref ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.external_ref FORCE ROW LEVEL SECURITY;
CREATE POLICY external_ref_tenant_pol ON gov.external_ref
  USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));
COMMENT ON TABLE gov.external_ref IS 'DB-GOV-EXTERNAL-REF | K3 | rp-gov-meeting-record | trigger: with its owner; K4 overlay rp-gov-finance-overlay until finance_hold_until';
COMMENT ON COLUMN gov.external_ref.body_id IS 'xref DB-IDT-BODY';
COMMENT ON COLUMN gov.external_ref.resolution_id IS 'same-database reference to gov.resolution; foreign key external_ref_resolution_id_body_id_fkey added by section 3';

CREATE TABLE gov.attendance (
  attendance_id          bigint       GENERATED ALWAYS AS IDENTITY,
  customer_id            uuid         NOT NULL,
  body_id                uuid         NOT NULL,
  meeting_id             uuid         NOT NULL,
  person_id              uuid         NOT NULL,
  capacity               text         NOT NULL,
  voting_right_snapshot  boolean      NOT NULL,
  mode                   text,
  arrived_at             timestamptz,
  left_at                timestamptz,
  excused                boolean      NOT NULL DEFAULT false,
  created_at             timestamptz  NOT NULL DEFAULT now(),
  created_by_kind        text         NOT NULL,
  created_by             uuid,
  updated_at             timestamptz  NOT NULL DEFAULT now(),
  updated_by_kind        text         NOT NULL,
  updated_by             uuid,
  row_version            bigint       NOT NULL DEFAULT 1,
  CONSTRAINT attendance_pkey PRIMARY KEY (attendance_id),
  CONSTRAINT attendance_meeting_id_person_id_key UNIQUE (meeting_id, person_id),
  CONSTRAINT attendance_meeting_id_body_id_fkey FOREIGN KEY (meeting_id, body_id)
    REFERENCES gov.meeting (meeting_id, body_id) ON DELETE CASCADE,
  CONSTRAINT attendance_capacity_check CHECK (capacity IN ('voting_member', 'deputy', 'helper', 'guest')),
  CONSTRAINT attendance_voting_right_check
    CHECK (capacity IN ('voting_member', 'deputy') OR NOT voting_right_snapshot),
  CONSTRAINT attendance_mode_check CHECK (mode IN ('in_person', 'remote')),
  CONSTRAINT attendance_presence_check
    CHECK (arrived_at IS NULL OR (mode IS NOT NULL AND NOT excused)),
  CONSTRAINT attendance_left_at_check
    CHECK (left_at IS NULL OR (arrived_at IS NOT NULL AND left_at >= arrived_at)),
  CONSTRAINT attendance_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT attendance_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT attendance_row_version_check CHECK (row_version > 0)
);
CREATE INDEX attendance_meeting_id_body_id_idx ON gov.attendance (meeting_id, body_id);
CREATE INDEX attendance_person_id_idx ON gov.attendance (person_id);
CREATE TRIGGER attendance_touch_trg BEFORE UPDATE ON gov.attendance
  FOR EACH ROW EXECUTE FUNCTION gov.touch_row();
ALTER TABLE gov.attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.attendance FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_tenant_pol ON gov.attendance
  USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));
COMMENT ON TABLE gov.attendance IS 'DB-GOV-ATTENDANCE | K3 | rp-gov-meeting-record | trigger: with its meeting';
COMMENT ON COLUMN gov.attendance.body_id IS 'xref DB-IDT-BODY';
COMMENT ON COLUMN gov.attendance.person_id IS 'xref DB-IDT-PERSON';

CREATE TABLE gov.attendance_forecast (
  attendance_forecast_id  bigint       GENERATED ALWAYS AS IDENTITY,
  customer_id             uuid         NOT NULL,
  body_id                 uuid         NOT NULL,
  meeting_id              uuid         NOT NULL,
  person_id               uuid         NOT NULL,
  expectation             text         NOT NULL,
  created_at              timestamptz  NOT NULL DEFAULT now(),
  created_by_kind         text         NOT NULL,
  created_by              uuid,
  updated_at              timestamptz  NOT NULL DEFAULT now(),
  updated_by_kind         text         NOT NULL,
  updated_by              uuid,
  row_version             bigint       NOT NULL DEFAULT 1,
  CONSTRAINT attendance_forecast_pkey PRIMARY KEY (attendance_forecast_id),
  CONSTRAINT attendance_forecast_meeting_id_person_id_key UNIQUE (meeting_id, person_id),
  CONSTRAINT attendance_forecast_meeting_id_body_id_fkey FOREIGN KEY (meeting_id, body_id)
    REFERENCES gov.meeting (meeting_id, body_id) ON DELETE CASCADE,
  CONSTRAINT attendance_forecast_expectation_check CHECK (expectation IN ('yes', 'no', 'maybe')),
  CONSTRAINT attendance_forecast_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT attendance_forecast_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT attendance_forecast_row_version_check CHECK (row_version > 0)
);
CREATE INDEX attendance_forecast_meeting_id_body_id_idx ON gov.attendance_forecast (meeting_id, body_id);
CREATE INDEX attendance_forecast_person_id_idx ON gov.attendance_forecast (person_id);
CREATE TRIGGER attendance_forecast_touch_trg BEFORE UPDATE ON gov.attendance_forecast
  FOR EACH ROW EXECUTE FUNCTION gov.touch_row();
ALTER TABLE gov.attendance_forecast ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.attendance_forecast FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_forecast_tenant_pol ON gov.attendance_forecast
  USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));
COMMENT ON TABLE gov.attendance_forecast IS 'DB-GOV-ATTENDANCE-FORECAST | K1 | rp-gov-forecast | trigger: meeting closed';
COMMENT ON COLUMN gov.attendance_forecast.body_id IS 'xref DB-IDT-BODY';
COMMENT ON COLUMN gov.attendance_forecast.person_id IS 'xref DB-IDT-PERSON';

CREATE TABLE gov.quorum_check (
  quorum_check_id     bigint       GENERATED ALWAYS AS IDENTITY,
  customer_id         uuid         NOT NULL,
  body_id             uuid         NOT NULL,
  meeting_id          uuid         NOT NULL,
  resolution_id       uuid,
  present_voting      integer      NOT NULL,
  statutory_members   integer      NOT NULL,
  required            integer      NOT NULL,
  result              text         NOT NULL,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  created_by_kind     text         NOT NULL,
  created_by          uuid,
  CONSTRAINT quorum_check_pkey PRIMARY KEY (quorum_check_id),
  CONSTRAINT quorum_check_quorum_check_id_body_id_key UNIQUE (quorum_check_id, body_id),
  CONSTRAINT quorum_check_meeting_id_body_id_fkey FOREIGN KEY (meeting_id, body_id)
    REFERENCES gov.meeting (meeting_id, body_id) ON DELETE CASCADE,
  CONSTRAINT quorum_check_present_voting_check CHECK (present_voting BETWEEN 0 AND 10000),
  CONSTRAINT quorum_check_statutory_members_check CHECK (statutory_members BETWEEN 1 AND 10000),
  CONSTRAINT quorum_check_required_check CHECK (required BETWEEN 0 AND statutory_members),
  CONSTRAINT quorum_check_result_check CHECK (result IN ('quorate', 'not_quorate')),
  CONSTRAINT quorum_check_evaluation_check CHECK ((result = 'quorate') = (present_voting >= required)),
  CONSTRAINT quorum_check_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL))
);
CREATE INDEX quorum_check_meeting_id_body_id_idx ON gov.quorum_check (meeting_id, body_id);
CREATE INDEX quorum_check_resolution_id_body_id_idx ON gov.quorum_check (resolution_id, body_id)
  WHERE resolution_id IS NOT NULL;
CREATE TRIGGER quorum_check_append_only_trg BEFORE INSERT OR UPDATE ON gov.quorum_check
  FOR EACH ROW EXECUTE FUNCTION gov.erasure_guard('quorum_check_id');
ALTER TABLE gov.quorum_check ENABLE ROW LEVEL SECURITY;
ALTER TABLE gov.quorum_check FORCE ROW LEVEL SECURITY;
CREATE POLICY quorum_check_tenant_pol ON gov.quorum_check
  USING (customer_id = (SELECT gov.current_customer_id()))
  WITH CHECK (customer_id = (SELECT gov.current_customer_id()));
COMMENT ON TABLE gov.quorum_check IS 'DB-GOV-QUORUM-CHECK | K3 | rp-gov-meeting-record | trigger: with its meeting';
COMMENT ON COLUMN gov.quorum_check.body_id IS 'xref DB-IDT-BODY';
COMMENT ON COLUMN gov.quorum_check.resolution_id IS 'same-database reference to gov.resolution; foreign key quorum_check_resolution_id_body_id_fkey added by section 3';

-- SCHEMA 2.19 grants as plain statements (the group roles exist: ensureGovernanceDatabase creates them first)
GRANT USAGE ON SCHEMA gov TO gov_app;
GRANT SELECT ON gov.database_binding, gov.schema_migration TO gov_app;
GRANT SELECT, INSERT, UPDATE ON gov.outbox TO gov_app;
GRANT SELECT, INSERT, UPDATE ON gov.inbox TO gov_app;
GRANT SELECT, INSERT, UPDATE ON gov.applied_aggregate_version TO gov_app;
GRANT SELECT, INSERT, UPDATE ON gov.job TO gov_app;
GRANT SELECT, INSERT, UPDATE ON gov.body_ref TO gov_app;
GRANT SELECT, INSERT, UPDATE ON gov.member_ref TO gov_app;
GRANT SELECT, INSERT, UPDATE ON gov.meeting TO gov_app;
GRANT SELECT, INSERT, UPDATE ON gov.agenda_item TO gov_app;
GRANT SELECT, INSERT, UPDATE ON gov.invitation TO gov_app;
GRANT SELECT, INSERT, UPDATE ON gov.invitation_recipient TO gov_app;
GRANT SELECT, INSERT, UPDATE ON gov.motion TO gov_app;
GRANT SELECT, INSERT, UPDATE ON gov.public_submitter TO gov_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON gov.agenda_section TO gov_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON gov.attachment_link TO gov_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON gov.external_ref TO gov_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON gov.attendance TO gov_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON gov.attendance_forecast TO gov_app;
GRANT SELECT, INSERT ON gov.body_settings TO gov_app;
GRANT SELECT, INSERT ON gov.curing_basis TO gov_app;
GRANT SELECT, INSERT ON gov.agenda_snapshot TO gov_app;
GRANT SELECT, INSERT ON gov.notice_override TO gov_app;
GRANT SELECT, INSERT ON gov.motion_admission TO gov_app;
GRANT SELECT, INSERT ON gov.quorum_check TO gov_app;
GRANT USAGE ON SCHEMA gov TO gov_purger;
GRANT SELECT ON gov.database_binding TO gov_purger;
GRANT SELECT, DELETE ON gov.outbox TO gov_purger;
GRANT SELECT, DELETE ON gov.inbox TO gov_purger;
GRANT SELECT, DELETE ON gov.applied_aggregate_version TO gov_purger;
GRANT SELECT, DELETE ON gov.job TO gov_purger;
GRANT SELECT, DELETE ON gov.body_ref TO gov_purger;
GRANT SELECT, DELETE ON gov.member_ref TO gov_purger;
GRANT SELECT, DELETE ON gov.body_settings TO gov_purger;
GRANT SELECT, DELETE ON gov.curing_basis TO gov_purger;
GRANT SELECT, DELETE ON gov.meeting TO gov_purger;
GRANT SELECT, DELETE ON gov.agenda_section TO gov_purger;
GRANT SELECT, DELETE ON gov.agenda_item TO gov_purger;
GRANT SELECT, DELETE ON gov.agenda_snapshot TO gov_purger;
GRANT SELECT, DELETE ON gov.invitation TO gov_purger;
GRANT SELECT, DELETE ON gov.notice_override TO gov_purger;
GRANT SELECT, DELETE ON gov.invitation_recipient TO gov_purger;
GRANT SELECT, DELETE ON gov.motion TO gov_purger;
GRANT SELECT, DELETE ON gov.motion_admission TO gov_purger;
GRANT SELECT, DELETE ON gov.public_submitter TO gov_purger;
GRANT SELECT, DELETE ON gov.attachment_link TO gov_purger;
GRANT SELECT, DELETE ON gov.external_ref TO gov_purger;
GRANT SELECT, DELETE ON gov.attendance TO gov_purger;
GRANT SELECT, DELETE ON gov.attendance_forecast TO gov_purger;
GRANT SELECT, DELETE ON gov.quorum_check TO gov_purger;
GRANT UPDATE (rendered_content, erased_at) ON gov.agenda_snapshot TO gov_purger;
GRANT UPDATE (reason, erased_at) ON gov.notice_override TO gov_purger;

CREATE FUNCTION gov.remove_test_run(p_test_run_id uuid)
  RETURNS TABLE (root_table text, removed bigint)
  LANGUAGE plpgsql AS $$
BEGIN
  IF p_test_run_id IS NULL THEN
    RAISE EXCEPTION 'test_run_id is required' USING ERRCODE = 'null_value_not_allowed';
  END IF;
  root_table := 'motion';
  DELETE FROM gov.motion WHERE test_run_id = p_test_run_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN NEXT;
  root_table := 'poll';
  DELETE FROM gov.poll WHERE test_run_id = p_test_run_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN NEXT;
  root_table := 'meeting';
  DELETE FROM gov.meeting WHERE test_run_id = p_test_run_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN NEXT;
  root_table := 'job';
  DELETE FROM gov.job WHERE test_run_id = p_test_run_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN NEXT;
  root_table := 'outbox';
  DELETE FROM gov.outbox WHERE test_run_id = p_test_run_id AND relay_state <> 'pending';
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN NEXT;
  root_table := 'inbox';
  DELETE FROM gov.inbox WHERE test_run_id = p_test_run_id
                          AND processing_state NOT IN ('received', 'failed');
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN NEXT;
END
$$;
REVOKE EXECUTE ON FUNCTION gov.remove_test_run(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gov.remove_test_run(uuid) TO gov_purger;
COMMENT ON FUNCTION gov.remove_test_run(uuid) IS 'Canonical removal of one test run (D R20-R18-6); run by gov_purger in its own transaction; deferred keys are checked at commit';

-- Assembled from SCHEMA-gremion part 2 (TASK-084-a): the plumbing prefix replaces 2.1 (lines 4783-5034); table blocks 5071-6682 verbatim; 2.19 grants (6712-6751) and 2.21 (6917-6961) as plain statements.
