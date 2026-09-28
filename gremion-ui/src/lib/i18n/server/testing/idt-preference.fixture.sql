-- TEST-ONLY fixture (TASK-062, brief Q1 default). NOT a migration.
--
-- Applies the DB-IDT-PREFERENCE and DB-IDT-CUSTOMERSETTING DDL verbatim from
-- SCHEMA-gremion §IDT so the reference pg adapter (locale-preference-pg.ts)
-- runs against the real constraints, trigger and RLS policy. The production
-- idt schema ships with TASK-038/080; this file only exists for the contract
-- suite and must never be applied to an app database.
--
-- Verbatim: idt.current_customer_id(), idt.touch_row(), idt.customer_setting,
-- idt.preference. Stubs (only what the preference FKs need): idt.person,
-- idt.body.

CREATE SCHEMA IF NOT EXISTS idt;

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

-- stub: the real idt.person / idt.body carry many more columns
CREATE TABLE idt.person (person_id uuid PRIMARY KEY);
CREATE TABLE idt.body (body_id uuid PRIMARY KEY);

CREATE TABLE idt.customer_setting (
  customer_id          uuid          NOT NULL,
  form_of_address      text          NOT NULL DEFAULT 'du',
  default_locale       text          NOT NULL DEFAULT 'de',
  time_zone            text          NOT NULL,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  created_by_kind      text          NOT NULL,
  created_by           uuid,
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  updated_by_kind      text          NOT NULL,
  updated_by           uuid,
  row_version          bigint        NOT NULL DEFAULT 1,
  CONSTRAINT customer_setting_pkey PRIMARY KEY (customer_id),
  CONSTRAINT customer_setting_customer_id_check CHECK (uuid_extract_version(customer_id) = 7),
  CONSTRAINT customer_setting_form_of_address_check CHECK (form_of_address IN ('du', 'sie')),
  CONSTRAINT customer_setting_default_locale_check CHECK (default_locale IN ('de', 'en')),
  CONSTRAINT customer_setting_time_zone_check CHECK (char_length(time_zone) BETWEEN 3 AND 64
    AND time_zone ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+){0,2}$'),
  CONSTRAINT customer_setting_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT customer_setting_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT customer_setting_row_version_check CHECK (row_version > 0)
);
CREATE TRIGGER customer_setting_touch_trg BEFORE UPDATE ON idt.customer_setting
  FOR EACH ROW EXECUTE FUNCTION idt.touch_row();
ALTER TABLE idt.customer_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE idt.customer_setting FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_setting_tenant_pol ON idt.customer_setting
  USING (customer_id = (SELECT idt.current_customer_id()))
  WITH CHECK (customer_id = (SELECT idt.current_customer_id()));

CREATE TABLE idt.preference (
  person_id            uuid          NOT NULL,
  customer_id          uuid          NOT NULL,
  locale               text          NOT NULL DEFAULT 'follow_customer',
  display_density      text          NOT NULL DEFAULT 'standard',
  colour_scheme        text          NOT NULL DEFAULT 'system',
  last_body_id         uuid,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  created_by_kind      text          NOT NULL,
  created_by           uuid,
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  updated_by_kind      text          NOT NULL,
  updated_by           uuid,
  row_version          bigint        NOT NULL DEFAULT 1,
  CONSTRAINT preference_pkey PRIMARY KEY (person_id),
  CONSTRAINT preference_locale_check CHECK (locale IN ('de', 'en', 'follow_customer')),
  CONSTRAINT preference_display_density_check CHECK (display_density IN ('standard', 'kompakt', 'gross')),
  CONSTRAINT preference_colour_scheme_check CHECK (colour_scheme IN ('system', 'light', 'dark')),
  CONSTRAINT preference_created_by_check CHECK (created_by_kind IN ('person', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT preference_updated_by_check CHECK (updated_by_kind IN ('person', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT preference_row_version_check CHECK (row_version > 0),
  CONSTRAINT preference_person_id_fkey FOREIGN KEY (person_id)
    REFERENCES idt.person (person_id) ON DELETE RESTRICT,
  CONSTRAINT preference_last_body_id_fkey FOREIGN KEY (last_body_id)
    REFERENCES idt.body (body_id) ON DELETE RESTRICT
);
CREATE INDEX preference_last_body_id_idx ON idt.preference (last_body_id) WHERE last_body_id IS NOT NULL;
CREATE TRIGGER preference_touch_trg BEFORE UPDATE ON idt.preference
  FOR EACH ROW EXECUTE FUNCTION idt.touch_row();
ALTER TABLE idt.preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE idt.preference FORCE ROW LEVEL SECURITY;
CREATE POLICY preference_tenant_pol ON idt.preference
  USING (customer_id = (SELECT idt.current_customer_id()))
  WITH CHECK (customer_id = (SELECT idt.current_customer_id()));
COMMENT ON TABLE idt.preference IS 'DB-IDT-PREFERENCE | K2 | rp-idt-person | trigger: deleted with the account erasure';
