-- Beispiel: Laufzeitabfrage des Job-Sweepers (runtime query, not DDL; not executed by the schema check)
BEGIN;
SELECT set_config('gremion.customer_id', '01999999-0000-7000-8000-00000000c001', true) AS tenant;
CREATE TABLE IF NOT EXISTS gov.poll (test_run_id uuid);
CREATE FUNCTION pg_temp.part2_rows() RETURNS bigint LANGUAGE sql AS $$
  SELECT (SELECT count(*) FROM gov.meeting) + (SELECT count(*) FROM gov.agenda_section)
       + (SELECT count(*) FROM gov.agenda_item) + (SELECT count(*) FROM gov.agenda_snapshot)
       + (SELECT count(*) FROM gov.invitation) + (SELECT count(*) FROM gov.notice_override)
       + (SELECT count(*) FROM gov.invitation_recipient) + (SELECT count(*) FROM gov.motion)
       + (SELECT count(*) FROM gov.motion_admission) + (SELECT count(*) FROM gov.attachment_link)
       + (SELECT count(*) FROM gov.external_ref) + (SELECT count(*) FROM gov.attendance)
       + (SELECT count(*) FROM gov.attendance_forecast) + (SELECT count(*) FROM gov.quorum_check)
       + (SELECT count(*) FROM gov.job) + (SELECT count(*) FROM gov.outbox) + (SELECT count(*) FROM gov.inbox)
