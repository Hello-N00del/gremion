-- gremion:phase expand
-- kernel-api chain, file 2 (TASK-080-a): person, wahlperiode, membership (gist EXCLUDE), tenure (gist EXCLUDE),
-- customer_setting, preference. Needs btree_gist, which the migrate hook creates in schema idt before the run
-- (the lint refuses CREATE EXTENSION in a migration). Skipped on purpose: role, capability (TASK-081),
-- correction (TASK-130), grant, import_*, idp_projection, branding.
SET lock_timeout = '5s';

-- DB-IDT-PERSON
CREATE TABLE idt.person (
  person_id            uuid          NOT NULL DEFAULT uuidv7(),
  customer_id          uuid          NOT NULL,
  idp_subject          text,
  display_name         text,
  email                text,
  email_lower          text          GENERATED ALWAYS AS (lower(email)) STORED,
  account_state        text          NOT NULL DEFAULT 'invited',
  pseudonym            text          NOT NULL,
  invited_at           timestamptz   NOT NULL DEFAULT now(),
  activated_at         timestamptz,
  disabled_at          timestamptz,
  erased_at            timestamptz,
  erasure_trigger_kind text,
  erasure_request_ref  uuid,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  created_by_kind      text          NOT NULL,
  created_by           uuid,
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  updated_by_kind      text          NOT NULL,
  updated_by           uuid,
  row_version          bigint        NOT NULL DEFAULT 1,
  CONSTRAINT person_pkey PRIMARY KEY (person_id),
  CONSTRAINT person_idp_subject_key UNIQUE (idp_subject),
  CONSTRAINT person_pseudonym_key UNIQUE (pseudonym),
  CONSTRAINT person_email_lower_key UNIQUE (email_lower),
  CONSTRAINT person_person_id_check CHECK (uuid_extract_version(person_id) = 7),
  CONSTRAINT person_idp_subject_check CHECK (char_length(idp_subject) BETWEEN 1 AND 255),
  CONSTRAINT person_display_name_check CHECK (char_length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT person_email_check CHECK (char_length(email) BETWEEN 3 AND 254
    AND email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  CONSTRAINT person_account_state_check
    CHECK (account_state IN ('invited', 'active', 'disabled', 'erased')),
  CONSTRAINT person_pseudonym_check CHECK (char_length(pseudonym) BETWEEN 1 AND 64),
  CONSTRAINT person_erasure_trigger_kind_check
    CHECK (erasure_trigger_kind IN ('admin_erasure', 'subject_request', 'retention_expiry')),
  CONSTRAINT person_state_times_check CHECK (
        (account_state = 'erased') = (erased_at IS NOT NULL)
    AND (account_state = 'erased') = (erasure_trigger_kind IS NOT NULL)
    AND (erasure_trigger_kind IS NOT DISTINCT FROM 'subject_request') = (erasure_request_ref IS NOT NULL)
    AND (account_state <> 'active' OR (activated_at IS NOT NULL AND idp_subject IS NOT NULL))
    AND (account_state <> 'disabled' OR disabled_at IS NOT NULL)),
  CONSTRAINT person_erasure_check CHECK (
       (account_state = 'erased' AND display_name IS NULL AND email IS NULL AND idp_subject IS NULL)
    OR (account_state <> 'erased' AND display_name IS NOT NULL AND email IS NOT NULL)),
  CONSTRAINT person_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT person_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT person_row_version_check CHECK (row_version > 0)
);
CREATE TRIGGER person_touch_trg BEFORE UPDATE ON idt.person
  FOR EACH ROW EXECUTE FUNCTION idt.touch_row();
ALTER TABLE idt.person ENABLE ROW LEVEL SECURITY;
ALTER TABLE idt.person FORCE ROW LEVEL SECURITY;
CREATE POLICY person_tenant_pol ON idt.person
  USING (customer_id = (SELECT idt.current_customer_id()))
  WITH CHECK (customer_id = (SELECT idt.current_customer_id()));
COMMENT ON TABLE idt.person IS 'DB-IDT-PERSON | K2 | rp-idt-person | trigger: admin_erasure, subject_request or retention_expiry; personal columns erased in place, person_id and pseudonym survive';
COMMENT ON COLUMN idt.person.erasure_request_ref IS 'xref DB-OPS-SUBJECT-ERASURE-REQUEST';

-- DB-IDT-WAHLPERIODE
CREATE TABLE idt.wahlperiode (
  wahlperiode_id       uuid          NOT NULL DEFAULT uuidv7(),
  customer_id          uuid          NOT NULL,
  body_id              uuid          NOT NULL,
  org_unit_id          uuid,
  label                text          NOT NULL,
  starts_on            date          NOT NULL,
  ends_on              date          NOT NULL,
  state                text          NOT NULL DEFAULT 'planned',
  warning_codes        text[]        NOT NULL DEFAULT '{}',
  created_at           timestamptz   NOT NULL DEFAULT now(),
  created_by_kind      text          NOT NULL,
  created_by           uuid,
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  updated_by_kind      text          NOT NULL,
  updated_by           uuid,
  row_version          bigint        NOT NULL DEFAULT 1,
  CONSTRAINT wahlperiode_pkey PRIMARY KEY (wahlperiode_id),
  CONSTRAINT wahlperiode_wahlperiode_id_body_id_key UNIQUE (wahlperiode_id, body_id),
  CONSTRAINT wahlperiode_wahlperiode_id_check CHECK (uuid_extract_version(wahlperiode_id) = 7),
  CONSTRAINT wahlperiode_label_check CHECK (char_length(label) BETWEEN 1 AND 100),
  CONSTRAINT wahlperiode_ends_on_check CHECK (starts_on < ends_on),
  CONSTRAINT wahlperiode_state_check CHECK (state IN ('planned', 'current', 'closed')),
  CONSTRAINT wahlperiode_warning_codes_check CHECK (cardinality(warning_codes) <= 20
    AND array_to_string(warning_codes, ',') ~ '^([a-z][a-z0-9_]{0,62}(,[a-z][a-z0-9_]{0,62})*)?$'),
  CONSTRAINT wahlperiode_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT wahlperiode_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT wahlperiode_row_version_check CHECK (row_version > 0),
  CONSTRAINT wahlperiode_body_id_fkey FOREIGN KEY (body_id) REFERENCES idt.body (body_id) ON DELETE RESTRICT,
  CONSTRAINT wahlperiode_org_unit_id_body_id_fkey FOREIGN KEY (org_unit_id, body_id)
    REFERENCES idt.org_unit (org_unit_id, body_id) ON DELETE RESTRICT
);
CREATE INDEX wahlperiode_body_id_idx ON idt.wahlperiode (body_id);
CREATE INDEX wahlperiode_org_unit_id_body_id_idx ON idt.wahlperiode (org_unit_id, body_id)
  WHERE org_unit_id IS NOT NULL;
CREATE TRIGGER wahlperiode_no_delete_trg BEFORE DELETE ON idt.wahlperiode
  FOR EACH ROW EXECUTE FUNCTION idt.refuse_delete();
CREATE TRIGGER wahlperiode_no_truncate_trg BEFORE TRUNCATE ON idt.wahlperiode
  FOR EACH STATEMENT EXECUTE FUNCTION idt.refuse_truncate();
CREATE TRIGGER wahlperiode_touch_trg BEFORE UPDATE ON idt.wahlperiode
  FOR EACH ROW EXECUTE FUNCTION idt.touch_row();
ALTER TABLE idt.wahlperiode ENABLE ROW LEVEL SECURITY;
ALTER TABLE idt.wahlperiode FORCE ROW LEVEL SECURITY;
CREATE POLICY wahlperiode_tenant_pol ON idt.wahlperiode
  USING (customer_id = (SELECT idt.current_customer_id()))
  WITH CHECK (customer_id = (SELECT idt.current_customer_id()));
COMMENT ON TABLE idt.wahlperiode IS 'DB-IDT-WAHLPERIODE | K3 | rp-idt-structure | trigger: customer erased (database dropped)';

-- DB-IDT-MEMBERSHIP
CREATE FUNCTION idt.membership_derive() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.body_adopts_beschluesse := coalesce((
      SELECT k.may_adopt_beschluesse = 'yes'
        FROM idt.body AS b
        JOIN idt.org_unit_kind AS k ON k.kind_key = b.kind_key AND k.level = b.kind_level
       WHERE b.body_id = NEW.body_id), false);
  ELSE
    -- body_adopts_beschluesse was derived from THIS body's kind at insert; a membership moved to another body would keep
    -- the first body's answer. A membership is ended and a new one started instead.
    IF NEW.body_id IS DISTINCT FROM OLD.body_id THEN
      RAISE EXCEPTION 'body_id of membership % is immutable', OLD.membership_id
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.body_adopts_beschluesse := OLD.body_adopts_beschluesse;
  END IF;
  RETURN NEW;
END
$$;

CREATE TABLE idt.membership (
  membership_id        uuid          NOT NULL DEFAULT uuidv7(),
  customer_id          uuid          NOT NULL,
  body_id              uuid          NOT NULL,
  org_unit_id          uuid,
  person_id            uuid          NOT NULL,
  participation_kind   text          NOT NULL,
  voting               boolean       NOT NULL,
  body_adopts_beschluesse boolean    NOT NULL DEFAULT false,
  valid_from           date          NOT NULL,
  valid_until          date,
  wahlperiode_id       uuid,
  end_reason           text,
  warning_codes        text[]        NOT NULL DEFAULT '{}',
  source               text          NOT NULL,
  retention_profile_id text          GENERATED ALWAYS AS (CASE
                                       WHEN voting AND body_adopts_beschluesse
                                        AND participation_kind IN ('elected_member', 'employee')
                                       THEN 'rp-idt-membership-governance'
                                       ELSE 'rp-idt-membership' END) STORED,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  created_by_kind      text          NOT NULL,
  created_by           uuid,
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  updated_by_kind      text          NOT NULL,
  updated_by           uuid,
  row_version          bigint        NOT NULL DEFAULT 1,
  CONSTRAINT membership_pkey PRIMARY KEY (membership_id),
  CONSTRAINT membership_membership_id_check CHECK (uuid_extract_version(membership_id) = 7),
  CONSTRAINT membership_participation_kind_check CHECK (participation_kind IN ('elected_member',
    'non_voting_helper', 'employee', 'initiative_member', 'initiative_lead')),
  CONSTRAINT membership_voting_check CHECK (participation_kind <> 'non_voting_helper' OR NOT voting),
  CONSTRAINT membership_valid_until_check CHECK (valid_until >= valid_from),
  CONSTRAINT membership_end_reason_check CHECK (end_reason IN ('term_end', 'resigned', 'removed',
    'data_correction')),
  CONSTRAINT membership_ending_check CHECK (end_reason IS NULL OR valid_until IS NOT NULL),
  CONSTRAINT membership_warning_codes_check CHECK (cardinality(warning_codes) <= 20
    AND array_to_string(warning_codes, ',') ~ '^([a-z][a-z0-9_]{0,62}(,[a-z][a-z0-9_]{0,62})*)?$'),
  CONSTRAINT membership_source_check CHECK (source IN ('admin', 'control_panel', 'import', 'provisioning')),
  CONSTRAINT membership_person_id_body_id_unit_kind_validity_excl EXCLUDE USING gist (person_id WITH =,
    body_id WITH =, (coalesce(org_unit_id, body_id)) WITH =, participation_kind WITH =,
    daterange(valid_from, valid_until, '[]') WITH &&),
  CONSTRAINT membership_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT membership_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT membership_row_version_check CHECK (row_version > 0),
  CONSTRAINT membership_body_id_fkey FOREIGN KEY (body_id) REFERENCES idt.body (body_id) ON DELETE RESTRICT,
  CONSTRAINT membership_org_unit_id_body_id_fkey FOREIGN KEY (org_unit_id, body_id)
    REFERENCES idt.org_unit (org_unit_id, body_id) ON DELETE RESTRICT,
  CONSTRAINT membership_person_id_fkey FOREIGN KEY (person_id)
    REFERENCES idt.person (person_id) ON DELETE RESTRICT,
  CONSTRAINT membership_wahlperiode_id_body_id_fkey FOREIGN KEY (wahlperiode_id, body_id)
    REFERENCES idt.wahlperiode (wahlperiode_id, body_id) ON DELETE RESTRICT
);
CREATE INDEX membership_body_id_idx ON idt.membership (body_id);
CREATE INDEX membership_person_id_idx ON idt.membership (person_id);
CREATE INDEX membership_org_unit_id_body_id_idx ON idt.membership (org_unit_id, body_id)
  WHERE org_unit_id IS NOT NULL;
CREATE INDEX membership_wahlperiode_id_body_id_idx ON idt.membership (wahlperiode_id, body_id)
  WHERE wahlperiode_id IS NOT NULL;
CREATE TRIGGER membership_derive_trg BEFORE INSERT OR UPDATE ON idt.membership
  FOR EACH ROW EXECUTE FUNCTION idt.membership_derive();
CREATE TRIGGER membership_touch_trg BEFORE UPDATE ON idt.membership
  FOR EACH ROW EXECUTE FUNCTION idt.touch_row();
ALTER TABLE idt.membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE idt.membership FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_tenant_pol ON idt.membership
  USING (customer_id = (SELECT idt.current_customer_id()))
  WITH CHECK (customer_id = (SELECT idt.current_customer_id()));
COMMENT ON TABLE idt.membership IS 'DB-IDT-MEMBERSHIP | K3 or K2 per row | retention_profile_id | trigger: valid_until + archive period (governance) or + grace (helper, initiative)';

-- DB-IDT-TENURE
CREATE TABLE idt.tenure (
  tenure_id            uuid          NOT NULL DEFAULT uuidv7(),
  customer_id          uuid          NOT NULL,
  body_id              uuid          NOT NULL,
  seat_id              uuid          NOT NULL,
  seat_holder_cardinality text       NOT NULL,
  person_id            uuid          NOT NULL,
  wahlperiode_id       uuid,
  starts_on            date          NOT NULL,
  planned_end_on       date,
  ended_on             date,
  end_reason           text,
  source               text          NOT NULL,
  mandate_beschluss_ref uuid,
  warning_codes        text[]        NOT NULL DEFAULT '{}',
  public_released_at   timestamptz,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  created_by_kind      text          NOT NULL,
  created_by           uuid,
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  updated_by_kind      text          NOT NULL,
  updated_by           uuid,
  row_version          bigint        NOT NULL DEFAULT 1,
  CONSTRAINT tenure_pkey PRIMARY KEY (tenure_id),
  CONSTRAINT tenure_tenure_id_check CHECK (uuid_extract_version(tenure_id) = 7),
  CONSTRAINT tenure_seat_holder_cardinality_check CHECK (seat_holder_cardinality IN ('single', 'multiple')),
  CONSTRAINT tenure_planned_end_on_check CHECK (planned_end_on >= starts_on),
  CONSTRAINT tenure_ended_on_check CHECK (ended_on >= starts_on),
  CONSTRAINT tenure_end_reason_check CHECK (end_reason IN ('term_end', 'resigned', 'removed', 'succeeded',
    'data_correction')),
  CONSTRAINT tenure_ending_check CHECK ((ended_on IS NULL) = (end_reason IS NULL)),
  CONSTRAINT tenure_source_check CHECK (source IN ('election', 'delegation', 'appointment', 'succession')),
  CONSTRAINT tenure_warning_codes_check CHECK (cardinality(warning_codes) <= 20
    AND array_to_string(warning_codes, ',') ~ '^([a-z][a-z0-9_]{0,62}(,[a-z][a-z0-9_]{0,62})*)?$'),
  CONSTRAINT tenure_seat_id_starts_on_ended_on_excl EXCLUDE USING gist (seat_id WITH =,
    daterange(starts_on, ended_on, '[]') WITH &&) WHERE (seat_holder_cardinality = 'single'),
  CONSTRAINT tenure_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT tenure_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT tenure_row_version_check CHECK (row_version > 0),
  CONSTRAINT tenure_body_id_fkey FOREIGN KEY (body_id) REFERENCES idt.body (body_id) ON DELETE RESTRICT,
  CONSTRAINT tenure_seat_id_body_id_seat_holder_cardinality_fkey
    FOREIGN KEY (seat_id, body_id, seat_holder_cardinality)
    REFERENCES idt.seat (seat_id, body_id, holder_cardinality) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT tenure_person_id_fkey FOREIGN KEY (person_id)
    REFERENCES idt.person (person_id) ON DELETE RESTRICT,
  CONSTRAINT tenure_wahlperiode_id_body_id_fkey FOREIGN KEY (wahlperiode_id, body_id)
    REFERENCES idt.wahlperiode (wahlperiode_id, body_id) ON DELETE RESTRICT
);
CREATE INDEX tenure_body_id_idx ON idt.tenure (body_id);
CREATE INDEX tenure_seat_id_body_id_seat_holder_cardinality_idx
  ON idt.tenure (seat_id, body_id, seat_holder_cardinality);
CREATE INDEX tenure_person_id_idx ON idt.tenure (person_id);
CREATE INDEX tenure_wahlperiode_id_body_id_idx ON idt.tenure (wahlperiode_id, body_id)
  WHERE wahlperiode_id IS NOT NULL;
CREATE TRIGGER tenure_touch_trg BEFORE UPDATE ON idt.tenure
  FOR EACH ROW EXECUTE FUNCTION idt.touch_row();
ALTER TABLE idt.tenure ENABLE ROW LEVEL SECURITY;
ALTER TABLE idt.tenure FORCE ROW LEVEL SECURITY;
CREATE POLICY tenure_tenant_pol ON idt.tenure
  USING (customer_id = (SELECT idt.current_customer_id()))
  WITH CHECK (customer_id = (SELECT idt.current_customer_id()));
COMMENT ON TABLE idt.tenure IS 'DB-IDT-TENURE | K3 | rp-idt-tenure | trigger: ended_on + archive or Satzung period; pseudonymised on request (TRD-160)';
COMMENT ON COLUMN idt.tenure.mandate_beschluss_ref IS 'xref DB-GOV-RESOLUTION';
COMMENT ON COLUMN idt.tenure.public_released_at IS 'round 4 (residuals, M1, optional half): nullable, set and revoked only by the tenure''s own person; source for IDT''s public-by-release read API and DB-PUB-OFFICEHOLDER-LISTING [D R21-18]';

-- DB-IDT-CUSTOMERSETTING
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
COMMENT ON TABLE idt.customer_setting IS 'DB-IDT-CUSTOMERSETTING | K2 | rp-idt-customer-config | trigger: customer erased (database dropped)';
COMMENT ON COLUMN idt.customer_setting.customer_id IS 'xref DB-TNT-CUSTOMER';
COMMENT ON COLUMN idt.customer_setting.updated_by IS 'xref DB-IDT-PERSON or DB-OAC-OPERATOR by updated_by_kind';

-- DB-IDT-PREFERENCE
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
