-- gremion:phase expand
-- gremion_platform, 0009 (TASK-043d-1, D R31-I4): the operator control
-- panel's request queue and the host-side executor's side of it.
--
-- The panel holds no docker, no host tool and no table write: its ONE write is
-- plt.submit_provisioning_request (SECURITY DEFINER, below), which derives the
-- request's origin from the calling LOGIN role's membership in one of two
-- NOLOGIN marker roles (plt_panel_requester, plt_executor; created and granted
-- by `gremion-tenant init`, ensurePanelRequester / ensureExecutorRole). The
-- executor (infra/host/bin/gremion-executor) PULLS: it claims a request, has
-- the container re-verify its evidence (request-verify), runs the kind's
-- handler and writes the state back, all through the executor functions here.
-- Every function runs with search_path = pg_catalog, pg_temp, names every
-- object schema-qualified and is revoked from PUBLIC (PostgreSQL docs,
-- "Writing SECURITY DEFINER Functions Safely"); the grants are init's.
--
-- Kinds: create (043d-1); suspend, resume, reconcile, enable_module,
-- disable_module (043d-2); import_members and seed_vertical (TASK-031),
-- record_dpia and import_isolation (TASK-044) are RESERVED: the executor
-- refuses them as "no handler" until their owner registers one.

CREATE TABLE plt.provisioning_request (
  request_id            uuid          NOT NULL DEFAULT uuidv7(),
  kind                  text          NOT NULL,
  customer_slug         text          NOT NULL,
  args                  jsonb         NOT NULL,
  idempotency_key       uuid          NOT NULL,
  origin                text          NOT NULL,
  operator_id           uuid          NOT NULL,
  evidence_acr          text,
  evidence_auth_time    timestamptz,
  evidence_session_at   timestamptz,
  evidence_token        text,
  evidence_verified_at  timestamptz,
  host_actor            text,
  reason                text,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  state                 text          NOT NULL DEFAULT 'queued',
  attempt               smallint      NOT NULL DEFAULT 0,
  claimed_by            text,
  lease_until           timestamptz,
  finished_at           timestamptz,
  outcome               text,
  CONSTRAINT provisioning_request_pkey PRIMARY KEY (request_id),
  CONSTRAINT provisioning_request_request_id_check CHECK (uuid_extract_version(request_id) = 7),
  CONSTRAINT provisioning_request_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT provisioning_request_kind_check CHECK (kind IN ('create', 'suspend', 'resume', 'reconcile',
    'enable_module', 'disable_module', 'import_members', 'seed_vertical', 'record_dpia', 'import_isolation')),
  CONSTRAINT provisioning_request_customer_slug_check CHECK (customer_slug ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
    AND length(customer_slug) BETWEEN 3 AND 30 AND customer_slug <> 'platform'),
  CONSTRAINT provisioning_request_args_check CHECK (jsonb_typeof(args) = 'object' AND octet_length(args::text) <= 16384),
  CONSTRAINT provisioning_request_origin_check CHECK (origin IN ('panel', 'host')),
  CONSTRAINT provisioning_request_evidence_check CHECK (
    (origin = 'panel' AND evidence_acr = 'loa2' AND evidence_auth_time IS NOT NULL AND evidence_session_at IS NOT NULL
      AND reason IS NULL AND host_actor IS NULL)
    OR (origin = 'host' AND evidence_acr IS NULL AND evidence_auth_time IS NULL AND evidence_session_at IS NULL
      AND evidence_token IS NULL AND reason IS NOT NULL AND length(reason) BETWEEN 10 AND 500
      AND host_actor ~ '^[a-z_][a-z0-9_-]{0,31}$')),
  CONSTRAINT provisioning_request_evidence_token_check CHECK (evidence_token IS NULL OR length(evidence_token) BETWEEN 100 AND 8192),
  CONSTRAINT provisioning_request_state_check CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'refused', 'expired', 'dead')),
  CONSTRAINT provisioning_request_attempt_check CHECK (attempt BETWEEN 0 AND 3),
  CONSTRAINT provisioning_request_claimed_by_check CHECK (claimed_by IS NULL OR claimed_by ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
  CONSTRAINT provisioning_request_running_check CHECK (state <> 'running' OR (claimed_by IS NOT NULL AND lease_until IS NOT NULL)),
  CONSTRAINT provisioning_request_finished_check CHECK ((state IN ('succeeded', 'failed', 'refused', 'expired', 'dead')) = (finished_at IS NOT NULL)),
  CONSTRAINT provisioning_request_outcome_check CHECK (outcome IS NULL OR length(outcome) <= 2000)
);
-- One request at a time per customer, enforced by the database itself.
CREATE UNIQUE INDEX provisioning_request_running_customer_slug_key ON plt.provisioning_request (customer_slug)
  WHERE state = 'running';
