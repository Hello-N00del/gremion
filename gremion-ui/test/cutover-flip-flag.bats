#!/usr/bin/env bats
#
# DEAD SUITE — carve residue. It cannot run in this repository, and renaming its
# coordinates does not change that. `gremion-ui/scripts/cutover-flip-flag.mjs`
# is NOT in this tree: it left with the finance module, and so did the StuFis
# subsystem whose feature flags every case below flips. No Makefile target and
# no CI job invokes `gremion-ui/test/`, so nothing has executed this file since
# the carve; run by hand it would skip on an unreachable DB, or fail on a
# missing script. It is kept, not deleted, so the decision to drop it is the
# operator's — see the "Carve residue that no runner touches" entry in
# KNOWN_ISSUES.md. Everything below describes the pre-carve product.
#
# Phase 5 cutover CLI — happy-path, dry-run, idempotent, rollback,
# bad-input, and transaction-atomicity coverage for
# gremion-ui/scripts/cutover-flip-flag.mjs.
#
# Pattern mirrors test/migration-diff-smoke.bats:
#   - cd into gremion-ui/ so `node scripts/...` runs against the
#     workspace package
#   - rely on the host's running gremion-postgres-1 (mapped to
#     127.0.0.1:5433 by docker-compose.override.yml) for DB writes
#   - snapshot the flag row before each test and restore it after, so
#     these tests do not pollute the dev DB's actual flag state
#   - skip (not fail) when Postgres is unreachable — these tests are
#     operator-paced harness coverage, not a tight-loop runtime path
#
# Coverage map per Phase 5 plan Task 5:
#   1. happy path     → UPSERTs row, exits 0, prints row
#   2. dry-run        → prints SQL plan, exits 0, no DB write
#   3. idempotent     → second consecutive flip is a no-op exit 0
#   4. rollback       → native → stufis flip restores the row
#   5. bad input      → unknown domain / to / missing flags exit 2
#   6. atomicity      → mid-tx error rolls back (no partial write)

setup() {
  cd "$BATS_TEST_DIRNAME/.."

  # Default to gremion-postgres-1 published port; allow override.
  export DATABASE_URL="${DATABASE_URL:-postgresql://stura:dev_cutover_pw_123@127.0.0.1:5433/stura}"

  # Skip the test if Postgres isn't reachable — operator-paced harness
  # code, not a tight-loop runtime path. The smoke test in
  # migration-diff-smoke.bats follows the same skip-on-unreachable
  # philosophy.
  if ! psql "$DATABASE_URL" -c "SELECT 1" >/dev/null 2>&1; then
    skip "Postgres unreachable at $DATABASE_URL"
  fi

  # Snapshot the current flag row (if any) so we can restore it after.
  # Stored in a per-test sidecar table so concurrent test invocations
  # do not clobber each other. The snapshot must run BEFORE the test
  # mutates anything.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 >/dev/null <<SQL
    DROP TABLE IF EXISTS cutover_flip_flag_snapshot_${BATS_TEST_NUMBER};
    CREATE TABLE cutover_flip_flag_snapshot_${BATS_TEST_NUMBER} AS
      SELECT * FROM config_store WHERE key = 'finance.feature_flags';
SQL
}

teardown() {
  # Restore the snapshot regardless of test outcome. If the test
  # was skipped before setup mutated anything, the table may not
  # exist — guard with IF EXISTS.
  if [[ -n "${DATABASE_URL:-}" ]] && psql "$DATABASE_URL" -c "SELECT 1" >/dev/null 2>&1; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 >/dev/null <<SQL || true
      BEGIN;
      DELETE FROM config_store WHERE key = 'finance.feature_flags';
      INSERT INTO config_store (key, value, updated_at)
        SELECT key, value, updated_at
          FROM cutover_flip_flag_snapshot_${BATS_TEST_NUMBER};
      DROP TABLE IF EXISTS cutover_flip_flag_snapshot_${BATS_TEST_NUMBER};
      COMMIT;
SQL
  fi
}

# ─────────────────────────────────────────────────────────────────
# Helper — read a single domain's bool out of the JSONB flag row.
# Prints 'true' / 'false' / '' (empty when no row or key missing).
# ─────────────────────────────────────────────────────────────────
_flag_value_for() {
  local domain="$1"
  psql "$DATABASE_URL" -tA -c \
    "SELECT (value -> '${domain}')::text FROM config_store WHERE key = 'finance.feature_flags'" \
    2>/dev/null | tr -d '[:space:]'
}

