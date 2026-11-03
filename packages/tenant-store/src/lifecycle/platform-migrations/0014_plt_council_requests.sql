-- gremion:phase expand
-- gremion_platform, 0014 (module self-service, phase 1): a council's own admin
-- switches feature modules ON from gremion-ui without an operator in the loop.
-- The request still goes through the 0009 queue and the host executor (lock, one
-- request per customer slug, events); what changes is WHO may queue it.
--
--  * A third request origin, `council`. Like `panel` it carries signed loa2
--    evidence (the admin's ID + access token pair, re-verified by the executor
--    against the council's own realm), but the actor is a PERSON: the new column
--    actor_kind records it ('operator' for every older row, 'person' for a
--    council row), and operator_id then holds the person's Keycloak user id.
--  * Only the two module kinds may carry origin council. The kind check is in the
--    database so that a later phase can lift the library's refusal of a council
--    disable_module without replacing a function again; phase 1 refuses it in
--    @gremion/provisioning (COUNCIL_DISABLE_ALLOWED), in request-verify and in
--    gremion-ui, never here.
--  * The council writes through ONE SECURITY DEFINER function, as the login role
--    gremion_ui_modules (a direct member of the marker role plt_council_requester;
--    created and granted by `gremion-tenant init`, ensureCouncilRequester). It
--    holds no table privilege. It reads its own rows through plt.council_module_requests
--    (never the evidence token) and the catalogue-wide state through
--    plt.council_module_state.
--  * One request per customer slug in flight (queued or running), serialised by
--    an advisory lock on the slug: the second admin, or a double click with a new
--    idempotency key, gets SQLSTATE 55006 (object_in_use), which gremion-ui shows
--    as HTTP 409 (the same key replays the first request id). The rule binds
--    COUNCIL submits: they see requests of every origin in flight, but
--    plt.submit_provisioning_request takes no such lock, and the executor's
--    per-slug lock serialises execution. The lock is the one-bigint form, a
--    keyspace apart from the two-int4 keys of advisory-locks.ts, and is keyed by
--    the slug so it needs no registry row.
--
-- SQLSTATEs the callers map: 42501 wrong role, 22023 bad input, 28000 sign-in not
-- loa2 or outside the last hour, 55006 another request of the slug is in flight,
-- 23505 idempotency key reused for a different request.
--
-- Every new CHECK is added NOT VALID and validated in the same file (the old ones
-- are replaced the same way). The functions run with search_path = pg_catalog,
-- pg_temp, name every object schema-qualified and are revoked from PUBLIC; the
-- EXECUTE grants are init's (ensureCouncilRequester).

SET LOCAL lock_timeout = '5s';

ALTER TABLE plt.provisioning_request ADD COLUMN actor_kind text NOT NULL DEFAULT 'operator';
ALTER TABLE plt.provisioning_request ADD CONSTRAINT provisioning_request_actor_kind_check
  CHECK (actor_kind IN ('operator', 'person')) NOT VALID;
ALTER TABLE plt.provisioning_request VALIDATE CONSTRAINT provisioning_request_actor_kind_check;
COMMENT ON COLUMN plt.provisioning_request.actor_kind IS 'who operator_id names: operator (ops realm user, panel and host requests) or person (a council admin, origin council)';

ALTER TABLE plt.provisioning_request DROP CONSTRAINT provisioning_request_origin_check;
ALTER TABLE plt.provisioning_request ADD CONSTRAINT provisioning_request_origin_check
  CHECK (origin IN ('panel', 'host', 'council')) NOT VALID;
ALTER TABLE plt.provisioning_request VALIDATE CONSTRAINT provisioning_request_origin_check;

ALTER TABLE plt.provisioning_request DROP CONSTRAINT provisioning_request_evidence_check;
ALTER TABLE plt.provisioning_request ADD CONSTRAINT provisioning_request_evidence_check CHECK (
    (origin = 'panel' AND evidence_acr = 'loa2' AND evidence_auth_time IS NOT NULL AND evidence_session_at IS NOT NULL
      AND reason IS NULL AND host_actor IS NULL)
    OR (origin = 'host' AND evidence_acr IS NULL AND evidence_auth_time IS NULL AND evidence_session_at IS NULL
      AND evidence_token IS NULL AND reason IS NOT NULL AND length(reason) BETWEEN 10 AND 500
      AND host_actor ~ '^[a-z_][a-z0-9_-]{0,31}$')
    OR (origin = 'council' AND actor_kind = 'person' AND evidence_acr = 'loa2' AND evidence_auth_time IS NOT NULL
      AND evidence_session_at IS NOT NULL AND reason IS NULL AND host_actor IS NULL)) NOT VALID;
ALTER TABLE plt.provisioning_request VALIDATE CONSTRAINT provisioning_request_evidence_check;

ALTER TABLE plt.provisioning_request ADD CONSTRAINT provisioning_request_council_kind_check
  CHECK (origin <> 'council' OR kind IN ('enable_module', 'disable_module')) NOT VALID;
ALTER TABLE plt.provisioning_request VALIDATE CONSTRAINT provisioning_request_council_kind_check;
ALTER TABLE plt.provisioning_request ADD CONSTRAINT provisioning_request_actor_origin_check
  CHECK ((origin = 'council') = (actor_kind = 'person')) NOT VALID;
ALTER TABLE plt.provisioning_request VALIDATE CONSTRAINT provisioning_request_actor_origin_check;

-- The 0010 guard, plus: the actor kind belongs to the immutable envelope.
CREATE OR REPLACE FUNCTION plt.provisioning_request_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  IF NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.customer_slug IS DISTINCT FROM OLD.customer_slug
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.operator_id IS DISTINCT FROM OLD.operator_id OR NEW.actor_kind IS DISTINCT FROM OLD.actor_kind
     OR NEW.evidence_acr IS DISTINCT FROM OLD.evidence_acr
     OR NEW.evidence_auth_time IS DISTINCT FROM OLD.evidence_auth_time
     OR NEW.evidence_session_at IS DISTINCT FROM OLD.evidence_session_at
     OR NEW.host_actor IS DISTINCT FROM OLD.host_actor OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'plt.provisioning_request: the request envelope is immutable' USING ERRCODE = 'check_violation';
  END IF;
  -- TASK-031: the request's args never change, except to the canonical purge of a
  -- payload-carrying kind on the transition to a final state (data minimisation).
  IF NEW.args IS DISTINCT FROM OLD.args AND NOT (
       NEW.state IN ('succeeded', 'failed', 'refused', 'expired', 'dead')
       AND NEW.args = plt.provisioning_purged_args(OLD.kind, OLD.args)) THEN
    RAISE EXCEPTION 'plt.provisioning_request: the request args are immutable (only the payload purge of a final request is allowed)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.evidence_token IS NOT NULL AND NEW.evidence_token IS DISTINCT FROM OLD.evidence_token THEN
    RAISE EXCEPTION 'plt.provisioning_request: evidence_token may only be cleared' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.evidence_verified_at IS NOT NULL AND NEW.evidence_verified_at IS DISTINCT FROM OLD.evidence_verified_at THEN
    RAISE EXCEPTION 'plt.provisioning_request: evidence_verified_at is written once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('succeeded', 'failed', 'refused', 'expired', 'dead') THEN
    RAISE EXCEPTION 'plt.provisioning_request: a % request is final', OLD.state USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'queued' AND NEW.state IN ('running', 'expired'))
    OR (OLD.state = 'running' AND NEW.state IN ('queued', 'dead', 'succeeded', 'failed', 'refused'))) THEN
    RAISE EXCEPTION 'plt.provisioning_request: % -> % is not a legal transition', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempt < OLD.attempt THEN
    RAISE EXCEPTION 'plt.provisioning_request: attempt never decreases' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$body$;