CREATE INDEX provisioning_request_state_created_at_idx ON plt.provisioning_request (state, created_at);
CREATE INDEX provisioning_request_customer_slug_created_at_idx ON plt.provisioning_request (customer_slug, created_at);

-- The envelope (what was asked, by whom, with which evidence) never changes;
-- the evidence token may only be cleared (data minimisation once verified or
-- final); only the state machine's transitions are legal; a final request is
-- immutable. DELETE and TRUNCATE are refused (plt.refuse_update, 0001).
CREATE FUNCTION plt.provisioning_request_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  IF NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.customer_slug IS DISTINCT FROM OLD.customer_slug OR NEW.args IS DISTINCT FROM OLD.args
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.operator_id IS DISTINCT FROM OLD.operator_id OR NEW.evidence_acr IS DISTINCT FROM OLD.evidence_acr
     OR NEW.evidence_auth_time IS DISTINCT FROM OLD.evidence_auth_time
     OR NEW.evidence_session_at IS DISTINCT FROM OLD.evidence_session_at
     OR NEW.host_actor IS DISTINCT FROM OLD.host_actor OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'plt.provisioning_request: the request envelope is immutable' USING ERRCODE = 'check_violation';
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
CREATE TRIGGER provisioning_request_guard_trg BEFORE UPDATE ON plt.provisioning_request
  FOR EACH ROW EXECUTE FUNCTION plt.provisioning_request_guard();
CREATE TRIGGER provisioning_request_no_delete_trg BEFORE DELETE ON plt.provisioning_request
  FOR EACH ROW EXECUTE FUNCTION plt.refuse_update();
CREATE TRIGGER provisioning_request_no_truncate_trg BEFORE TRUNCATE ON plt.provisioning_request
  FOR EACH STATEMENT EXECUTE FUNCTION plt.refuse_update();
COMMENT ON TABLE plt.provisioning_request IS 'TASK-043d operator request (panel or host break-glass) | K5 | rp-plt-provisioning-log | trigger: created_at + derived application-log window';
COMMENT ON COLUMN plt.provisioning_request.operator_id IS 'xref DB-OAC-OPERATOR (the ops realm user id; actor_operator_id of every step it runs)';
COMMENT ON COLUMN plt.provisioning_request.evidence_token IS 'the signed ID + access token pair of the operator sign-in; cleared once verified or final (GDPR Art. 5(1)(c))';

-- Append-only: what the executor saw, step by step (redacted, <= 1000 chars).
CREATE TABLE plt.provisioning_request_event (
  event_id    uuid          NOT NULL DEFAULT uuidv7(),
  request_id  uuid          NOT NULL,
  at          timestamptz   NOT NULL DEFAULT clock_timestamp(),
  level       text          NOT NULL,
  step        text          NOT NULL,
  message     text          NOT NULL,
  CONSTRAINT provisioning_request_event_pkey PRIMARY KEY (event_id),
  CONSTRAINT provisioning_request_event_event_id_check CHECK (uuid_extract_version(event_id) = 7),
  CONSTRAINT provisioning_request_event_request_id_fkey FOREIGN KEY (request_id) REFERENCES plt.provisioning_request (request_id),
  CONSTRAINT provisioning_request_event_level_check CHECK (level IN ('info', 'error')),
  CONSTRAINT provisioning_request_event_step_check CHECK (step ~ '^[a-z][a-z0-9_-]{0,39}$'),
  CONSTRAINT provisioning_request_event_message_check CHECK (length(message) <= 1000)
);
CREATE INDEX provisioning_request_event_request_id_at_idx ON plt.provisioning_request_event (request_id, at, event_id);
CREATE TRIGGER provisioning_request_event_append_only_trg BEFORE UPDATE OR DELETE ON plt.provisioning_request_event
  FOR EACH ROW EXECUTE FUNCTION plt.refuse_update();
