#!/usr/bin/env bash
#
# Fresh init on an EMPTY Postgres: apply the whole kernel chain the way
# db.ts:180-205 does (readdir, sort, skip seeds, skip disabled modules) and
# assert the RESULT in the database — tables, a column, a CHECK definition and
# the anonymous portal's grants — never the psql exit code.
#
# Every module is OFF here by construction: the kernel tree registers only
# core + governance (manifests/index.generated.ts:14-17), both toggleable:false,
# so nothing is skipped and the applied set IS the kernel block. That is the
# "each module OFF" case the calendar/elections/board assertions below name.
#
# Hooks for the negative proofs (task .9), not for normal runs:
#   FRESH_INIT_PROOF_OMIT=<basename>  do not apply that file
#   FRESH_INIT_PROOF_NO_ROLE=1        do not create gremion_public_reader
#
# Watched RED 2026-09-17 by a fresh verifier: OMIT=055 aborted 058 with
# "the anonymous public portal reads table(s) that do not exist:
# resolution_challenges"; NO_ROLE=1 aborted with "role gremion_public_reader
# does not exist"; MIN_APPLIED=99 failed the vacuity floor with
# "FAIL vacuity: applied 28 data-plane files, minimum 99". None printed
# "all post-conditions hold"; the first two exit 3 (psql's own code under
# set -e), the third exits 1.
#
# Re-measured 2026-09-17 on postgres:18-alpine, the major the product ships
# (it ran on 16 until then, i.e. it asserted of 18 what it measured on 16):
# 28 data-plane + 4 control files applied and all 26 in-database
# post-conditions held, ending "all post-conditions hold".
#
# Re-measured 2026-09-25 (TASK-054, R-E13): the six-table grant loop above was
# replaced by an exact-set assertion, two explicit negatives and a live
# permission-denied probe (see the "anonymous portal holds SELECT on EXACTLY
# what it reads" block below). Watched FAIL in a scratch copy with 058 restored
# (`git show`) to fa99132, "058 as merged" — B4a merged, R-E13 not yet applied,
# six-table grant set with no revoke of calendar_events/event_recurrence/
# protocol_resolutions/resolution_challenges:
#   FAIL gremion_public_reader's grantable relations are exactly
#   org_units,protocols: expected 'org_units,protocols', got
#   'calendar_events,event_recurrence,org_units,protocol_resolutions,protocols,
#   resolution_challenges'
#   FAIL gremion_public_reader has no SELECT on resolution_challenges:
#   expected 'f', got 't'
#   FAIL gremion_public_reader has no SELECT on calendar_events: expected 'f',
#   got 't'
#   FAIL live probe: expected 'permission denied' reading resolution_challenges
#   as gremion_public_reader, got: (empty — the SELECT succeeded and returned
#   no rows)
#   [fresh-init] FAILED, exit 1
# After the fix: 28 data-plane + 4 control files applied, 24 in-database
# post-conditions held, ending "all post-conditions hold".
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${FRESH_INIT_PROOF_PORT:-15433}"
# The major the product SHIPS: scripts/check-postgres-major.mjs exports
# POSTGRES_IMAGE_TAG and docs/ops/postgres-major.md records why. A proof that
# applies the chain on another major asserts of 18 what it measured on 16.
# Kept as its own assignment rather than inline in the expansion: the pin
# guard reads a `${VAR:-postgres:...}` default too (that gap is what let this
# file sit on 16 for a whole unit), but a plain literal is the form every net
# sees and the form a reader greps for.
DEFAULT_IMAGE="postgres:18-alpine"
IMAGE="${FRESH_INIT_PROOF_IMAGE:-$DEFAULT_IMAGE}"
NAME="gremion-fresh-init-$$"
OMIT="${FRESH_INIT_PROOF_OMIT:-}"
MIN_APPLIED="${FRESH_INIT_PROOF_MIN_APPLIED:-28}"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if docker ps --format '{{.Ports}}' | grep -q ":${PORT}->"; then
  echo "[fresh-init] port ${PORT} is held by another container; set FRESH_INIT_PROOF_PORT" >&2
  exit 1
fi

docker run -d --name "$NAME" -e POSTGRES_PASSWORD=proof -p "127.0.0.1:${PORT}:5432" "$IMAGE" >/dev/null
echo "[fresh-init] waiting for postgres on ${PORT}..."
timeout 90 bash -c "until docker exec $NAME pg_isready -U postgres >/dev/null 2>&1; do sleep 2; done"

PSQL=(docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -X -q)
# ON_ERROR_STOP here too: without it a broken assertion QUERY returns the empty
# string and the post-condition below reports a value mismatch -- true, but it
# names the symptom instead of the SQL error that caused it.
q() { docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -X -tAq -d "$1" -c "$2"; }

"${PSQL[@]}" -d postgres <<'SQL'
CREATE DATABASE gremion;
CREATE DATABASE control;
SQL
if [ "${FRESH_INIT_PROOF_NO_ROLE:-}" != "1" ]; then
  # Mirrors docker/postgres/init-databases.sh:71-87.
  "${PSQL[@]}" -d postgres -c "CREATE ROLE gremion_public_reader LOGIN PASSWORD 'proof'"
fi