# ─────────────────────────────────────────────────────────────────
# Test 1 — happy path: UPSERTs the row, exits 0, prints the row.
#
# Note: the dev DB's seed leaves every flag at true, so a 'flip to
# native' would hit the no-op branch (covered separately by test 3).
# We seed fiscal-years=true and then flip --to stufis so the actual
# UPSERT write branch is exercised here.
# ─────────────────────────────────────────────────────────────────
@test "happy path: --domain fiscal-years --to stufis UPSERTs the row, exits 0, prints row" {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 >/dev/null <<SQL
    INSERT INTO config_store (key, value)
      VALUES ('finance.feature_flags', jsonb_build_object('fiscal-years', true))
    ON CONFLICT (key) DO UPDATE
      SET value = jsonb_set(config_store.value, ARRAY['fiscal-years'], 'true'::jsonb);
SQL

  run node scripts/cutover-flip-flag.mjs --domain fiscal-years --to stufis
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "\[cutover\] committed: finance.feature_flags.fiscal-years = stufis (false)"
  echo "$output" | grep -q "\[cutover\] config_store row after run:"
  [ "$(_flag_value_for fiscal-years)" = "false" ]
}

# ─────────────────────────────────────────────────────────────────
# Test 2 — dry-run: prints SQL, exits 0, DB unchanged
# ─────────────────────────────────────────────────────────────────
@test "dry-run: --dry-run prints SQL and exits 0 without changing the DB" {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 >/dev/null <<SQL
    INSERT INTO config_store (key, value)
      VALUES ('finance.feature_flags', jsonb_build_object('fiscal-years', false))
    ON CONFLICT (key) DO UPDATE
      SET value = jsonb_set(config_store.value, ARRAY['fiscal-years'], 'false'::jsonb);
SQL
  local before; before="$(_flag_value_for fiscal-years)"

  run node scripts/cutover-flip-flag.mjs --domain fiscal-years --to native --dry-run
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "\[cutover\] DRY-RUN"
  echo "$output" | grep -q "BEGIN;"
  echo "$output" | grep -q "jsonb_set"
  echo "$output" | grep -q "COMMIT;"
  echo "$output" | grep -q "\[cutover\] DRY-RUN — no DB writes performed."

  local after; after="$(_flag_value_for fiscal-years)"
  [ "$before" = "$after" ]
  [ "$after" = "false" ]
}

# ─────────────────────────────────────────────────────────────────
# Test 3 — idempotent: second consecutive flip is a no-op exit 0
# ─────────────────────────────────────────────────────────────────
@test "idempotent: re-running the happy path is a no-op exit 0 with 'no-op' message" {
  # First flip: set to native (this run is allowed to be either a real
  # write or a no-op depending on prior state — we only require exit 0).
  run node scripts/cutover-flip-flag.mjs --domain fiscal-years --to native
  [ "$status" -eq 0 ]

  # Second flip with the same target: must be the no-op branch.
  run node scripts/cutover-flip-flag.mjs --domain fiscal-years --to native
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "\[cutover\] no-op: finance.feature_flags.fiscal-years already at native (true)"
  [ "$(_flag_value_for fiscal-years)" = "true" ]
}

# ─────────────────────────────────────────────────────────────────
# Test 4 — rollback: native → stufis restores the row
# ─────────────────────────────────────────────────────────────────
@test "rollback: --to stufis after a native flip restores the row to false" {
  run node scripts/cutover-flip-flag.mjs --domain fiscal-years --to native
  [ "$status" -eq 0 ]
  [ "$(_flag_value_for fiscal-years)" = "true" ]

  run node scripts/cutover-flip-flag.mjs --domain fiscal-years --to stufis
  [ "$status" -eq 0 ]
  [ "$(_flag_value_for fiscal-years)" = "false" ]
}

# ─────────────────────────────────────────────────────────────────
# Test 5 — bad input: unknown domain / unknown --to / missing flag
# ─────────────────────────────────────────────────────────────────
@test "bad input: unknown --domain exits 2" {
  run node scripts/cutover-flip-flag.mjs --domain not-a-real-domain --to native
  [ "$status" -eq 2 ]
  echo "$output" | grep -qi "unknown --domain"
}

@test "bad input: garbage --to exits 2" {
  run node scripts/cutover-flip-flag.mjs --domain fiscal-years --to garbage
  [ "$status" -eq 2 ]
  echo "$output" | grep -qi "invalid --to"
}

@test "bad input: missing --domain exits 2" {
  run node scripts/cutover-flip-flag.mjs --to native
  [ "$status" -eq 2 ]
  echo "$output" | grep -qi "domain is required"
}

@test "bad input: missing --to exits 2" {
  run node scripts/cutover-flip-flag.mjs --domain fiscal-years
  [ "$status" -eq 2 ]
  echo "$output" | grep -qi "to is required"
}

@test "bad input: --all and --domain together exits 2" {
  run node scripts/cutover-flip-flag.mjs --all --domain fiscal-years --to native
  [ "$status" -eq 2 ]
  echo "$output" | grep -qi "mutually exclusive"
}