CREATE TRIGGER provisioning_request_event_no_truncate_trg BEFORE TRUNCATE ON plt.provisioning_request_event
  FOR EACH STATEMENT EXECUTE FUNCTION plt.refuse_update();
COMMENT ON TABLE plt.provisioning_request_event IS 'TASK-043d executor event per request step | K5 | rp-plt-provisioning-log | trigger: at + derived application-log window';

-- The executor's liveness (one row): the panel disables "Neuer Mandant" when
-- it is older than 60 s (the long-lead rule: visibly disabled, never hidden).
CREATE TABLE plt.executor_heartbeat (
  singleton         boolean       NOT NULL DEFAULT true,
  executor_host     text          NOT NULL,
  executor_version  text          NOT NULL,
  seen_at           timestamptz   NOT NULL,
  CONSTRAINT executor_heartbeat_pkey PRIMARY KEY (singleton),
  CONSTRAINT executor_heartbeat_singleton_check CHECK (singleton),
  CONSTRAINT executor_heartbeat_executor_host_check CHECK (executor_host ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
  CONSTRAINT executor_heartbeat_executor_version_check CHECK (executor_version ~ '^[A-Za-z0-9._+-]{1,64}$')
);
COMMENT ON TABLE plt.executor_heartbeat IS 'TASK-043d executor liveness, one row | K5 | none (overwritten in place)';

-- What the panel reads: every request column but the evidence token.
CREATE VIEW plt.provisioning_request_status AS
  SELECT request_id, kind, customer_slug, args, idempotency_key, origin, operator_id, evidence_acr,
         evidence_auth_time, evidence_session_at, evidence_verified_at, host_actor, reason, created_at,
         state, attempt, claimed_by, lease_until, finished_at, outcome
    FROM plt.provisioning_request;

-- Direct membership of the SESSION user (never current_user, which a
-- SECURITY DEFINER function replaces) in a marker role.
CREATE FUNCTION plt.provisioning_member_of(p_marker text) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $body$
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
                   JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
                   JOIN pg_catalog.pg_roles u ON u.oid = m.member
                  WHERE r.rolname = p_marker AND u.rolname = session_user)
$body$;