applied=0
for f in $(ls "$ROOT/migrations"/*.sql | sort); do
  base="$(basename "$f")"
  case "$base" in *_seed.sql) continue ;; esac          # GREMION_DISABLE_SEEDS
  [ "$base" = "$OMIT" ] && { echo "[fresh-init] omitted $base"; continue; }
  echo "[fresh-init] applying $base"
  "${PSQL[@]}" -d gremion -f - < "$f"
  applied=$((applied + 1))
done

control_applied=0
for f in $(ls "$ROOT/migrations-control"/*.sql | sort); do
  echo "[fresh-init] applying control $(basename "$f")"
  "${PSQL[@]}" -d control -f - < "$f"
  control_applied=$((control_applied + 1))
done

fail=0
say() { echo "  $1"; }
expect_eq() { if [ "$2" != "$3" ]; then echo "FAIL $1: expected '$3', got '$2'"; fail=1; else say "ok $1"; fi; }

# -- vacuity: a run that applied almost nothing must not report success --------
if [ "$applied" -lt "$MIN_APPLIED" ]; then
  echo "FAIL vacuity: applied $applied data-plane files, minimum $MIN_APPLIED"; fail=1
else say "ok applied $applied data-plane files"; fi
expect_eq "control files applied" "$control_applied" "4"

# -- the three cross-cutting module tables, each module OFF -------------------
# `deck_board` is the board module's KEY in CROSS_CUTTING_MIGRATIONS, not a
# relation: 034_deck_board.sql:8,16,23 creates `board`, `stack` and `card`.
# Measured against a real Postgres — asserting to_regclass('deck_board') failed
# here, which is the whole point of proving this in the database.
for t in calendar_events committee_elections board stack card \
         resolution_challenges org_unit_event_outbox notification_read_marker \
         event_recurrence org_units protocols protocol_resolutions; do
  expect_eq "table $t exists" \
    "$(q gremion "SELECT to_regclass('public.$t') IS NOT NULL")" "t"
done

# -- 054's column and 056's widened CHECK -------------------------------------
expect_eq "protocol_resolutions.adoption_mode exists" \
  "$(q gremion "SELECT count(*) FROM information_schema.columns WHERE table_name='protocol_resolutions' AND column_name='adoption_mode'")" "1"
expect_eq "role_assignment_history CHECK admits 'recalled'" \
  "$(q gremion "SELECT pg_get_constraintdef(oid) LIKE '%recalled%' FROM pg_constraint WHERE conname='role_assignment_history_ended_reason_check'")" "t"

# -- the anonymous portal holds SELECT on EXACTLY what it reads (058, R-E13) ---
# Exact-set, not per-table: has_table_privilege over every relation in `public`
# in one query, so a table this migration forgot to REVOKE cannot hide behind
# a check that only ever asks about tables it expects to find.
expect_eq "gremion_public_reader's grantable relations are exactly org_units,protocols" \
  "$(q gremion "SELECT string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p') AND has_table_privilege('gremion_public_reader', c.oid, 'SELECT')")" \
  "org_units,protocols"
expect_eq "gremion_public_reader has no SELECT on resolution_challenges" \
  "$(q gremion "SELECT has_table_privilege('gremion_public_reader', 'resolution_challenges', 'SELECT')")" "f"
expect_eq "gremion_public_reader has no SELECT on calendar_events" \
  "$(q gremion "SELECT has_table_privilege('gremion_public_reader', 'calendar_events', 'SELECT')")" "f"
expect_eq "the pre-existing two revoked tables stay revoked" \
  "$(q gremion "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='gremion_public_reader' AND table_name IN ('protocol_attendance','protocol_action_items')")" "0"

# Live probe, not just a catalog check: SET ROLE and run the SELECT the
# catalog above says must fail. This cannot go through `q` (ON_ERROR_STOP=1 +
# `set -euo pipefail` would kill the script on the very failure this probe
# expects), so it runs its own psql call with the exit code discarded and the
# combined stdout+stderr inspected for Postgres's own denial text instead.
probe_out="$(docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -X -tAq -d gremion \
  -c "SET ROLE gremion_public_reader; SELECT 1 FROM resolution_challenges LIMIT 1;" 2>&1 || true)"
if echo "$probe_out" | grep -q 'permission denied'; then
  say "ok live probe: gremion_public_reader SELECT on resolution_challenges -> permission denied"
else
  echo "FAIL live probe: expected 'permission denied' reading resolution_challenges as gremion_public_reader, got: $probe_out"
  fail=1
fi

# -- control 004 ---------------------------------------------------------------
expect_eq "control tenant_domain exists" \
  "$(q control "SELECT to_regclass('public.tenant_domain') IS NOT NULL")" "t"
expect_eq "tenant_domain_one_primary index exists" \
  "$(q control "SELECT count(*) FROM pg_indexes WHERE indexname='tenant_domain_one_primary'")" "1"
# Spec B §T.1: the issuer-derived seed is gone, so a fresh control DB has the
# table and NO rows in it. Zero-tenant boot, asserted in the database.
expect_eq "tenant_domain seeds no row on a fresh control DB" \
  "$(q control "SELECT count(*) FROM tenant_domain")" "0"

if [ "$fail" -ne 0 ]; then echo "[fresh-init] FAILED"; exit 1; fi
echo "[fresh-init] all post-conditions hold"
