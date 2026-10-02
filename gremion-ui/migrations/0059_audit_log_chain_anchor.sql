-- 0059_audit_log_chain_anchor.sql
-- F1-FIX-02 (F1 sweep H01 = K1#0, K1#25; K1#2): the INV-1 audit hash chain
-- survives the retention purge, and its order is fixed under its lock.
--
-- THE DEFECTS THIS CLOSES
-- -----------------------
-- 1. H01. 0043's verifier starts every walk at prev = NULL. The daily G-024
--    retention purge (audit-db.ts purgeAuditLogsOlderThan) deletes the OLDEST
--    rows, i.e. the chain head, so from the first purge on the first surviving
--    row links to a hash no row produces and audit_log_verify_chain() reports
--    BROKEN on every 6 h tick, forever. A permanent false alarm masks every
--    real one.
-- 2. K1#2. The row id came from the column DEFAULT, drawn BEFORE the trigger
--    took the chain lock, while the verifier walks in id order. A writer whose
--    id was drawn while another transaction held the lock linked itself behind
--    a row with a HIGHER id: the chain forked with nobody tampering.
--
-- WHAT THIS FILE DOES
-- -------------------
-- * audit_log_chain_anchor: one row, the row_hash of the last row a purge
--   removed (the value the first surviving row's prev_hash must equal), the id
--   it removed through, the running count of removed rows, and how the anchor
--   was set ('purge' or 'adopted', see below).
-- * audit_log_purge_before(cutoff): the only purge. Under the chain lock it
--   removes the longest PREFIX of the chain (in id order) whose rows are all
--   older than the cutoff, and moves the anchor to the last removed row_hash
--   in the same transaction. A row older than the cutoff that sits behind a
--   newer one stays until that one ages out too (created_at is the writing
--   transaction's start, so the overlap is that transaction's length): a purge
--   never cuts a hole into the chain.
-- * audit_log_hash_chain() (the 0043 trigger function, replaced in place; the
--   trigger itself is unchanged): draws the id UNDER the lock, so id order is
--   lock order is chain order, and an empty table chains from the anchor.
-- * audit_log_verify_chain(): starts at the anchor instead of NULL. The anchor
--   is read in the same statement (one snapshot) as the rows it anchors, so a
--   purge committing mid-walk cannot produce a false BROKEN.
--
-- WHAT IT NEVER DOES
-- ------------------
-- It rewrites no audit_log row and deletes none. On a database whose head was
-- already purged before this file (the first row's prev_hash is not NULL and
-- there is no anchor yet), a migration cannot tell a retention purge from a
-- deleted head, so it ABORTS instead of guessing -- unless the operator has
-- acknowledged exactly that hash for the database
-- (gremion.audit_chain_adopt_head, see the error's HINT). The anchor is then
-- recorded with source 'adopted'.
--
-- KNOWN LIMITS (unchanged by this file, recorded as residuals)
-- ------------------------------------------------------------
-- * Tail truncation is still undetectable from inside the table (0043's
--   verifier comment); so is a head deletion whose author also moves the
--   anchor. Both need an external high-water mark or a keyed chain; the keyed
--   (HMAC) chain is operator decision D-5, deferred.
-- * A writer running at REPEATABLE READ or SERIALIZABLE would read the tail
--   from its transaction snapshot. Every kernel writer uses READ COMMITTED.
--
-- Idempotent (IF NOT EXISTS, CREATE OR REPLACE, the adoption step returns once
-- an anchor exists); no BEGIN/COMMIT wrapper: the runner applies the file and
-- its ledger row in one transaction (G-078).

CREATE TABLE IF NOT EXISTS audit_log_chain_anchor (
  singleton    boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  anchor_hash  text NOT NULL CHECK (anchor_hash ~ '^[0-9a-f]{64}$'),
  -- id of the last row the purges removed; NULL for an adopted anchor
  through_id   bigint,
  rows_removed bigint NOT NULL DEFAULT 0 CHECK (rows_removed >= 0),
  source       text NOT NULL CHECK (source IN ('purge', 'adopted')),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION audit_log_hash_chain() RETURNS trigger AS $$
DECLARE v_prev text;
BEGIN
  -- Serialize audit appends (and purges) per database, as in 0043.
  PERFORM pg_advisory_xact_lock(4096123456);
  -- K1#2: the id is drawn UNDER the lock. The lock is held to commit, so a
  -- later holder always draws a higher id: id order is chain order. The
  -- column has no DEFAULT any more (below), so this is the only draw: ids stay
  -- dense, and a supplied id is overwritten.
  NEW.id := nextval(pg_get_serial_sequence('audit_log', 'id'));
  SELECT row_hash INTO v_prev FROM audit_log ORDER BY id DESC LIMIT 1;
  IF NOT FOUND THEN
    -- Empty table: a purge removed every row, so chain from its anchor (NULL
    -- when nothing was ever purged: genesis).
    SELECT anchor_hash INTO v_prev FROM audit_log_chain_anchor;
  END IF;
  -- now() is the transaction-start time, so rows written in one txn share a
  -- timestamp: correct for audit causality and deterministic for the hash.
  IF NEW.created_at IS NULL THEN NEW.created_at := now(); END IF;
  NEW.prev_hash := v_prev;
  NEW.row_hash := encode(digest(
    audit_log_canonical(v_prev, NEW.id, NEW.created_at, NEW.user_id, NEW.field, NEW.old_value, NEW.new_value, NEW.correlation_id),
    'sha256'), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The id now comes from the trigger alone (the sequence stays OWNED BY the
-- column, so TRUNCATE ... RESTART IDENTITY still resets it). NOT NULL is
-- checked after BEFORE ROW triggers, so every INSERT still gets an id; with the
-- trigger disabled an INSERT fails loudly instead of writing an unchained row.
-- Catalog-only: no row is touched.
ALTER TABLE audit_log ALTER COLUMN id DROP DEFAULT;

-- Returns the id of the first row whose linkage or stored hash is broken, else
-- NULL. The walk starts at the anchor (NULL: genesis).
CREATE OR REPLACE FUNCTION audit_log_verify_chain() RETURNS bigint AS $$
DECLARE r record; v_prev text; v_first boolean := true; v_expected text;
BEGIN
  FOR r IN
    SELECT l.*, (SELECT a.anchor_hash FROM audit_log_chain_anchor a) AS chain_anchor
    FROM audit_log l
    ORDER BY l.id ASC
  LOOP
    IF v_first THEN
      v_prev := r.chain_anchor;
      v_first := false;
    END IF;
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

-- The retention purge. Returns the number of rows removed.
CREATE OR REPLACE FUNCTION audit_log_purge_before(p_cutoff timestamptz) RETURNS bigint AS $$
DECLARE v_keep_from bigint; v_last_id bigint; v_last_hash text; v_removed bigint;
BEGIN
  IF p_cutoff IS NULL THEN
    RAISE EXCEPTION 'audit_log_purge_before: the cutoff must not be NULL';
  END IF;
  PERFORM pg_advisory_xact_lock(4096123456);
  -- The first row that must stay; everything before it in chain order goes.
  SELECT min(id) INTO v_keep_from FROM audit_log WHERE created_at >= p_cutoff;
  SELECT id, row_hash INTO v_last_id, v_last_hash
    FROM audit_log
   WHERE v_keep_from IS NULL OR id < v_keep_from
   ORDER BY id DESC
   LIMIT 1;
  IF v_last_id IS NULL THEN
    RETURN 0;
  END IF;
  DELETE FROM audit_log WHERE id <= v_last_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  INSERT INTO audit_log_chain_anchor AS a (singleton, anchor_hash, through_id, rows_removed, source, updated_at)
  VALUES (true, v_last_hash, v_last_id, v_removed, 'purge', now())
  ON CONFLICT (singleton) DO UPDATE
    SET anchor_hash  = EXCLUDED.anchor_hash,
        through_id   = EXCLUDED.through_id,
        rows_removed = a.rows_removed + EXCLUDED.rows_removed,
        source       = 'purge',
        updated_at   = EXCLUDED.updated_at;
  RETURN v_removed;
END;
$$ LANGUAGE plpgsql;

-- A head purged BEFORE this file: adopt its trace only on an explicit,
-- exact acknowledgement. Never rewrite, never guess.
DO $$
DECLARE
  v_head_id   bigint;
  v_head_prev text;
  v_ack       text := nullif(current_setting('gremion.audit_chain_adopt_head', true), '');
BEGIN
  IF EXISTS (SELECT 1 FROM audit_log_chain_anchor) THEN
    RETURN;
  END IF;
  SELECT id, prev_hash INTO v_head_id, v_head_prev FROM audit_log ORDER BY id ASC LIMIT 1;
  IF v_head_id IS NULL OR v_head_prev IS NULL THEN
    -- empty, or the chain still starts at genesis: nothing to anchor
    RETURN;
  END IF;
  IF v_ack IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format(
        'audit_log: cannot anchor the hash chain: its first row (id %s) links to prev_hash %s, '
        'a row no longer in the table; set gremion.audit_chain_adopt_head to that hash if a retention '
        'purge removed it (see HINT). Nothing was adopted and no row was changed.',
        v_head_id, v_head_prev),
      DETAIL = 'A migration cannot tell a retention purge from a deleted head, so it refuses instead of guessing.',
      HINT = format(
        'After checking that the missing rows were removed by the retention purge: '
        'ALTER DATABASE %I SET gremion.audit_chain_adopt_head = %L; restart so new sessions see it, '
        'let the migration apply, then ALTER DATABASE %I RESET gremion.audit_chain_adopt_head;',
        current_database(), v_head_prev, current_database());
  END IF;
  IF v_ack IS DISTINCT FROM v_head_prev THEN
    RAISE EXCEPTION
      'audit_log: gremion.audit_chain_adopt_head (%) does not match the prev_hash of the first row (id %: %); nothing adopted',
      v_ack, v_head_id, v_head_prev;
  END IF;
  INSERT INTO audit_log_chain_anchor (singleton, anchor_hash, through_id, rows_removed, source)
  VALUES (true, v_head_prev, NULL, 0, 'adopted');
  RAISE NOTICE 'audit_log: adopted prev_hash % of row % as the chain anchor (operator acknowledged)', v_head_prev, v_head_id;
END
$$;
