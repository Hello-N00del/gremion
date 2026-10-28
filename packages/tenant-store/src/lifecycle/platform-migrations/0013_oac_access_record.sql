-- gremion:phase expand
-- gremion_platform, 0013 (TRD-092 / TRD-191 / PRD-OPS-006): the vendor and
-- operator ACCESS RECORD, the one log line that names its actor on purpose
-- (TRD-148 retires into it). Every access by the vendor or anyone acting for the
-- vendor to a council's stored data -- the control panel's operator actions on a
-- customer, the host break-glass (gremion-tenant request / suspend / resume /
-- reconcile) -- is one row: WHO (operator uuid or host login), WHEN (server
-- clock), WHAT (the action and what was reached), WHY (free text, 10 to 500
-- characters), for which customer (customer_slug). The council administrator
-- reads their own customer's rows inside the product (gremion-ui settings,
-- oac.list_access_records).
--
-- RETENTION: RC-LOG-AUD (docs/compliance/retention-catalogue.md) = the security
-- window (RC-LOG-SEC, 27 d configured, 30 d cap) and NEVER shorter (TRD-191). The
-- record outlives a customer's erasure, so it carries no foreign key; it is
-- purged from the oldest entry only, by oac.purge_access_records, which refuses
-- a window outside 27..30 d and a caller that is not the host executor.
--
-- APPEND-ONLY: nobody holds a table privilege; UPDATE and TRUNCATE are refused
-- by trigger for every role including the owner; DELETE is refused unless the
-- purge function raised the transaction-local flag AND the row is older than the
-- window floor, so even a forged flag removes no young row.
--
-- WRITER: SECURITY DEFINER with a pinned search_path and no PUBLIC execute, as
-- 0009/0010. The origin is derived from the caller's LOGIN role's marker
-- membership (plt_panel_requester -> panel, plt_executor -> host), never from an
-- argument. Grants to the panel, executor and read roles are made by
-- ensurePanelRequester / ensureExecutorRole / ensureAccessReader
-- (@gremion/provisioning pg.ts), as for the plt functions.

CREATE SCHEMA IF NOT EXISTS oac;

CREATE FUNCTION oac.refuse_update() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  RAISE EXCEPTION '%.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$body$;

-- The security-log window (RC-LOG-SEC, TRD-143): the floor of every purge.
CREATE FUNCTION oac.access_window() RETURNS interval
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $body$
  SELECT interval '27 days'
$body$;

