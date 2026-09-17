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
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${FRESH_INIT_PROOF_PORT:-15433}"
IMAGE="${FRESH_INIT_PROOF_IMAGE:-postgres:16-alpine}"
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
q() { docker exec -i "$NAME" psql -U postgres -X -tAq -d "$1" -c "$2"; }

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

# -- the anonymous portal actually has its grants (058) ------------------------
for t in calendar_events event_recurrence org_units protocols protocol_resolutions resolution_challenges; do
  expect_eq "gremion_public_reader can SELECT $t" \
    "$(q gremion "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='gremion_public_reader' AND table_name='$t' AND privilege_type='SELECT'")" "1"
done
expect_eq "the two revoked tables stay revoked" \
  "$(q gremion "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='gremion_public_reader' AND table_name IN ('protocol_attendance','protocol_action_items')")" "0"

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