-- The council's ONE write. The origin is a fact of the calling LOGIN role (a
-- direct member of plt_council_requester and of no other marker), never an
-- argument.
CREATE FUNCTION plt.submit_council_module_request(
  p_kind text, p_slug text, p_args jsonb, p_idempotency_key uuid, p_person_id uuid,
  p_acr text, p_auth_time timestamptz, p_token text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  v_id uuid;
  v_old plt.provisioning_request%ROWTYPE;
BEGIN
  IF NOT plt.provisioning_member_of('plt_council_requester')
     OR plt.provisioning_member_of('plt_panel_requester') OR plt.provisioning_member_of('plt_executor') THEN
    RAISE EXCEPTION 'submit_council_module_request: role % is not the council requester', session_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('enable_module', 'disable_module') THEN
    RAISE EXCEPTION 'submit_council_module_request: a council request is enable_module or disable_module, not %', coalesce(p_kind, '<null>')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_slug IS NULL OR p_slug !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' OR length(p_slug) NOT BETWEEN 3 AND 30 OR p_slug = 'platform' THEN
    RAISE EXCEPTION 'submit_council_module_request: invalid customer slug' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'submit_council_module_request: args must be a JSON object' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF octet_length(p_args::text) > 16384 THEN
    RAISE EXCEPTION 'submit_council_module_request: args exceed 16 KiB' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_person_id IS NULL THEN
    RAISE EXCEPTION 'submit_council_module_request: the person id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'submit_council_module_request: the idempotency key is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_acr IS DISTINCT FROM 'loa2' THEN
    RAISE EXCEPTION 'submit_council_module_request: the sign-in is %, loa2 is required', coalesce(p_acr, 'without acr')
      USING ERRCODE = 'invalid_authorization_specification';
  END IF;
  IF p_auth_time IS NULL OR p_auth_time < now() - interval '3600 seconds' OR p_auth_time > now() + interval '60 seconds' THEN
    RAISE EXCEPTION 'submit_council_module_request: the sign-in time is outside the last hour' USING ERRCODE = 'invalid_authorization_specification';
  END IF;
  IF p_token IS NULL OR length(p_token) NOT BETWEEN 100 AND 8192 THEN
    RAISE EXCEPTION 'submit_council_module_request: the signed evidence token is missing' USING ERRCODE = 'invalid_authorization_specification';
  END IF;
  -- One writer per slug at a time: the replay lookup and the in-flight check below
  -- see every earlier council submit of this slug.
  PERFORM pg_advisory_xact_lock(hashtext(p_slug));
  -- The same key and the same request is a replay (the double click returns the
  -- first request id); the key with other content is refused.
  SELECT * INTO v_old FROM plt.provisioning_request r WHERE r.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_old.kind = p_kind AND v_old.customer_slug = p_slug AND v_old.args = p_args
       AND v_old.operator_id = p_person_id AND v_old.origin = 'council' THEN
      RETURN v_old.request_id;
    END IF;
    RAISE EXCEPTION 'submit_council_module_request: the idempotency key was already used for a different request'
      USING ERRCODE = 'unique_violation';
  END IF;
  -- In flight = running, or queued and still claimable (an unclaimed first attempt
  -- expires 30 minutes after its submission, plt.claim_provisioning_request).
  IF EXISTS (SELECT 1 FROM plt.provisioning_request r
              WHERE r.customer_slug = p_slug
                AND (r.state = 'running'
                     OR (r.state = 'queued' AND (r.attempt > 0 OR r.created_at >= now() - interval '30 minutes')))) THEN
    RAISE EXCEPTION 'submit_council_module_request: another request for this customer is queued or running'
      USING ERRCODE = 'object_in_use';
  END IF;
  INSERT INTO plt.provisioning_request (kind, customer_slug, args, idempotency_key, origin, operator_id, actor_kind,
                                        evidence_acr, evidence_auth_time, evidence_session_at, evidence_token)
  VALUES (p_kind, p_slug, p_args, p_idempotency_key, 'council', p_person_id, 'person',
          p_acr, p_auth_time, now(), p_token)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING request_id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;
  -- Lost a race on the key against a submit for ANOTHER slug (the slug lock does not
  -- cover it): same replay rule.
  SELECT * INTO v_old FROM plt.provisioning_request r WHERE r.idempotency_key = p_idempotency_key;
  IF v_old.kind = p_kind AND v_old.customer_slug = p_slug AND v_old.args = p_args
     AND v_old.operator_id = p_person_id AND v_old.origin = 'council' THEN
    RETURN v_old.request_id;
  END IF;
  RAISE EXCEPTION 'submit_council_module_request: the idempotency key was already used for a different request'
    USING ERRCODE = 'unique_violation';
END
$body$;

-- A council's own request history for its settings page: origin council rows of ONE
-- slug, newest first. Never the evidence token, never another origin's rows.
CREATE FUNCTION plt.council_module_requests(p_slug text, p_limit integer)
  RETURNS TABLE (request_id uuid, kind text, module text, state text, outcome text, actor uuid,
                 created_at timestamptz, finished_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
#variable_conflict use_column
BEGIN
  IF NOT plt.provisioning_member_of('plt_council_requester') THEN
    RAISE EXCEPTION 'council_module_requests: role % is not the council requester', session_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_slug IS NULL OR p_slug !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' OR length(p_slug) NOT BETWEEN 3 AND 30 OR p_slug = 'platform' THEN
    RAISE EXCEPTION 'council_module_requests: invalid customer slug' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'council_module_requests: limit of 1 to 100' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    SELECT r.request_id, r.kind, r.args ->> 'module', r.state, r.outcome, r.operator_id, r.created_at, r.finished_at
      FROM plt.provisioning_request r
     WHERE r.origin = 'council' AND r.customer_slug = p_slug
     ORDER BY r.created_at DESC, r.request_id DESC
     LIMIT p_limit;
END
$body$;

-- The catalogue-wide switch state of one customer: every toggleable catalogue row
-- (all of them are, plt.module is filled by init), its enablement state ('disabled'
-- when the customer has no enablement row), whether a row exists at all (never
-- enabled is not the same as disabled) and whether the latest DPIA decision for the
-- pair carries a document reference. The caller narrows this to the modules a
-- council may switch.
CREATE FUNCTION plt.council_module_state(p_customer_id uuid)
  RETURNS TABLE (module_key text, name text, state text, has_row boolean, dpia_recorded boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
#variable_conflict use_column
BEGIN
  IF NOT plt.provisioning_member_of('plt_council_requester') THEN
    RAISE EXCEPTION 'council_module_state: role % is not the council requester', session_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'council_module_state: the customer id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    SELECT m.module_key, m.name, coalesce(e.state, 'disabled'), e.module_enablement_id IS NOT NULL,
           coalesce((SELECT d.document_ref IS NOT NULL
                       FROM ops.dpia_decision d
                      WHERE d.customer_id = p_customer_id AND d.module_id = m.module_id
                      ORDER BY d.decided_at DESC, d.dpia_decision_id DESC LIMIT 1), false)
      FROM plt.module m
      LEFT JOIN plt.module_enablement e ON e.module_id = m.module_id AND e.customer_id = p_customer_id
     WHERE m.toggleable
     ORDER BY m.module_key;
END
$body$;

REVOKE ALL ON FUNCTION plt.submit_council_module_request(text, text, jsonb, uuid, uuid, text, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION plt.council_module_requests(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION plt.council_module_state(uuid) FROM PUBLIC;