CREATE TABLE oac.access_record (
  access_id      uuid         NOT NULL DEFAULT uuidv7(),
  at             timestamptz  NOT NULL DEFAULT clock_timestamp(),
  customer_slug  text         NOT NULL,
  origin         text         NOT NULL,
  actor          text         NOT NULL,
  action         text         NOT NULL,
  what           text         NOT NULL,
  why            text         NOT NULL,
  request_id     uuid,
  CONSTRAINT access_record_pkey PRIMARY KEY (access_id),
  CONSTRAINT access_record_access_id_check CHECK (uuid_extract_version(access_id) = 7),
  CONSTRAINT access_record_customer_slug_check CHECK (customer_slug ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
    AND length(customer_slug) BETWEEN 3 AND 30 AND customer_slug <> 'platform'),
  CONSTRAINT access_record_origin_check CHECK (origin IN ('panel', 'host')),
  CONSTRAINT access_record_actor_check CHECK (
    (origin = 'panel' AND actor ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR (origin = 'host' AND actor ~ '^[a-z_][a-z0-9_-]{0,31}$')),
  CONSTRAINT access_record_action_check CHECK (action ~ '^[a-z][a-z0-9_.-]{0,39}$'),
  CONSTRAINT access_record_what_check CHECK (length(what) BETWEEN 3 AND 500),
  CONSTRAINT access_record_why_check CHECK (length(why) BETWEEN 10 AND 500)
);
COMMENT ON TABLE oac.access_record IS 'TRD-092 vendor/operator access to a council''s data: who, when, what, why | RC-LOG-AUD | 27 d (the security window; purged from the oldest entry only)';
CREATE INDEX access_record_customer_slug_at_idx ON oac.access_record (customer_slug, at DESC, access_id DESC);
CREATE INDEX access_record_at_idx ON oac.access_record (at);

CREATE FUNCTION oac.access_record_no_delete() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  IF coalesce(current_setting('oac.purging', true), '') = 'on' AND OLD.at < now() - oac.access_window() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '%.% is append-only: a row leaves only through oac.purge_access_records, and only past the security window', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$body$;

CREATE TRIGGER access_record_no_update_trg BEFORE UPDATE ON oac.access_record
  FOR EACH ROW EXECUTE FUNCTION oac.refuse_update();
CREATE TRIGGER access_record_no_delete_trg BEFORE DELETE ON oac.access_record
  FOR EACH ROW EXECUTE FUNCTION oac.access_record_no_delete();
CREATE TRIGGER access_record_no_truncate_trg BEFORE TRUNCATE ON oac.access_record
  FOR EACH STATEMENT EXECUTE FUNCTION oac.refuse_update();

-- The one write. p_actor: the operator's uuid (panel) or the host login user (host).
CREATE FUNCTION oac.record_access(p_slug text, p_action text, p_what text, p_why text, p_actor text, p_request_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  v_panel boolean := plt.provisioning_member_of('plt_panel_requester');
  v_host boolean := plt.provisioning_member_of('plt_executor');
  v_origin text;
  v_id uuid;
BEGIN
  IF v_panel = v_host THEN
    RAISE EXCEPTION 'record_access: role % is neither the panel requester nor the executor', session_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_origin := CASE WHEN v_panel THEN 'panel' ELSE 'host' END;
  IF p_slug IS NULL OR p_slug !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' OR length(p_slug) NOT BETWEEN 3 AND 30 OR p_slug = 'platform' THEN
    RAISE EXCEPTION 'record_access: invalid customer slug' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_action IS NULL OR p_action !~ '^[a-z][a-z0-9_.-]{0,39}$' THEN
    RAISE EXCEPTION 'record_access: the action is a short lowercase identifier' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_what IS NULL OR length(p_what) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'record_access: what was accessed, 3 to 500 characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_why IS NULL OR length(p_why) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'record_access: why, 10 to 500 characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_actor IS NULL OR (v_origin = 'panel' AND p_actor !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR (v_origin = 'host' AND p_actor !~ '^[a-z_][a-z0-9_-]{0,31}$') THEN
    RAISE EXCEPTION 'record_access: the actor is the operator uuid (panel) or the host login user (host)' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO oac.access_record (customer_slug, origin, actor, action, what, why, request_id)
  VALUES (p_slug, v_origin, p_actor, p_action, p_what, p_why, p_request_id)
  RETURNING access_id INTO v_id;
  RETURN v_id;
END
$body$;

-- The council administrator's read, scoped to ONE customer; newest first.
CREATE FUNCTION oac.list_access_records(p_slug text, p_limit integer, p_before timestamptz)
  RETURNS TABLE (access_id uuid, at timestamptz, origin text, actor text, action text, what text, why text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  IF p_slug IS NULL OR p_slug !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' OR length(p_slug) NOT BETWEEN 3 AND 30 THEN
    RAISE EXCEPTION 'list_access_records: invalid customer slug' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'list_access_records: limit 1 to 500' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    SELECT r.access_id, r.at, r.origin, r.actor, r.action, r.what, r.why
      FROM oac.access_record r
     WHERE r.customer_slug = p_slug AND (p_before IS NULL OR r.at < p_before)
     ORDER BY r.at DESC, r.access_id DESC
     LIMIT p_limit;
END
$body$;

-- The purge: rows older than the window go, nothing else. The window may be
-- widened to the 30 d cap, never narrowed below the security window (TRD-191).
CREATE FUNCTION oac.purge_access_records(p_window interval) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  v_n integer;
BEGIN
  IF NOT plt.provisioning_member_of('plt_executor') THEN
    RAISE EXCEPTION 'purge_access_records: role % is not the executor', session_user USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_window IS NULL OR p_window < oac.access_window() OR p_window > interval '30 days' THEN
    RAISE EXCEPTION 'purge_access_records: the window is 27 to 30 days (RC-LOG-AUD, never shorter than the security window)'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM set_config('oac.purging', 'on', true);
  DELETE FROM oac.access_record WHERE at < now() - p_window;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('oac.purging', 'off', true);
  RETURN v_n;
END
$body$;

REVOKE ALL ON FUNCTION oac.refuse_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION oac.access_window() FROM PUBLIC;
REVOKE ALL ON FUNCTION oac.access_record_no_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION oac.record_access(text, text, text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION oac.list_access_records(text, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION oac.purge_access_records(interval) FROM PUBLIC;
