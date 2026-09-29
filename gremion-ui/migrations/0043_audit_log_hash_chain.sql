-- 043_audit_log_hash_chain.sql
-- Civitas Governance Core INV-1 (tamper-evident record): hash-chain audit_log so
-- "tamper-evident" is literally true. A BEFORE INSERT trigger links each row to the
-- chain tail (row_hash = sha256(prev_hash || canonical(row))), serialized per-DB via
-- an advisory xact lock. The trigger covers BOTH writers (writeAuditEntry AND the raw
-- newsletter event-consumer insert) with zero app-insert changes. Wrapped BEGIN/COMMIT.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE audit_log
  ADD COLUMN prev_hash TEXT,
  ADD COLUMN row_hash  TEXT;

-- Deterministic canonical serialization (RS = chr(30) field separators).
CREATE OR REPLACE FUNCTION audit_log_canonical(
  p_prev text, p_id bigint, p_created timestamptz, p_user text,
  p_field text, p_old text, p_new text, p_corr text
) RETURNS text AS $$
  SELECT coalesce(p_prev, '') || chr(30)
      || p_id::text || chr(30)
      || to_char(p_created AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || chr(30)
      || p_user || chr(30)
      || p_field || chr(30)
      || coalesce(p_old, '') || chr(30)
      || p_new || chr(30)
      || coalesce(p_corr, '');
$$ LANGUAGE sql IMMUTABLE;

-- Backfill any pre-existing rows into the chain (id order) so verification is intact.
DO $$
DECLARE r record; v_prev text := NULL; v_hash text;
BEGIN
  FOR r IN SELECT * FROM audit_log ORDER BY id ASC LOOP
    v_hash := encode(digest(
      audit_log_canonical(v_prev, r.id, r.created_at, r.user_id, r.field, r.old_value, r.new_value, r.correlation_id),
      'sha256'), 'hex');
    UPDATE audit_log SET prev_hash = v_prev, row_hash = v_hash WHERE id = r.id;
    v_prev := v_hash;
  END LOOP;
END $$;

ALTER TABLE audit_log ALTER COLUMN row_hash SET NOT NULL;

CREATE OR REPLACE FUNCTION audit_log_hash_chain() RETURNS trigger AS $$
DECLARE v_prev text;
BEGIN
  -- Serialize concurrent audit appends so the (read tail → compute → insert)
  -- sequence is atomic and the chain can't fork under concurrency. The lock key
  -- is a fixed per-database constant: Civitas/StuRaOS is per-tenant-database
  -- (every tenant has its own Postgres; getDb() resolves a per-tenant pool), so
  -- a constant lock correctly serializes only this tenant's audit_log. If this
  -- ever moves to single-schema multi-tenancy, derive the key from the tenant id
  -- (e.g. hashtext(tenant_id)) so tenants don't serialize on one global lock.
  PERFORM pg_advisory_xact_lock(4096123456);
  SELECT row_hash INTO v_prev FROM audit_log ORDER BY id DESC LIMIT 1;
  -- now() is the transaction-start time, so rows written in one txn share a
  -- timestamp — correct for audit causality and deterministic for the hash.
  IF NEW.created_at IS NULL THEN NEW.created_at := now(); END IF;
  NEW.prev_hash := v_prev;
  NEW.row_hash := encode(digest(
    audit_log_canonical(v_prev, NEW.id, NEW.created_at, NEW.user_id, NEW.field, NEW.old_value, NEW.new_value, NEW.correlation_id),
    'sha256'), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_hash_chain_trg ON audit_log;
CREATE TRIGGER audit_log_hash_chain_trg
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_hash_chain();

-- Verifier: returns the id of the first row whose linkage or stored hash is broken, else NULL.
-- Detects any in-place UPDATE and any mid-chain INSERT/DELETE (the next row's
-- prev_hash stops matching the surviving predecessor's row_hash). KNOWN
-- LIMITATION: a self-contained chain cannot detect TAIL truncation — deleting
-- the most recent N rows leaves a shorter but internally-consistent chain. Full
-- truncation-evidence needs an external high-water mark (last row_hash + count
-- in a separate control plane / WORM sink); tracked as a Phase-3 follow-up.
CREATE OR REPLACE FUNCTION audit_log_verify_chain() RETURNS bigint AS $$
DECLARE r record; v_prev text := NULL; v_expected text;
BEGIN
  FOR r IN SELECT * FROM audit_log ORDER BY id ASC LOOP
    IF coalesce(r.prev_hash, '') <> coalesce(v_prev, '') THEN
      RETURN r.id;
    END IF;
    v_expected := encode(digest(
      audit_log_canonical(v_prev, r.id, r.created_at, r.user_id, r.field, r.old_value, r.new_value, r.correlation_id),
      'sha256'), 'hex');
    IF r.row_hash IS DISTINCT FROM v_expected THEN
      RETURN r.id;
    END IF;
    v_prev := r.row_hash;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

COMMIT;
