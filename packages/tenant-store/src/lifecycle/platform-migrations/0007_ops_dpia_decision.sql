-- gremion:phase expand
-- gremion_platform, 0007 (TASK-044, brief Q3): DB-OPS-DPIA-DECISION verbatim
-- from SCHEMA-gremion.md (:2420-2446). The enablement references it as an
-- xref (plt.module_enablement.dpia_decision_id, no FK: SCHEMA :1776, :1788);
-- the level-1 gate (lifecycle/enable-gate) reads the latest decision for the
-- (customer, module) pair and refuses one without document_ref (TRD-161).
SET LOCAL lock_timeout = '5s';

CREATE TABLE ops.dpia_decision (
  dpia_decision_id     uuid          NOT NULL DEFAULT uuidv7(),
  customer_id          uuid          NOT NULL,
  module_id            uuid          NOT NULL,
  requires_dpia        text          NOT NULL,
  reason_codes         text[]        NOT NULL,
  document_ref         text,
  decided_by_kind      text          NOT NULL,
  decided_by           uuid          NOT NULL,
  decided_at           timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT dpia_decision_pkey PRIMARY KEY (dpia_decision_id),
  CONSTRAINT dpia_decision_dpia_decision_id_check CHECK (uuid_extract_version(dpia_decision_id) = 7),
  CONSTRAINT dpia_decision_requires_dpia_check CHECK (requires_dpia IN ('yes', 'no', 'not_applicable')),
  CONSTRAINT dpia_decision_reason_codes_check CHECK (cardinality(reason_codes) BETWEEN 1 AND 20
    AND array_to_string(reason_codes, ',') ~ '^[a-z][a-z0-9_]{0,62}(,[a-z][a-z0-9_]{0,62})*$'),
  CONSTRAINT dpia_decision_document_ref_check CHECK (char_length(document_ref) BETWEEN 1 AND 500),
  CONSTRAINT dpia_decision_document_required_check CHECK (requires_dpia <> 'yes' OR document_ref IS NOT NULL),
  CONSTRAINT dpia_decision_decided_by_kind_check CHECK (decided_by_kind IN ('person', 'operator'))
);
CREATE INDEX dpia_decision_customer_id_module_id_decided_at_idx
  ON ops.dpia_decision (customer_id, module_id, decided_at DESC);
CREATE TRIGGER dpia_decision_append_only_trg BEFORE UPDATE ON ops.dpia_decision
  FOR EACH ROW EXECUTE FUNCTION ops.refuse_update();
COMMENT ON TABLE ops.dpia_decision IS 'DB-OPS-DPIA-DECISION | K5 | rp-ops-dpia-decision | trigger: superseded by the next decision for the (customer, module) pair + audit window';
COMMENT ON COLUMN ops.dpia_decision.customer_id IS 'xref DB-TNT-CUSTOMER';
COMMENT ON COLUMN ops.dpia_decision.module_id IS 'xref DB-PLT-MODULE';
COMMENT ON COLUMN ops.dpia_decision.decided_by IS 'xref DB-IDT-PERSON or DB-OAC-OPERATOR by decided_by_kind';
