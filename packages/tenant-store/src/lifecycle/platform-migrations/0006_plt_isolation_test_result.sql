-- gremion:phase expand
-- gremion_platform, 0006 (TASK-044): DB-PLT-ISOLATION-TEST-RESULT verbatim
-- from SCHEMA-gremion.md (:1432-1457), and the three foreign keys TASK-021
-- omitted from 0002 (SCHEMA :1512-1515, :1756-1763), added here by ALTER TABLE
-- with their SCHEMA names.
--
-- Named deviation (TASK-044 lane note A1, G10): the keys are added NOT VALID.
-- A NOT VALID key reads no existing row and checks every row written after it
-- (TRD-063: a failed result, another module's result or an unknown id is
-- refused with 23503 from now on). Validating in this file would refuse the
-- migration on a catalogue that still holds TASK-043's interim enablements
-- (references = an operator_enable_attestation id), and re-gating them needs
-- this table: a deadlock. So:
--   - module_version's key is VALIDATEd here: nothing ever wrote
--     plt.module_version.isolation_test_result_id (NULL passes MATCH SIMPLE);
--   - the two module_enablement keys stay NOT VALID until the re-gate
--     (@gremion/tenant-store/lifecycle regateEnablement, then
--     validateGateForeignKeys) finds no violating row and validates them.
-- The lint's expand rule allows a NOT VALID key only onto a table this same
-- file creates (scripts/migrations/runner/lint.mjs): the serving colour holds
-- no lock on it and reads nothing from it.
SET LOCAL lock_timeout = '5s';

CREATE TABLE plt.isolation_test_result (
  isolation_test_result_id uuid      NOT NULL DEFAULT uuidv7(),
  module_id            uuid          NOT NULL,
  test_kind            text          NOT NULL,
  passed               boolean       NOT NULL,
  run_at               timestamptz   NOT NULL,
  evidence_ref         text          NOT NULL,
  release_tip_sha      text          NOT NULL,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT isolation_test_result_pkey PRIMARY KEY (isolation_test_result_id),
  CONSTRAINT isolation_test_result_id_module_id_test_kind_passed_key
    UNIQUE (isolation_test_result_id, module_id, test_kind, passed),
  CONSTRAINT isolation_test_result_isolation_test_result_id_check
    CHECK (uuid_extract_version(isolation_test_result_id) = 7),
  CONSTRAINT isolation_test_result_test_kind_check CHECK (test_kind IN ('cross_customer', 'cross_body')),
  CONSTRAINT isolation_test_result_evidence_ref_check CHECK (char_length(evidence_ref) BETWEEN 1 AND 500),
  CONSTRAINT isolation_test_result_release_tip_sha_check
    CHECK (release_tip_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  CONSTRAINT isolation_test_result_module_id_fkey FOREIGN KEY (module_id)
    REFERENCES plt.module (module_id) ON DELETE RESTRICT
);
CREATE INDEX isolation_test_result_module_id_test_kind_run_at_idx
  ON plt.isolation_test_result (module_id, test_kind, run_at DESC);
CREATE TRIGGER isolation_test_result_append_only_trg BEFORE UPDATE ON plt.isolation_test_result
  FOR EACH ROW EXECUTE FUNCTION plt.refuse_update();
COMMENT ON TABLE plt.isolation_test_result IS 'DB-PLT-ISOLATION-TEST-RESULT | K5 | rp-plt-isolation-evidence | trigger: superseded by the next release re-run and no enablement or version still references it';

ALTER TABLE plt.module_version
  ADD CONSTRAINT module_version_isol_result_id_module_id_kind_passed_fkey
    FOREIGN KEY (isolation_test_result_id, module_id, isolation_test_kind, isolation_passed)
    REFERENCES plt.isolation_test_result (isolation_test_result_id, module_id, test_kind, passed)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE plt.module_version VALIDATE CONSTRAINT module_version_isol_result_id_module_id_kind_passed_fkey;

ALTER TABLE plt.module_enablement
  ADD CONSTRAINT module_enablement_isol_result_id_module_id_kind_passed_fkey
    FOREIGN KEY (isolation_test_result_id, module_id, isolation_test_kind, isolation_passed)
    REFERENCES plt.isolation_test_result (isolation_test_result_id, module_id, test_kind, passed)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE plt.module_enablement
  ADD CONSTRAINT module_enablement_xbody_result_id_module_id_kind_passed_fkey
    FOREIGN KEY (cross_body_test_result_id, module_id, cross_body_test_kind, isolation_passed)
    REFERENCES plt.isolation_test_result (isolation_test_result_id, module_id, test_kind, passed)
    ON DELETE RESTRICT NOT VALID;
