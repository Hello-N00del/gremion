-- gremion:phase expand
-- gremion_platform, 0015 (module switch-off with the 30-day Karenz, phase 2):
-- switching a module off no longer drops its database at once.
--
--  * plt.module_database gains the state `blocked`: the module database is kept
--    alive but unreachable for the app role. A row may reach `blocked` only with a
--    recorded export (like `dropped` since 0003), so a blocked database always has
--    its backup. The old state CHECK cannot be widened in place; it is dropped and
--    re-added NOT VALID, then validated in this file.
--  * plt.module_karenz is the authoritative clock of one switch-off: one row per
--    (customer, module) switch-off, final_at = switched_off_at + 30 days. At most
--    one LIVE row (open, restoring, finalizing) per pair; closed rows
--    (restored, finalized) accumulate. The platform job alone writes final_mode
--    (dry or live), platform_done_at and export_deleted_at. The row copies the path
--    and sha256 of the verified export of ITS switch-off, so each row owns the
--    export it must delete. actor_kind / actor_id are the operator's view only.
--  * plt.module_karenz_event is the append-only log of what the platform job and
--    the councils' per-tenant passes did for a row (redacted, <= 1000 chars).
--  * The councils reach this through TWO SECURITY DEFINER functions, as the login
--    role gremion_ui_modules (a direct member of the marker role
--    plt_council_requester; the EXECUTE grants are init's, ensureCouncilRequester).
--    It holds no table privilege. Trust model: the councils share this one role, and
--    the executor and the calling app scope every call by customer. The list
--    returns NO actor column, no export path and no checksum; the person who
--    switched is recorded only in the audit log. plt.council_karenz_report appends an event and sets the two
--    tenant-side marks (tenant_done, restored). Reports are ADVISORY: nothing
--    destructive on the platform side ever reads a council report to decide to
--    delete; the platform job uses final_at and the blocked state only.
--
-- SQLSTATEs the callers map: 42501 wrong role, 22023 bad input or an illegal mark.
-- The functions run with search_path = pg_catalog, pg_temp, name every object
-- schema-qualified and are revoked from PUBLIC.

SET LOCAL lock_timeout = '5s';

ALTER TABLE plt.module_database DROP CONSTRAINT module_database_state_check;
ALTER TABLE plt.module_database ADD CONSTRAINT module_database_state_check
  CHECK (state IN ('enabling', 'enabled', 'disabling', 'blocked', 'dropped')) NOT VALID;
ALTER TABLE plt.module_database VALIDATE CONSTRAINT module_database_state_check;
ALTER TABLE plt.module_database ADD CONSTRAINT module_database_blocked_export_check
  CHECK (state <> 'blocked' OR exported_at IS NOT NULL) NOT VALID;
ALTER TABLE plt.module_database VALIDATE CONSTRAINT module_database_blocked_export_check;

CREATE TABLE plt.module_karenz (
  karenz_id            uuid          NOT NULL DEFAULT uuidv7(),
  customer_id          uuid          NOT NULL,
  module_id            uuid          NOT NULL,
  state                text          NOT NULL DEFAULT 'open',
  switched_off_at      timestamptz   NOT NULL DEFAULT now(),
  final_at             timestamptz   NOT NULL,
  restore_requested_at timestamptz,
  restored_at          timestamptz,
  actor_kind           text          NOT NULL,
  actor_id             uuid,
  export_path          text,
  export_sha256        text,
  export_deleted_at    timestamptz,
  export_kept_until    timestamptz,
  final_mode           text,
  platform_done_at     timestamptz,
  tenant_done_at       timestamptz,
  retained_ok_at       timestamptz,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  row_version          bigint        NOT NULL DEFAULT 1,
  CONSTRAINT module_karenz_pkey PRIMARY KEY (karenz_id),
  CONSTRAINT module_karenz_karenz_id_check CHECK (uuid_extract_version(karenz_id) = 7),
  CONSTRAINT module_karenz_state_check CHECK (state IN ('open', 'restoring', 'restored', 'finalizing', 'finalized')),
  CONSTRAINT module_karenz_final_after_off_check CHECK (final_at > switched_off_at),
  CONSTRAINT module_karenz_actor_kind_check CHECK (actor_kind IN ('person', 'operator')),
  CONSTRAINT module_karenz_final_mode_check CHECK (final_mode IN ('dry', 'live')),
  CONSTRAINT module_karenz_export_path_check CHECK (char_length(export_path) BETWEEN 1 AND 1000),
  CONSTRAINT module_karenz_export_sha256_check CHECK (export_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT module_karenz_export_pair_check CHECK ((export_path IS NULL) = (export_sha256 IS NULL)),
  -- what each state implies, so a row can never claim to be closed without the mark
  CONSTRAINT module_karenz_state_columns_check CHECK (
        (state NOT IN ('restoring', 'restored') OR restore_requested_at IS NOT NULL)
    AND (state <> 'restored' OR restored_at IS NOT NULL)
    AND (state <> 'finalized' OR (platform_done_at IS NOT NULL AND tenant_done_at IS NOT NULL))),
  CONSTRAINT module_karenz_row_version_check CHECK (row_version > 0),
  CONSTRAINT module_karenz_module_id_fkey FOREIGN KEY (module_id)
    REFERENCES plt.module (module_id) ON DELETE RESTRICT
);
-- at most one live switch-off per (customer, module); closed ones accumulate
CREATE UNIQUE INDEX module_karenz_live_key ON plt.module_karenz (customer_id, module_id)
  WHERE state IN ('open', 'restoring', 'finalizing');
CREATE INDEX module_karenz_final_at_idx ON plt.module_karenz (final_at)
  WHERE state IN ('open', 'finalizing');
CREATE INDEX module_karenz_module_id_idx ON plt.module_karenz (module_id);
CREATE TRIGGER module_karenz_touch_trg BEFORE UPDATE ON plt.module_karenz
  FOR EACH ROW EXECUTE FUNCTION plt.touch_row();
COMMENT ON TABLE plt.module_karenz IS 'DB-PLT-MODULE-KARENZ [A] | K5 | rp-plt-module-enablement | trigger: customer erased';
COMMENT ON COLUMN plt.module_karenz.customer_id IS 'xref DB-TNT-CUSTOMER';
COMMENT ON COLUMN plt.module_karenz.actor_id IS 'operator view only (karenz-status); no council function returns it, the person who switched lives in the audit log';
COMMENT ON COLUMN plt.module_karenz.export_path IS 'copied from the verified export of THIS switch-off at block time; the day-30 job deletes this file and no other';
COMMENT ON COLUMN plt.module_karenz.final_mode IS 'dry or live, written only by the platform job (karenz-run) from KARENZ_FINAL_DELETION; the tenant pass reads the mode from here';

CREATE TABLE plt.module_karenz_event (
  event_id    uuid          NOT NULL DEFAULT uuidv7(),
  karenz_id   uuid          NOT NULL,
  at          timestamptz   NOT NULL DEFAULT clock_timestamp(),
  level       text          NOT NULL,
  step        text          NOT NULL,
  message     text          NOT NULL,
  CONSTRAINT module_karenz_event_pkey PRIMARY KEY (event_id),
  CONSTRAINT module_karenz_event_event_id_check CHECK (uuid_extract_version(event_id) = 7),
  CONSTRAINT module_karenz_event_karenz_id_fkey FOREIGN KEY (karenz_id) REFERENCES plt.module_karenz (karenz_id),
  CONSTRAINT module_karenz_event_level_check CHECK (level IN ('info', 'error')),
  CONSTRAINT module_karenz_event_step_check CHECK (step ~ '^[a-z][a-z0-9:_-]{0,59}$'),
  CONSTRAINT module_karenz_event_message_check CHECK (length(message) <= 1000)
);
CREATE INDEX module_karenz_event_karenz_id_at_idx ON plt.module_karenz_event (karenz_id, at, event_id);
CREATE TRIGGER module_karenz_event_append_only_trg BEFORE UPDATE OR DELETE ON plt.module_karenz_event
  FOR EACH ROW EXECUTE FUNCTION plt.refuse_update();
CREATE TRIGGER module_karenz_event_no_truncate_trg BEFORE TRUNCATE ON plt.module_karenz_event
  FOR EACH STATEMENT EXECUTE FUNCTION plt.refuse_update();
COMMENT ON TABLE plt.module_karenz_event IS 'DB-PLT-MODULE-KARENZ-EVENT [A] | K5 | rp-plt-module-enablement | trigger: customer erased';

-- The councils' read: the live rows of ONE customer plus the rows closed inside
-- the window. No actor, no export path, no checksum.
CREATE FUNCTION plt.council_karenz_list(p_customer_id uuid, p_closed_within_days integer)
  RETURNS TABLE (karenz_id uuid, module_key text, state text, switched_off_at timestamptz, final_at timestamptz,
                 restore_requested_at timestamptz, final_mode text, platform_done_at timestamptz,
                 tenant_done_at timestamptz, export_kept_until timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
#variable_conflict use_column
BEGIN
  IF NOT plt.provisioning_member_of('plt_council_requester') THEN
    RAISE EXCEPTION 'council_karenz_list: role % is not the council requester', session_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'council_karenz_list: the customer id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_closed_within_days IS NULL OR p_closed_within_days NOT BETWEEN 0 AND 60 THEN
    RAISE EXCEPTION 'council_karenz_list: the closed window is 0 to 60 days' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    SELECT k.karenz_id, m.module_key, k.state, k.switched_off_at, k.final_at, k.restore_requested_at, k.final_mode,
           k.platform_done_at, k.tenant_done_at, k.export_kept_until
      FROM plt.module_karenz k
      JOIN plt.module m ON m.module_id = k.module_id
     WHERE k.customer_id = p_customer_id
       AND (k.state IN ('open', 'restoring', 'finalizing')
            OR (k.state = 'restored'
                AND k.restored_at >= now() - pg_catalog.make_interval(days => p_closed_within_days))
            OR (k.state = 'finalized'
                AND greatest(k.platform_done_at, k.tenant_done_at) >= now() - pg_catalog.make_interval(days => p_closed_within_days)))
     ORDER BY k.switched_off_at DESC, k.karenz_id DESC;
END
$body$;

-- The councils' write: one advisory event, optionally with a tenant-side mark.
--   tenant_done : only once final_at has passed and the row is open or finalizing;
--                 sets tenant_done_at once and, when the platform side is already
--                 done, closes the row (finalized);
--   restored    : only from restoring; closes the row (restored_at).
-- A mark is a completion claim, so it is accepted only on an info-level report: a
-- failed pass reports its error as a plain event (no mark) and the row stays open.
-- A refused mark rolls the event back with it.
CREATE FUNCTION plt.council_karenz_report(
  p_customer_id uuid, p_karenz_id uuid, p_step text, p_level text, p_message text, p_mark text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  v_row plt.module_karenz%ROWTYPE;
BEGIN
  IF NOT plt.provisioning_member_of('plt_council_requester') THEN
    RAISE EXCEPTION 'council_karenz_report: role % is not the council requester', session_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_customer_id IS NULL OR p_karenz_id IS NULL THEN
    RAISE EXCEPTION 'council_karenz_report: the customer id and the karenz id are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_step IS NULL OR p_step !~ '^[a-z][a-z0-9:_-]{0,59}$' THEN
    RAISE EXCEPTION 'council_karenz_report: invalid step name' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_level IS NULL OR p_level NOT IN ('info', 'error') THEN
    RAISE EXCEPTION 'council_karenz_report: the level is info or error' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_message IS NULL OR length(p_message) > 1000 THEN
    RAISE EXCEPTION 'council_karenz_report: the message is required and at most 1000 characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_mark IS NOT NULL AND p_mark NOT IN ('tenant_done', 'restored') THEN
    RAISE EXCEPTION 'council_karenz_report: the mark is tenant_done or restored' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_mark IS NOT NULL AND p_level = 'error' THEN
    RAISE EXCEPTION 'council_karenz_report: a completion mark needs an info-level report, not an error' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- the row of THIS customer only; locked so a mark and the platform job serialise
  SELECT * INTO v_row FROM plt.module_karenz k
   WHERE k.karenz_id = p_karenz_id AND k.customer_id = p_customer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'council_karenz_report: no such karenz row for this customer' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_mark = 'tenant_done' THEN
    IF v_row.state NOT IN ('open', 'finalizing') OR v_row.final_at > now() THEN
      RAISE EXCEPTION 'council_karenz_report: tenant_done is accepted only after final_at, for an open or finalizing row'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE plt.module_karenz k
       SET tenant_done_at = coalesce(k.tenant_done_at, now()),
           state = CASE WHEN k.platform_done_at IS NOT NULL THEN 'finalized' ELSE k.state END
     WHERE k.karenz_id = p_karenz_id;
  ELSIF p_mark = 'restored' THEN
    IF v_row.state <> 'restoring' THEN
      RAISE EXCEPTION 'council_karenz_report: restored is accepted only for a restoring row' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE plt.module_karenz k SET state = 'restored', restored_at = now() WHERE k.karenz_id = p_karenz_id;
  END IF;
  INSERT INTO plt.module_karenz_event (karenz_id, level, step, message) VALUES (p_karenz_id, p_level, p_step, p_message);
END
$body$;

REVOKE ALL ON FUNCTION plt.council_karenz_list(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION plt.council_karenz_report(uuid, uuid, text, text, text, text) FROM PUBLIC;
