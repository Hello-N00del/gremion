-- gremion:phase expand
-- gremion_platform, 0011 (create-harden H4): a lease that lapses must never
-- let a second run of the same customer start while the first can still write.
--
--   * renew_provisioning_lease REFUSES a lease that has already lapsed
--     (lease_until < now()): a holder that was frozen or cut off cannot revive
--     it. The holder's own fence (gremion-executor: it kills its handler
--     process group at last-successful-renewal + lease - lease/5) fires BEFORE
--     lease_until, so a lapsed lease means "the holder has stopped".
--   * claim_provisioning_request re-queues a lapsed lease only 60 s AFTER
--     lease_until (grace), so the holder's kill has completed before attempt
--     + 1 can be claimed. While the request is `running` the partial unique
--     index provisioning_request_running_customer_slug_key and the NOT EXISTS
--     in the claim keep every other host off the slug.
-- Signatures are unchanged (the executor's grants, pg.ts, are untouched); the
-- bodies are 0010's with the two lease conditions changed.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION plt.renew_provisioning_lease(p_request_id uuid, p_host text, p_lease_seconds integer) RETURNS timestamptz
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  v_until timestamptz;
BEGIN
  PERFORM plt.provisioning_assert_executor(p_host);
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 3600 THEN
    RAISE EXCEPTION 'renew_provisioning_lease: lease of 30 to 3600 seconds' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE plt.provisioning_request r SET lease_until = now() + make_interval(secs => p_lease_seconds)
   WHERE r.request_id = p_request_id AND r.state = 'running' AND r.claimed_by = p_host AND r.lease_until >= now()
  RETURNING r.lease_until INTO v_until;
  IF v_until IS NULL THEN
    RAISE EXCEPTION 'request % is not running under % (or its lease has lapsed)', p_request_id, p_host USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v_until;
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
  UPDATE plt.provisioning_request r
     SET state = 'expired', finished_at = now(), evidence_token = NULL,
         args = plt.provisioning_purged_args(r.kind, r.args),
         outcome = 'expired: not claimed within 30 minutes of its submission'
   WHERE r.request_id IN (SELECT q.request_id FROM plt.provisioning_request q
                           WHERE q.state = 'queued' AND q.attempt = 0 AND q.created_at < now() - interval '30 minutes'
                           ORDER BY q.request_id FOR UPDATE SKIP LOCKED);
  PERFORM plt.provisioning_requeue(ARRAY(SELECT q.request_id FROM plt.provisioning_request q
                                          WHERE q.state = 'running' AND q.lease_until < now() - interval '60 seconds'
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
    RETURN;
  END;
  RETURN QUERY SELECT r.request_id, r.kind, r.customer_slug, r.origin, r.operator_id, r.attempt
                 FROM plt.provisioning_request r WHERE r.request_id = v_id;
END
$body$;
