-- gremion:phase expand
-- gremion_platform, 0017 (module switch-off with the 30-day Karenz, phase 2):
-- plt.council_karenz_report accepts the tenant_done mark only for a row whose
-- final_mode the platform job recorded as 'live'.
--
-- Why: tenant_done says "the tenant side deleted what it had to delete". In a dry
-- run (final_mode 'dry', or not yet recorded) nothing is deleted, so the claim can
-- only be wrong. Accepting it anyway sets tenant_done_at on a row that is still
-- open; when the operator later switches the deletion on, the platform job would
-- finish the platform half and close the row as finalized although the tenant side
-- never deleted anything. The tenant pass already reports the mark only for a
-- 'finalizing' row (which only a live job produces); this makes the platform
-- refuse the other cases too instead of trusting the caller.
--
-- Body: identical to 0016 except for the added final_mode check in the tenant_done
-- branch. CREATE OR REPLACE keeps the owner and the ACL of the function (EXECUTE for
-- the council marker role, none for PUBLIC), so no grant statement is repeated here;
-- the migration test asserts the ACL is unchanged. SQLSTATE 22023 for the new
-- refusal, like every other illegal mark.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION plt.council_karenz_report(
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
    IF v_row.final_mode IS DISTINCT FROM 'live' THEN
      RAISE EXCEPTION 'council_karenz_report: tenant_done is accepted only when the platform job recorded final_mode live (a dry run deletes nothing)'
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