-- The panel's ONE write, and the host break-glass (same function, same queue).
CREATE FUNCTION plt.submit_provisioning_request(
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
  IF octet_length(p_args::text) > 16384 THEN
    RAISE EXCEPTION 'submit_provisioning_request: args exceed 16 KiB' USING ERRCODE = 'invalid_parameter_value';
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

CREATE FUNCTION plt.provisioning_assert_executor(p_host text) RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  IF NOT plt.provisioning_member_of('plt_executor') THEN
    RAISE EXCEPTION 'role % is not the executor', session_user USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_host IS NULL OR p_host !~ '^[a-z0-9][a-z0-9._-]{0,62}$' THEN
    RAISE EXCEPTION 'invalid executor host id' USING ERRCODE = 'invalid_parameter_value';
  END IF;
END
$body$;

-- A running request whose lease passed (or, from requeue_own, that this host
-- held when it crashed) goes back to the queue with attempt + 1; the third
-- time it is dead, with the reason. SKIP LOCKED: concurrent callers never
-- wait on, or deadlock over, each other's rows.
CREATE FUNCTION plt.provisioning_requeue(p_ids uuid[], p_why text) RETURNS integer
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  v_n integer;
BEGIN
  UPDATE plt.provisioning_request r
     SET state = CASE WHEN r.attempt + 1 >= 3 THEN 'dead' ELSE 'queued' END,
         attempt = r.attempt + 1,
         claimed_by = CASE WHEN r.attempt + 1 >= 3 THEN r.claimed_by END,
         lease_until = NULL,
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

CREATE FUNCTION plt.claim_provisioning_request(p_host text, p_lease_seconds integer)
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

CREATE FUNCTION plt.requeue_own_requests(p_host text) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  PERFORM plt.provisioning_assert_executor(p_host);
  RETURN plt.provisioning_requeue(ARRAY(SELECT q.request_id FROM plt.provisioning_request q
                                         WHERE q.state = 'running' AND q.claimed_by = p_host
                                         ORDER BY q.request_id FOR UPDATE SKIP LOCKED),
                                  'the executor restarted');
END
$body$;

CREATE FUNCTION plt.renew_provisioning_lease(p_request_id uuid, p_host text, p_lease_seconds integer) RETURNS timestamptz
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  v_until timestamptz;
BEGIN
  PERFORM plt.provisioning_assert_executor(p_host);
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 3600 THEN
    RAISE EXCEPTION 'renew_provisioning_lease: lease of 30 to 3600 seconds' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE plt.provisioning_request r SET lease_until = now() + make_interval(secs => p_lease_seconds)
   WHERE r.request_id = p_request_id AND r.state = 'running' AND r.claimed_by = p_host
  RETURNING r.lease_until INTO v_until;
  IF v_until IS NULL THEN
    RAISE EXCEPTION 'request % is not running under %', p_request_id, p_host USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v_until;
END
$body$;

CREATE FUNCTION plt.record_provisioning_event(p_request_id uuid, p_host text, p_level text, p_step text, p_message text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  v_id uuid;
BEGIN
  PERFORM plt.provisioning_assert_executor(p_host);
  PERFORM 1 FROM plt.provisioning_request r
    WHERE r.request_id = p_request_id AND r.state = 'running' AND r.claimed_by = p_host FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request % is not running under %', p_request_id, p_host USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO plt.provisioning_request_event (request_id, level, step, message)
  VALUES (p_request_id, p_level, p_step, left(coalesce(p_message, ''), 1000))
  RETURNING event_id INTO v_id;
  RETURN v_id;
END
$body$;

CREATE FUNCTION plt.mark_provisioning_request_verified(p_request_id uuid, p_host text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  PERFORM plt.provisioning_assert_executor(p_host);
  UPDATE plt.provisioning_request r
     SET evidence_token = NULL, evidence_verified_at = coalesce(r.evidence_verified_at, now())
   WHERE r.request_id = p_request_id AND r.state = 'running' AND r.claimed_by = p_host;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request % is not running under %', p_request_id, p_host USING ERRCODE = 'no_data_found';
  END IF;
END
$body$;

CREATE FUNCTION plt.finish_provisioning_request(p_request_id uuid, p_host text, p_state text, p_outcome text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  PERFORM plt.provisioning_assert_executor(p_host);
  IF p_state IS NULL OR p_state NOT IN ('succeeded', 'failed', 'refused') THEN
    RAISE EXCEPTION 'finish_provisioning_request: state succeeded, failed or refused' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE plt.provisioning_request r
     SET state = p_state, finished_at = now(), evidence_token = NULL, outcome = left(p_outcome, 2000)
   WHERE r.request_id = p_request_id AND r.state = 'running' AND r.claimed_by = p_host;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request % is not running under %', p_request_id, p_host USING ERRCODE = 'no_data_found';
  END IF;
END
$body$;

CREATE FUNCTION plt.executor_beat(p_host text, p_version text) RETURNS timestamptz
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  v_at timestamptz;
BEGIN
  PERFORM plt.provisioning_assert_executor(p_host);
  INSERT INTO plt.executor_heartbeat (singleton, executor_host, executor_version, seen_at)
  VALUES (true, p_host, p_version, now())
  ON CONFLICT (singleton) DO UPDATE SET executor_host = EXCLUDED.executor_host,
                                        executor_version = EXCLUDED.executor_version, seen_at = EXCLUDED.seen_at
  RETURNING seen_at INTO v_at;
  RETURN v_at;
END
$body$;

REVOKE ALL ON FUNCTION plt.provisioning_request_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION plt.provisioning_member_of(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION plt.submit_provisioning_request(text, text, jsonb, uuid, uuid, text, timestamptz, timestamptz, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION plt.provisioning_assert_executor(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION plt.provisioning_requeue(uuid[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION plt.claim_provisioning_request(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION plt.requeue_own_requests(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION plt.renew_provisioning_lease(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION plt.record_provisioning_event(uuid, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION plt.mark_provisioning_request_verified(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION plt.finish_provisioning_request(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION plt.executor_beat(text, text) FROM PUBLIC;
