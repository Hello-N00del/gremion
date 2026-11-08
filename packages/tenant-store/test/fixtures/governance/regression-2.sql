-- Beispiel: Laufzeitabfrage des Job-Sweepers (runtime query, not DDL; not executed by the schema check)
BEGIN;
SELECT set_config('gremion.customer_id', '01999999-0000-7000-8000-00000000c001', true) AS tenant;
CREATE OR REPLACE FUNCTION gov.redaction_covers(p_redaction_id uuid, p_table_name text,
                                                p_row_key text, p_column_names text[])
  RETURNS boolean LANGUAGE sql STABLE
  RETURN p_redaction_id = '01999999-0000-7000-8000-0000000e0001'
     AND p_table_name = 'notice_override' AND p_column_names = ARRAY['reason'];
WITH m AS (
  INSERT INTO gov.meeting (customer_id, body_id, title, scheduled_start, notice_period_days_snapshot,
                           notice_due_at, created_by_kind, updated_by_kind)
  VALUES (gov.current_customer_id(), uuidv7(), 'Sitzung', now() + interval '1 day', 7,
          now() - interval '6 days', 'system', 'system')
  RETURNING customer_id, body_id, meeting_id
), s AS (
  INSERT INTO gov.agenda_snapshot (customer_id, body_id, meeting_id, version, content_hash,
                                   rendered_content, created_by_kind)
  SELECT customer_id, body_id, meeting_id, 1, sha256('x'::bytea), 'TOP 1', 'system' FROM m
  RETURNING customer_id, body_id, meeting_id, agenda_snapshot_id
), q AS (
  INSERT INTO gov.quorum_check (customer_id, body_id, meeting_id, present_voting, statutory_members,
                                required, result, created_by_kind)
  SELECT customer_id, body_id, meeting_id, 1, 1, 1, 'quorate', 'system' FROM m
)
INSERT INTO gov.invitation (customer_id, body_id, meeting_id, version, agenda_snapshot_id, state,
                            notice_met, created_by_kind, updated_by_kind)
SELECT customer_id, body_id, meeting_id, 1, agenda_snapshot_id, 'blocked', false, 'system', 'system'
  FROM s;
INSERT INTO gov.notice_override (customer_id, body_id, invitation_id, meeting_id, days_short, reason,
                                 curing_basis_snapshot, created_by_kind, created_by)
SELECT customer_id, body_id, invitation_id, meeting_id, 6, 'Grund', 'keine Grundlage', 'person', uuidv7()
  FROM gov.invitation;
DO $$
BEGIN
  UPDATE gov.notice_override SET reason = NULL, erased_at = now();
  RAISE EXCEPTION 'expected an erasure without an active redaction to be refused';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END
$$;
DO $$
BEGIN
  UPDATE gov.notice_override SET days_short = 2;
  RAISE EXCEPTION 'expected a change to a non-erasable column to be refused';
EXCEPTION WHEN check_violation THEN NULL;
END
$$;
DO $$
BEGIN
  UPDATE gov.notice_override SET reason = 'anderer Text', erased_at = now();
  RAISE EXCEPTION 'expected a rewrite instead of an erasure to be refused';
EXCEPTION WHEN check_violation THEN NULL;
END
$$;
DO $$
BEGIN
  UPDATE gov.quorum_check SET required = 0;
  RAISE EXCEPTION 'expected an update of an append-only table to be refused';
EXCEPTION WHEN check_violation THEN NULL;
END
$$;
DO $$
BEGIN
  INSERT INTO gov.agenda_snapshot (customer_id, body_id, meeting_id, version, content_hash,
                                   erased_at, created_by_kind)
  SELECT customer_id, body_id, meeting_id, 2, sha256('y'::bytea), now(), 'system' FROM gov.meeting;
  RAISE EXCEPTION 'expected an insert of an already erased row to be refused';
EXCEPTION WHEN check_violation THEN NULL;
END
$$;
SELECT set_config('gremion.redaction_id', '01999999-0000-7000-8000-0000000e0001', true) AS redaction;
UPDATE gov.notice_override SET reason = NULL, erased_at = now();
SELECT count(*) AS erased_overrides FROM gov.notice_override WHERE reason IS NULL AND erased_at IS NOT NULL;
ROLLBACK;