# ─────────────────────────────────────────────────────────────────
# --all: decommission fast-path (no-user-data) — flips every
# FinanceDomain in a single transaction.
# ─────────────────────────────────────────────────────────────────
@test "all: --all --to native sets every FinanceDomain to true atomically" {
  # Seed every domain to false so the run exercises 9 writes, not
  # 9 no-ops.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 >/dev/null <<SQL
    INSERT INTO config_store (key, value)
      VALUES ('finance.feature_flags', jsonb_build_object(
        'fiscal-years', false,
        'sub-orgs',     false,
        'budget',       false,
        'projects',     false,
        'expenses',     false,
        'bookkeeping',  false,
        'banking',      false,
        'approvals',    false,
        'yearend',      false
      ))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
SQL

  run node scripts/cutover-flip-flag.mjs --all --to native
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "\[cutover\] committed: finance.feature_flags.fiscal-years = native (true)"
  echo "$output" | grep -q "\[cutover\] committed: finance.feature_flags.yearend = native (true)"
  echo "$output" | grep -q "\[cutover\] config_store row after run:"
  for d in fiscal-years sub-orgs budget projects expenses bookkeeping banking approvals yearend; do
    [ "$(_flag_value_for $d)" = "true" ]
  done
}

@test "all: --all --dry-run prints SQL plan for every domain and exits 0 without writing" {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 >/dev/null <<SQL
    INSERT INTO config_store (key, value)
      VALUES ('finance.feature_flags', jsonb_build_object('fiscal-years', false))
    ON CONFLICT (key) DO UPDATE
      SET value = jsonb_set(config_store.value, ARRAY['fiscal-years'], 'false'::jsonb);
SQL
  local before; before="$(_flag_value_for fiscal-years)"

  run node scripts/cutover-flip-flag.mjs --all --to native --dry-run
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "\[cutover\] DRY-RUN --all"
  echo "$output" | grep -q "# fiscal-years"
  echo "$output" | grep -q "# yearend"
  echo "$output" | grep -q "\[cutover\] DRY-RUN — no DB writes performed."

  local after; after="$(_flag_value_for fiscal-years)"
  [ "$before" = "$after" ]
  [ "$after" = "false" ]
}

@test "all: --all is idempotent - second run of same target exits 0 with all 'no-op' lines" {
  run node scripts/cutover-flip-flag.mjs --all --to native
  [ "$status" -eq 0 ]

  run node scripts/cutover-flip-flag.mjs --all --to native
  [ "$status" -eq 0 ]
  for d in fiscal-years sub-orgs budget projects expenses bookkeeping banking approvals yearend; do
    echo "$output" | grep -q "\[cutover\] no-op: finance.feature_flags.${d} already at native (true)"
    [ "$(_flag_value_for $d)" = "true" ]
  done
  ! echo "$output" | grep -q "\[cutover\] committed"
}

# ─────────────────────────────────────────────────────────────────
# Test 6 — atomicity: a mid-transaction error leaves no partial write.
#
# The CLI itself can't easily be made to throw mid-transaction from
# outside, so we exercise atomicity via an injected SQL constraint
# violation: temporarily install a BEFORE UPDATE trigger on
# config_store that fires INSIDE the CLI's transaction and raises.
# When the trigger raises, sql.begin() rolls back the UPSERT — we then
# assert config_store still holds the pre-test row.
# ─────────────────────────────────────────────────────────────────
@test "atomicity: a mid-transaction error rolls back the UPSERT (no partial write)" {
  # 1. Seed a known starting state.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 >/dev/null <<SQL
    INSERT INTO config_store (key, value)
      VALUES ('finance.feature_flags', jsonb_build_object('fiscal-years', false))
    ON CONFLICT (key) DO UPDATE
      SET value = jsonb_set(config_store.value, ARRAY['fiscal-years'], 'false'::jsonb);
SQL
  local before; before="$(_flag_value_for fiscal-years)"
  [ "$before" = "false" ]

  # 2. Install a trigger that raises on every UPDATE to config_store
  #    where the new value's fiscal-years key is true. This trips
  #    INSIDE the CLI's sql.begin() block; the postgres-js driver
  #    rolls back automatically and surfaces the error.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
    CREATE OR REPLACE FUNCTION cutover_flip_flag_block_trigger()
    RETURNS trigger AS $body$
    BEGIN
      RAISE EXCEPTION 'cutover_flip_flag_block_trigger: blocking the UPDATE';
    END;
    $body$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS cutover_flip_flag_block ON config_store;
    CREATE TRIGGER cutover_flip_flag_block
      BEFORE UPDATE ON config_store
      FOR EACH ROW
      WHEN (NEW.key = 'finance.feature_flags')
      EXECUTE FUNCTION cutover_flip_flag_block_trigger();
SQL

  # 3. Attempt the flip — must fail non-zero with the rollback log.
  run node scripts/cutover-flip-flag.mjs --domain fiscal-years --to native
  local cli_status="$status"

  # 4. Drop the trigger immediately so the teardown's restore step
  #    isn't blocked by it.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 >/dev/null <<SQL
    DROP TRIGGER IF EXISTS cutover_flip_flag_block ON config_store;
    DROP FUNCTION IF EXISTS cutover_flip_flag_block_trigger();
SQL

  # 5. Now assert. The CLI must have exit non-zero AND the row must
  #    still reflect the pre-test state (the rollback worked).
  [ "$cli_status" -ne 0 ]
  echo "$output" | grep -qi "ROLLBACK applied"
  local after; after="$(_flag_value_for fiscal-years)"
  [ "$after" = "false" ]
}