$$;
CREATE FUNCTION pg_temp.seed_test_run(p_run uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  c uuid := gov.current_customer_id();  b uuid := uuidv7();  chair uuid := uuidv7();
  mt uuid;  sec bigint;  it uuid;  snap bigint;  inv uuid;  mo uuid;
BEGIN
  INSERT INTO gov.meeting (customer_id, body_id, title, scheduled_start, notice_period_days_snapshot,
    notice_due_at, motion_deadline_at, test_run_id, created_by_kind, updated_by_kind)
  VALUES (c, b, 'Testsitzung', now() + interval '1 day', 7, now() - interval '6 days',
    now() - interval '8 days', p_run, 'system', 'system') RETURNING meeting_id INTO mt;
  INSERT INTO gov.agenda_section (customer_id, body_id, meeting_id, position, title, created_by_kind,
    updated_by_kind) VALUES (c, b, mt, 1, 'Oeffentlicher Teil', 'system', 'system')
  RETURNING agenda_section_id INTO sec;
  INSERT INTO gov.agenda_item (customer_id, body_id, meeting_id, agenda_section_id, position, title, kind,
    state, created_by_kind, updated_by_kind)
  VALUES (c, b, mt, sec, 1, 'Antrag', 'motion', 'placed', 'system', 'system') RETURNING agenda_item_id INTO it;
  INSERT INTO gov.agenda_item (customer_id, body_id, meeting_id, title, created_by_kind, updated_by_kind)
  VALUES (c, b, mt, 'Vorschlag', 'system', 'system');
  INSERT INTO gov.agenda_snapshot (customer_id, body_id, meeting_id, version, content_hash, rendered_content,
    created_by_kind) VALUES (c, b, mt, 1, sha256('x'::bytea), 'TOP 1', 'system')
  RETURNING agenda_snapshot_id INTO snap;
  INSERT INTO gov.invitation (customer_id, body_id, meeting_id, version, agenda_snapshot_id, state, notice_met,
    created_by_kind, updated_by_kind) VALUES (c, b, mt, 1, snap, 'blocked', false, 'system', 'system')
  RETURNING invitation_id INTO inv;
  INSERT INTO gov.notice_override (customer_id, body_id, invitation_id, meeting_id, days_short, reason,
    curing_basis_snapshot, created_by_kind, created_by)
  VALUES (c, b, inv, mt, 6, 'Grund', 'keine Grundlage', 'person', chair);
  INSERT INTO gov.invitation_recipient (customer_id, body_id, invitation_id, person_id, created_by_kind,
    updated_by_kind) VALUES (c, b, inv, chair, 'system', 'system');
  INSERT INTO gov.attendance (customer_id, body_id, meeting_id, person_id, capacity, voting_right_snapshot,
    created_by_kind, updated_by_kind) VALUES (c, b, mt, chair, 'voting_member', true, 'system', 'system');
  INSERT INTO gov.attendance_forecast (customer_id, body_id, meeting_id, person_id, expectation,
    created_by_kind, updated_by_kind) VALUES (c, b, mt, chair, 'yes', 'system', 'system');
  INSERT INTO gov.quorum_check (customer_id, body_id, meeting_id, present_voting, statutory_members,
    required, result, created_by_kind) VALUES (c, b, mt, 1, 1, 1, 'quorate', 'system');
  INSERT INTO gov.attachment_link (customer_id, body_id, agenda_item_id, file_ref, link, display_name,
    released_copy_key, released_copy_hash, created_by_kind, updated_by_kind)
  VALUES (c, b, it, 'f1', 'https://files.invalid/f1', 'Anlage', 'k1', sha256('y'::bytea), 'system', 'system');
  INSERT INTO gov.external_ref (customer_id, body_id, agenda_item_id, system_name, external_identifier,
    created_by_kind, updated_by_kind) VALUES (c, b, it, 'StuFis', 'A-1', 'system', 'system');
  INSERT INTO gov.motion (customer_id, body_id, target_meeting_id, agenda_item_id, title, motion_text,
    submitter_kind, submitter_person_id, submitted_at, deadline_snapshot, state, test_run_id,
    created_by_kind, created_by, updated_by_kind, updated_by)
  VALUES (c, b, mt, it, 'Antrag', 'Text', 'member', chair, now() - interval '9 days',
    now() - interval '8 days', 'on_agenda', p_run, 'person', chair, 'person', chair)
  RETURNING motion_id INTO mo;
  INSERT INTO gov.motion_admission (customer_id, body_id, motion_id, outcome, deferred_to_meeting_id,
    created_by_kind, created_by) VALUES (c, b, mo, 'defer', mt, 'person', chair);
  INSERT INTO gov.attachment_link (customer_id, body_id, motion_id, file_ref, link, display_name,
    created_by_kind, updated_by_kind)
  VALUES (c, b, mo, 'f2', 'https://files.invalid/f2', 'Begruendung', 'system', 'system');
  INSERT INTO gov.job (customer_id, body_id, kind, idempotency_key, due_at, test_run_id)
  VALUES (c, b, 'notice_due', 'meeting:' || mt || ':notice_due:' || extract(epoch FROM now())::bigint,
    now(), p_run);
  INSERT INTO gov.outbox (customer_id, event_type, source, subject, tenantid, data, aggregate_type,
    aggregate_id, aggregate_version, test_run_id, relay_state, published_at)
  VALUES (c, 'de.gremion.gov.meeting.scheduled.v1', '/gremion/gov', mt::text, c::text,
    jsonb_build_object('meeting_id', mt, 'aggregate_version', 1), 'meeting', mt, 1, p_run, 'published', now());
  INSERT INTO gov.inbox (source, event_id, customer_id, event_type, tenantid, test_run_id, processing_state,
    processed_at) VALUES ('/gremion/ops', uuidv7()::text, c, 'de.gremion.ops.testrun.started.v1', c::text,
    p_run, 'skipped_test', now());
END
$$;
CREATE TEMP TABLE regression_baseline AS SELECT pg_temp.part2_rows() AS n;

-- Run A, constraints in creation order: a meeting is refused while its test motion still refers to it,
-- and a released attachment is refused a direct delete.
SELECT pg_temp.seed_test_run('01999999-0000-7000-8000-00000000a001');
DO $$
BEGIN
  DELETE FROM gov.meeting WHERE test_run_id = '01999999-0000-7000-8000-00000000a001';
  RAISE EXCEPTION 'expected motion_target_meeting_id_body_id_fkey to refuse';
EXCEPTION WHEN restrict_violation THEN NULL;
END
$$;
DO $$
BEGIN
  DELETE FROM gov.attachment_link WHERE released_copy_key IS NOT NULL;
  RAISE EXCEPTION 'expected attachment_link_released_copy_trg to refuse';
EXCEPTION WHEN check_violation THEN NULL;
END
$$;
SELECT * FROM gov.remove_test_run('01999999-0000-7000-8000-00000000a001');
SET CONSTRAINTS ALL IMMEDIATE;

-- Run B: every foreign key of the schema recreated in reverse creation order.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conrelid::regclass AS tbl, conname, pg_get_constraintdef(oid) AS def
             FROM pg_catalog.pg_constraint
            WHERE connamespace = 'gov'::regnamespace AND contype = 'f'
            ORDER BY oid DESC LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I, ADD CONSTRAINT %I %s',
                   r.tbl, r.conname, r.conname, r.def);
  END LOOP;
END
$$;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.seed_test_run('01999999-0000-7000-8000-00000000b001');
SELECT * FROM gov.remove_test_run('01999999-0000-7000-8000-00000000b001');
SET CONSTRAINTS ALL IMMEDIATE;
DO $$
BEGIN
  IF pg_temp.part2_rows() <> (SELECT n FROM regression_baseline) THEN
    RAISE EXCEPTION 'test-run removal left % rows behind',
      pg_temp.part2_rows() - (SELECT n FROM regression_baseline);
  END IF;
END
$$;
ROLLBACK;
