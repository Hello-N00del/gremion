-- gremion:phase expand
-- gremion_platform, 0010 (TASK-031, operator decision 2026-10-22): the
-- `import_members` request carries the member list IN its args (a CSV text),
-- so (1) its args may be larger than the 16 KiB of the other kinds (1.5 MiB:
-- the library's 1 MiB list cap plus the JSON envelope), and (2) the list is
-- PURGED on every terminal state (succeeded, failed, refused, expired, dead):
-- only the slug, the phase, the vertical id and the validated sha256 remain
-- (GDPR Art. 5(1)(c), Art. 5(1)(e); NIST SP 800-53 SI-12). The purge is the one
-- canonical rewrite plt.provisioning_purged_args() computes; the immutability
-- guard allows no other change of args, and only on the way to a final state.
-- Every function keeps its signature (privileges and the executor's grants are
-- unchanged); the bodies are 0009's with the purge/cap lines added.

CREATE FUNCTION plt.provisioning_purged_args(p_kind text, p_args jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $body$
  SELECT CASE WHEN p_kind = 'import_members'
              THEN jsonb_strip_nulls(jsonb_build_object('purged', true, 'slug', p_args -> 'slug', 'phase', p_args -> 'phase',
                                                        'vertical', p_args -> 'vertical', 'expectSha256', p_args -> 'expectSha256'))
              ELSE p_args END
$body$;
REVOKE ALL ON FUNCTION plt.provisioning_purged_args(text, jsonb) FROM PUBLIC;

ALTER TABLE plt.provisioning_request DROP CONSTRAINT provisioning_request_args_check;
ALTER TABLE plt.provisioning_request ADD CONSTRAINT provisioning_request_args_check
  CHECK (jsonb_typeof(args) = 'object' AND octet_length(args::text) <= CASE WHEN kind = 'import_members' THEN 1572864 ELSE 16384 END);
COMMENT ON COLUMN plt.provisioning_request.args IS 'the request payload; an import_members list is purged to {purged, slug, phase, vertical, expectSha256} on any final state (TASK-031)';

CREATE OR REPLACE FUNCTION plt.provisioning_request_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  IF NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.customer_slug IS DISTINCT FROM OLD.customer_slug
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.operator_id IS DISTINCT FROM OLD.operator_id OR NEW.evidence_acr IS DISTINCT FROM OLD.evidence_acr
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

CREATE OR REPLACE FUNCTION plt.submit_provisioning_request(
  p_kind text, p_slug text, p_args jsonb, p_idempotency_key uuid, p_operator_id uuid,
  p_acr text, p_auth_time timestamptz, p_session_at timestamptz, p_token text,
  p_reason text, p_host_actor text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  v_panel boolean := plt.provisioning_member_of('plt_panel_requester');
  v_host boolean := plt.provisioning_member_of('plt_executor');
  v_origin text;
  v_id uuid;
  v_old plt.provisioning_request%ROWTYPE;
  v_cap integer;
BEGIN
  IF v_panel = v_host THEN
    RAISE EXCEPTION 'submit_provisioning_request: role % is neither the panel requester nor the executor', session_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_origin := CASE WHEN v_panel THEN 'panel' ELSE 'host' END;
  IF p_kind IS NULL OR p_kind NOT IN ('create', 'suspend', 'resume', 'reconcile', 'enable_module', 'disable_module',
                                      'import_members', 'seed_vertical', 'record_dpia', 'import_isolation') THEN
    RAISE EXCEPTION 'submit_provisioning_request: unknown request kind %', coalesce(p_kind, '<null>')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_slug IS NULL OR p_slug !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' OR length(p_slug) NOT BETWEEN 3 AND 30 OR p_slug = 'platform' THEN
    RAISE EXCEPTION 'submit_provisioning_request: invalid customer slug' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'submit_provisioning_request: args must be a JSON object' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_cap := CASE WHEN p_kind = 'import_members' THEN 1572864 ELSE 16384 END;
  IF octet_length(p_args::text) > v_cap THEN
    RAISE EXCEPTION 'submit_provisioning_request: args exceed % bytes', v_cap USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_operator_id IS NULL THEN
    RAISE EXCEPTION 'submit_provisioning_request: the operator id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'submit_provisioning_request: the idempotency key is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_origin = 'panel' THEN
    IF p_reason IS NOT NULL OR p_host_actor IS NOT NULL THEN
      RAISE EXCEPTION 'submit_provisioning_request: a panel request carries no break-glass reason' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_acr IS DISTINCT FROM 'loa2' THEN
      RAISE EXCEPTION 'submit_provisioning_request: the sign-in is %, loa2 is required', coalesce(p_acr, 'without acr')
        USING ERRCODE = 'invalid_authorization_specification';
    END IF;
    IF p_auth_time IS NULL OR p_auth_time < now() - interval '3600 seconds' OR p_auth_time > now() + interval '60 seconds' THEN
      RAISE EXCEPTION 'submit_provisioning_request: the sign-in time is outside the last hour' USING ERRCODE = 'invalid_authorization_specification';
    END IF;
    IF p_session_at IS NULL OR p_session_at < now() - interval '3600 seconds' OR p_session_at > now() + interval '60 seconds' THEN
      RAISE EXCEPTION 'submit_provisioning_request: the panel session time is outside the last hour' USING ERRCODE = 'invalid_authorization_specification';
    END IF;
    IF p_token IS NULL OR length(p_token) NOT BETWEEN 100 AND 8192 THEN
      RAISE EXCEPTION 'submit_provisioning_request: the signed evidence token is missing' USING ERRCODE = 'invalid_authorization_specification';
    END IF;
  ELSE
    IF p_token IS NOT NULL OR p_acr IS NOT NULL OR p_auth_time IS NOT NULL OR p_session_at IS NOT NULL THEN
      RAISE EXCEPTION 'submit_provisioning_request: a break-glass request carries no panel evidence' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 10 AND 500 THEN
      RAISE EXCEPTION 'submit_provisioning_request: a break-glass request needs a reason of 10 to 500 characters' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_host_actor IS NULL OR p_host_actor !~ '^[a-z_][a-z0-9_-]{0,31}$' THEN
      RAISE EXCEPTION 'submit_provisioning_request: a break-glass request names its host login user' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;
  INSERT INTO plt.provisioning_request (kind, customer_slug, args, idempotency_key, origin, operator_id, evidence_acr,
                                        evidence_auth_time, evidence_session_at, evidence_token, host_actor, reason)
  VALUES (p_kind, p_slug, p_args, p_idempotency_key, v_origin, p_operator_id, p_acr,
          p_auth_time, p_session_at, p_token, p_host_actor, p_reason)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING request_id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;
  SELECT * INTO v_old FROM plt.provisioning_request r WHERE r.idempotency_key = p_idempotency_key;
  IF v_old.kind = p_kind AND v_old.customer_slug = p_slug AND v_old.args = p_args
     AND v_old.operator_id = p_operator_id AND v_old.origin = v_origin THEN
    RETURN v_old.request_id;
  END IF;
  RAISE EXCEPTION 'submit_provisioning_request: the idempotency key was already used for a different request'
    USING ERRCODE = 'unique_violation';
END
$body$;

CREATE OR REPLACE FUNCTION plt.provisioning_requeue(p_ids uuid[], p_why text) RETURNS integer
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  v_n integer;
BEGIN
  UPDATE plt.provisioning_request r
     SET state = CASE WHEN r.attempt + 1 >= 3 THEN 'dead' ELSE 'queued' END,
         attempt = r.attempt + 1,
         claimed_by = CASE WHEN r.attempt + 1 >= 3 THEN r.claimed_by END,
         lease_until = NULL,
         args = CASE WHEN r.attempt + 1 >= 3 THEN plt.provisioning_purged_args(r.kind, r.args) ELSE r.args END,
         finished_at = CASE WHEN r.attempt + 1 >= 3 THEN now() END,
         evidence_token = CASE WHEN r.attempt + 1 >= 3 THEN NULL ELSE r.evidence_token END,
         outcome = CASE WHEN r.attempt + 1 >= 3
                        THEN left(format('dead: %s on attempt %s (last claimed by %s)', p_why, r.attempt + 1, r.claimed_by), 2000)
                        ELSE r.outcome END
   WHERE r.request_id = ANY (p_ids) AND r.state = 'running';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$body$;

CREATE OR REPLACE FUNCTION plt.claim_provisioning_request(p_host text, p_lease_seconds integer)
  RETURNS TABLE (request_id uuid, kind text, customer_slug text, origin text, operator_id uuid, attempt smallint)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
#variable_conflict use_column
DECLARE
  v_id uuid;
BEGIN
  PERFORM plt.provisioning_assert_executor(p_host);
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 3600 THEN
    RAISE EXCEPTION 'claim_provisioning_request: lease of 30 to 3600 seconds' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Never run days later: a request nobody claimed within 30 minutes expires
  -- (its evidence window is the hour).
  UPDATE plt.provisioning_request r
     SET state = 'expired', finished_at = now(), evidence_token = NULL,
         args = plt.provisioning_purged_args(r.kind, r.args),
         outcome = 'expired: not claimed within 30 minutes of its submission'
   WHERE r.request_id IN (SELECT q.request_id FROM plt.provisioning_request q
                           WHERE q.state = 'queued' AND q.attempt = 0 AND q.created_at < now() - interval '30 minutes'
                           ORDER BY q.request_id FOR UPDATE SKIP LOCKED);
  PERFORM plt.provisioning_requeue(ARRAY(SELECT q.request_id FROM plt.provisioning_request q
                                          WHERE q.state = 'running' AND q.lease_until < now()
                                          ORDER BY q.request_id FOR UPDATE SKIP LOCKED),
                                   'the lease expired');
  SELECT q.request_id INTO v_id FROM plt.provisioning_request q
   WHERE q.state = 'queued'
     AND NOT EXISTS (SELECT 1 FROM plt.provisioning_request o WHERE o.state = 'running' AND o.customer_slug = q.customer_slug)
   ORDER BY q.created_at, q.request_id
   FOR UPDATE SKIP LOCKED LIMIT 1;
  IF v_id IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    UPDATE plt.provisioning_request r
       SET state = 'running', claimed_by = p_host, lease_until = now() + make_interval(secs => p_lease_seconds)
     WHERE r.request_id = v_id;
  EXCEPTION WHEN unique_violation THEN
    -- the same customer started running elsewhere meanwhile: claim nothing
    RETURN;
  END;
  RETURN QUERY SELECT r.request_id, r.kind, r.customer_slug, r.origin, r.operator_id, r.attempt
                 FROM plt.provisioning_request r WHERE r.request_id = v_id;
END
$body$;

CREATE OR REPLACE FUNCTION plt.finish_provisioning_request(p_request_id uuid, p_host text, p_state text, p_outcome text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  PERFORM plt.provisioning_assert_executor(p_host);
  IF p_state IS NULL OR p_state NOT IN ('succeeded', 'failed', 'refused') THEN
    RAISE EXCEPTION 'finish_provisioning_request: state succeeded, failed or refused' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE plt.provisioning_request r
     SET state = p_state, finished_at = now(), evidence_token = NULL, args = plt.provisioning_purged_args(r.kind, r.args),
         outcome = left(p_outcome, 2000)
   WHERE r.request_id = p_request_id AND r.state = 'running' AND r.claimed_by = p_host;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request % is not running under %', p_request_id, p_host USING ERRCODE = 'no_data_found';
  END IF;
END
$body$;
