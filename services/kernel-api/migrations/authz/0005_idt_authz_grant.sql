-- gremion:phase expand
-- kernel-api chain, authz (TASK-081): the (tenant, body) grant table. SCHEMA-gremion.md DB-IDT-*; deviations:
-- capability.module_id is NULL for the kernel idt.* capabilities (Q5); authz_grant.grant_id
-- has no DEFAULT uuidv7() (writers mint v7, TASK-079 Q5 precedent).
SET lock_timeout = '5s';

CREATE FUNCTION idt.authz_grant_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  mutable text[] := ARRAY['state', 'revoked_at', 'revoked_by_kind', 'revoked_by', 'revoke_reason',
                          'retention_profile_id', 'updated_at', 'updated_by_kind', 'updated_by',
                          'row_version'];
BEGIN
  IF OLD.state IN ('expired', 'revoked') THEN
    RAISE EXCEPTION 'grant % is closed', OLD.grant_id USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'grant % is never edited in place; revoke it and grant anew', OLD.grant_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND (OLD.state, NEW.state) NOT IN
       (('scheduled', 'active'), ('scheduled', 'revoked'), ('active', 'expired'), ('active', 'revoked')) THEN
    RAISE EXCEPTION 'grant % cannot move from % to %', OLD.grant_id, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TABLE idt.authz_grant (
  grant_id             uuid          NOT NULL,
  customer_id          uuid          NOT NULL,
  body_id              uuid          NOT NULL,
  subject_person_id    uuid          NOT NULL,
  grant_kind           text          NOT NULL,
  role_key             text,
  capability_key       text,
  resource_kind        text,
  resource_id          uuid,
  valid_from           timestamptz   NOT NULL DEFAULT now(),
  valid_until          timestamptz,
  granter_kind         text          NOT NULL,
  granted_by           uuid,
  source               text          NOT NULL,
  mandate_beschluss_ref uuid,
  origin_membership_id uuid,
  origin_tenure_id     uuid,
  state                text          NOT NULL,
  revoked_at           timestamptz,
  revoked_by_kind      text,
  revoked_by           uuid,
  revoke_reason        text,
  retention_profile_id text          GENERATED ALWAYS AS (CASE WHEN state IN ('expired', 'revoked')
                                       THEN 'rp-idt-grant-history' ELSE 'rp-idt-grant' END) STORED,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  created_by_kind      text          NOT NULL,
  created_by           uuid,
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  updated_by_kind      text          NOT NULL,
  updated_by           uuid,
  row_version          bigint        NOT NULL DEFAULT 1,
  CONSTRAINT authz_grant_pkey PRIMARY KEY (grant_id),
  CONSTRAINT authz_grant_grant_id_check CHECK (uuid_extract_version(grant_id) = 7),
  CONSTRAINT authz_grant_grant_kind_check CHECK (grant_kind IN ('role', 'capability')),
  CONSTRAINT authz_grant_key_check CHECK ((grant_kind = 'role') = (role_key IS NOT NULL)
    AND (grant_kind = 'capability') = (capability_key IS NOT NULL)),
  CONSTRAINT authz_grant_resource_kind_check CHECK (resource_kind ~ '^[a-z][a-z_]{0,39}$'),
  CONSTRAINT authz_grant_resource_check CHECK ((resource_kind IS NULL) = (resource_id IS NULL)),
  CONSTRAINT authz_grant_valid_until_check CHECK (valid_until > valid_from),
  CONSTRAINT authz_grant_granter_check CHECK (granter_kind IN ('person', 'operator', 'system')
    AND (granter_kind = 'system') = (granted_by IS NULL)),
  CONSTRAINT authz_grant_source_check CHECK (source IN ('control_panel', 'customer_admin', 'provisioning',
    'import', 'membership_default', 'seat_tenure', 'meeting_role', 'mandate', 'migration')),
  CONSTRAINT authz_grant_origin_check CHECK (
        (source = 'membership_default') = (origin_membership_id IS NOT NULL)
    AND (source = 'seat_tenure') = (origin_tenure_id IS NOT NULL)
    AND (source <> 'mandate' OR mandate_beschluss_ref IS NOT NULL)
    AND (source <> 'meeting_role'
         OR (resource_kind IS NOT DISTINCT FROM 'meeting' AND valid_until IS NOT NULL))),
  CONSTRAINT authz_grant_state_check CHECK (state IN ('scheduled', 'active', 'expired', 'revoked')),
  CONSTRAINT authz_grant_expired_check CHECK (state <> 'expired' OR valid_until IS NOT NULL),
  CONSTRAINT authz_grant_revoke_reason_check CHECK (revoke_reason IN ('manual', 'origin_ended',
    'meeting_closed', 'meeting_cancelled', 'person_disabled', 'module_disabled')),
  CONSTRAINT authz_grant_revoked_by_check CHECK (
        (revoked_by IS NOT NULL) = coalesce(revoked_by_kind IN ('person', 'operator'), false)
    AND (revoked_by_kind IS NULL OR revoked_by_kind IN ('person', 'operator', 'system'))),
  CONSTRAINT authz_grant_revocation_check CHECK (
        (state = 'revoked') = (revoked_at IS NOT NULL)
    AND (revoked_at IS NULL) = (revoke_reason IS NULL)
    AND (revoked_at IS NULL) = (revoked_by_kind IS NULL)),
  CONSTRAINT authz_grant_created_by_check CHECK (created_by_kind IN ('person', 'operator', 'system')
    AND (created_by_kind = 'system') = (created_by IS NULL)),
  CONSTRAINT authz_grant_updated_by_check CHECK (updated_by_kind IN ('person', 'operator', 'system')
    AND (updated_by_kind = 'system') = (updated_by IS NULL)),
  CONSTRAINT authz_grant_row_version_check CHECK (row_version > 0),
  CONSTRAINT authz_grant_body_id_fkey FOREIGN KEY (body_id) REFERENCES idt.body (body_id) ON DELETE RESTRICT,
  CONSTRAINT authz_grant_subject_person_id_fkey FOREIGN KEY (subject_person_id)
    REFERENCES idt.person (person_id) ON DELETE RESTRICT,
  CONSTRAINT authz_grant_role_key_fkey FOREIGN KEY (role_key)
    REFERENCES idt.role (role_key) ON DELETE RESTRICT,
  CONSTRAINT authz_grant_capability_key_fkey FOREIGN KEY (capability_key)
    REFERENCES idt.capability (capability_key) ON DELETE RESTRICT,
  CONSTRAINT authz_grant_origin_membership_id_fkey FOREIGN KEY (origin_membership_id)
    REFERENCES idt.membership (membership_id) ON DELETE RESTRICT,
  CONSTRAINT authz_grant_origin_tenure_id_fkey FOREIGN KEY (origin_tenure_id)
    REFERENCES idt.tenure (tenure_id) ON DELETE RESTRICT
);
CREATE INDEX authz_grant_subject_person_id_body_id_idx ON idt.authz_grant (subject_person_id, body_id);
CREATE INDEX authz_grant_live_idx ON idt.authz_grant (subject_person_id, body_id, valid_from)
  WHERE state IN ('scheduled', 'active');
