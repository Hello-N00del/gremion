-- gremion_platform, 0004 (TASK-043 G1, Q2, Q19): the provisioning ledger and
-- the interim enable attestations.
--
-- plt.provisioning_step is DB-PLT-PROVISIONING-STEP verbatim from
-- SCHEMA-gremion.md (:1798-1825) with ONE named deviation (TASK-043 Q2): two
-- appended kinds, broker_account_created (step_order 7) and
-- mail_principal_issued (step_order 8). step_order is SCHEMA's generated
-- column; it is not the execution order (@gremion/provisioning
-- EXECUTION_ORDER runs 7 and 8 before 6). "Completed" = all eight kinds done.
CREATE TABLE plt.provisioning_step (
  provisioning_step_id uuid          NOT NULL DEFAULT uuidv7(),
  customer_id          uuid          NOT NULL,
  step_kind            text          NOT NULL,
  step_order           smallint      GENERATED ALWAYS AS (CASE step_kind
                                       WHEN 'realm_created' THEN 1 WHEN 'database_created' THEN 2
                                       WHEN 'domain_bound' THEN 3 WHEN 'storage_prefix_reserved' THEN 4
                                       WHEN 'first_body_created' THEN 5 WHEN 'first_accounts_created' THEN 6
                                       WHEN 'broker_account_created' THEN 7 WHEN 'mail_principal_issued' THEN 8
                                     END) STORED,
  status               text          NOT NULL,
  actor_operator_id    uuid,
  occurred_at          timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT provisioning_step_pkey PRIMARY KEY (provisioning_step_id),
  CONSTRAINT provisioning_step_provisioning_step_id_check
    CHECK (uuid_extract_version(provisioning_step_id) = 7),
  CONSTRAINT provisioning_step_step_kind_check CHECK (step_kind IN ('realm_created', 'database_created',
    'domain_bound', 'storage_prefix_reserved', 'first_body_created', 'first_accounts_created',
    'broker_account_created', 'mail_principal_issued')),
  CONSTRAINT provisioning_step_status_check CHECK (status IN ('pending', 'done', 'failed'))
);
CREATE UNIQUE INDEX provisioning_step_customer_id_step_kind_key ON plt.provisioning_step (customer_id, step_kind)
  WHERE status = 'done';
CREATE INDEX provisioning_step_customer_id_step_order_idx ON plt.provisioning_step (customer_id, step_order);
CREATE INDEX provisioning_step_occurred_at_idx ON plt.provisioning_step (occurred_at);
CREATE TRIGGER provisioning_step_append_only_trg BEFORE UPDATE ON plt.provisioning_step
  FOR EACH ROW EXECUTE FUNCTION plt.refuse_update();
COMMENT ON TABLE plt.provisioning_step IS 'DB-PLT-PROVISIONING-STEP | K5 | rp-plt-provisioning-log | trigger: occurred_at + derived application-log window';
COMMENT ON COLUMN plt.provisioning_step.customer_id IS 'xref DB-TNT-CUSTOMER';
COMMENT ON COLUMN plt.provisioning_step.actor_operator_id IS 'xref DB-OAC-OPERATOR; null when the step ran automatically';

-- TASK-043 Q19 [A], named deviation until TASK-044: the operator attestation
-- that stands in for the level-1 gate's two references (isolation test result
-- and DPIA decision) on an interim enable. One row per (customer, module),
-- minted BEFORE enableModule and re-read on every resume, so a resumed enable
-- writes the same references. The verbatim provisioning_step has no detail
-- column, so the attestation is its own append-only table rather than a column
-- added to SCHEMA's table. TASK-044 re-gates or backfills these rows before it
-- adds the plt.isolation_test_result foreign keys (or adds them NOT VALID).
CREATE TABLE plt.operator_enable_attestation (
  attestation_id       uuid          NOT NULL DEFAULT uuidv7(),
  customer_id          uuid          NOT NULL,
  module_key           text          NOT NULL,
  operator_id          uuid          NOT NULL,
  enable_list          text[]        NOT NULL,
  basis                text          NOT NULL,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT operator_enable_attestation_pkey PRIMARY KEY (attestation_id),
  CONSTRAINT operator_enable_attestation_customer_id_module_key_key UNIQUE (customer_id, module_key),
  CONSTRAINT operator_enable_attestation_attestation_id_check CHECK (uuid_extract_version(attestation_id) = 7),
  CONSTRAINT operator_enable_attestation_module_key_check CHECK (module_key ~ '^[a-z][a-z_]{1,39}$'),
  CONSTRAINT operator_enable_attestation_enable_list_check CHECK (module_key = ANY (enable_list)),
  CONSTRAINT operator_enable_attestation_basis_check CHECK (basis = 'interim gate, no isolation test (TASK-044)')
);
CREATE TRIGGER operator_enable_attestation_append_only_trg BEFORE UPDATE ON plt.operator_enable_attestation
  FOR EACH ROW EXECUTE FUNCTION plt.refuse_update();
COMMENT ON TABLE plt.operator_enable_attestation IS 'TASK-043 Q19 [A] interim enable attestation | K5 | rp-plt-provisioning-log | trigger: TASK-044 re-gates the enablement';
COMMENT ON COLUMN plt.operator_enable_attestation.customer_id IS 'xref DB-TNT-CUSTOMER';
COMMENT ON COLUMN plt.operator_enable_attestation.operator_id IS 'xref DB-OAC-OPERATOR (the ops realm user who passed --enable)';