CREATE INDEX authz_grant_body_id_idx ON idt.authz_grant (body_id);
CREATE INDEX authz_grant_role_key_idx ON idt.authz_grant (role_key) WHERE role_key IS NOT NULL;
CREATE INDEX authz_grant_capability_key_idx ON idt.authz_grant (capability_key)
  WHERE capability_key IS NOT NULL;
CREATE INDEX authz_grant_origin_membership_id_idx ON idt.authz_grant (origin_membership_id)
  WHERE origin_membership_id IS NOT NULL;
CREATE INDEX authz_grant_origin_tenure_id_idx ON idt.authz_grant (origin_tenure_id)
  WHERE origin_tenure_id IS NOT NULL;
CREATE INDEX authz_grant_resource_kind_resource_id_idx ON idt.authz_grant (resource_kind, resource_id)
  WHERE resource_id IS NOT NULL;
CREATE TRIGGER authz_grant_guard_trg BEFORE UPDATE ON idt.authz_grant
  FOR EACH ROW EXECUTE FUNCTION idt.authz_grant_guard();
CREATE TRIGGER authz_grant_touch_trg BEFORE UPDATE ON idt.authz_grant
  FOR EACH ROW EXECUTE FUNCTION idt.touch_row();
ALTER TABLE idt.authz_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE idt.authz_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY authz_grant_tenant_pol ON idt.authz_grant
  USING (customer_id = (SELECT idt.current_customer_id()))
  WITH CHECK (customer_id = (SELECT idt.current_customer_id()));
COMMENT ON TABLE idt.authz_grant IS 'DB-IDT-GRANT | K2 or K5 per row | retention_profile_id | trigger: active: state leaves active; expired or revoked: valid_until or revoked_at + audit window';
COMMENT ON COLUMN idt.authz_grant.resource_id IS 'xref to the resource named by resource_kind (DB-GOV-MEETING for meeting)';
COMMENT ON COLUMN idt.authz_grant.mandate_beschluss_ref IS 'xref DB-GOV-RESOLUTION';
COMMENT ON COLUMN idt.authz_grant.granted_by IS 'xref DB-IDT-PERSON or DB-OAC-OPERATOR by granter_kind';
COMMENT ON COLUMN idt.authz_grant.revoked_by IS 'xref DB-IDT-PERSON or DB-OAC-OPERATOR by revoked_by_kind';
