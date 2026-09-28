#!/usr/bin/env bash
# Proof for the content app chain's news_posts public-reader grant (TASK-200 Q9).
#
# Applies the content app migrations to a THROWAWAY postgres:18-alpine started
# with a plain `docker run` (no compose), seeds one published, one unpublished
# and one future-dated post, and asserts — as gremion_public_reader — that the
# anonymous portal role:
#   1. can read the seven columns the portal's public-db.ts selects,
#   2. cannot read author_id,
#   3. sees only rows with published_at IS NOT NULL AND published_at <= now(),
# and — as the owning role that runs migrations — that the owner still sees
# every row. Exit 0 only when every assertion holds.
#
# Usage: news-posts-public-grant-proof.sh [--through <basename>]
#   --through 1200_content_news_posts.sql   apply only up to that file (the RED run)
# Needs: docker, GNU timeout. Binds 127.0.0.1 only; removes its container on exit.
#
# Every docker call is time-bound (PROOF_EXEC_TIMEOUT seconds per exec, default
# 120; the image start gets PROOF_RUN_TIMEOUT, default 600). A call that does
# not return — Docker Desktop for Windows can leave `docker exec -i` waiting on
# a stdin EOF it never sees — ends the proof with a named RESULT: FAIL and exit
# 3, never an open-ended wait. Execs that need no stdin get </dev/null.
set -euo pipefail

EXEC_TIMEOUT="${PROOF_EXEC_TIMEOUT:-120}"
RUN_TIMEOUT="${PROOF_RUN_TIMEOUT:-600}"
for v in "PROOF_EXEC_TIMEOUT=$EXEC_TIMEOUT" "PROOF_RUN_TIMEOUT=$RUN_TIMEOUT"; do
  case "${v#*=}" in
    '' | *[!0-9]* | 0) echo "RESULT: FAIL — ${v%%=*} must be a positive whole number of seconds, got [${v#*=}]" >&2; exit 2 ;;
  esac
done
command -v timeout >/dev/null 2>&1 || { echo "RESULT: FAIL — GNU timeout is required to bound the docker calls" >&2; exit 2; }

# fd 9 = the proof's own stderr, so a timeout is reported even from a call whose
# stderr is captured (reader/owner/log=...). A timeout inside $(...) cannot exit
# the proof itself, so it signals the main shell, which exits 3 (EXIT trap
# still removes the container).
exec 9>&2
MAIN_PID=$$
trap 'exit 3' TERM
bounded_s() { # seconds, step label, command...
  local secs="$1" label="$2" rc=0
  shift 2
  timeout -k 5 "$secs" "$@" || rc=$?
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    echo "RESULT: FAIL — $label timed out after ${secs}s (the docker call did not return)" >&9
    kill -TERM "$MAIN_PID" 2>/dev/null || true
    exit 3
  fi
  return "$rc"
}
bounded() { bounded_s "$EXEC_TIMEOUT" "$@"; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS="$HERE/../migrations"
THROUGH=""
if [ "${1:-}" = "--through" ]; then THROUGH="${2:?--through needs a migration basename}"; fi

SHA="$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo nogit)"
NAME="t200-testdb-$SHA-$$"
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
PW="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
READER_PW="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"

cleanup() { timeout -k 5 60 docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

bounded_s "$RUN_TIMEOUT" 'docker run of the pinned postgres image'   docker run -d --name "$NAME" -p "127.0.0.1:$PORT:5432" -e POSTGRES_PASSWORD="$PW" postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873 </dev/null >/dev/null
ready=0
for _ in $(seq 1 60); do
  if bounded 'pg_isready probe' docker exec "$NAME" pg_isready -U postgres -q </dev/null 2>/dev/null; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "RESULT: FAIL — postgres answered no pg_isready probe in 60 tries" >&2; exit 1; }
# pg_isready can answer during the entrypoint's temporary init server; wait for the real one.
ready=0
for _ in $(seq 1 60); do
  if bounded 'SELECT 1 probe' docker exec "$NAME" psql -U postgres -tAc 'SELECT 1' </dev/null >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "RESULT: FAIL — postgres answered no SELECT 1 probe in 60 tries" >&2; exit 1; }

su_psql() { # step label, psql args...; SQL on stdin
  local label="$1"
  shift
  bounded "$label" docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -q -U postgres "$@"
}

# Roles as the stack provisions them: an owning migrator role without
# superuser, and the read-only portal role (docker/postgres/init-databases.sh).
su_psql 'create roles and database' -d postgres <<SQL
CREATE ROLE gremion LOGIN PASSWORD '$PW' NOSUPERUSER;
CREATE ROLE gremion_public_reader LOGIN PASSWORD '$READER_PW' NOSUPERUSER;
CREATE DATABASE gremion OWNER gremion;
SQL
su_psql 'grant schema public' -d gremion -c 'GRANT ALL ON SCHEMA public TO gremion' </dev/null

applied=()
for f in "$MIGRATIONS"/*.sql; do
  base="$(basename "$f")"
  # A migration that fails must fail the proof: never pipe psql's status away.
  if ! log="$(bounded "apply $base" docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -q -U gremion -d gremion <"$f" 2>&1)"; then
    printf '%s\n' "$log" >&2
    echo "RESULT: FAIL — $base did not apply" >&2
    exit 1
  fi
  applied+=("$base")
  [ "$base" = "$THROUGH" ] && break
done
if [ -n "$THROUGH" ] && [ "${applied[${#applied[@]}-1]}" != "$THROUGH" ]; then
  echo "RESULT: FAIL — --through $THROUGH names no migration in $MIGRATIONS" >&2
  exit 2
fi
echo "applied as gremion (owner): ${applied[*]}"
# Idempotency: a replay of the applied chain, in order, must succeed and leave
# the same grant (the assertions below run after it).
for base in "${applied[@]}"; do
  if ! log="$(bounded "re-apply $base" docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -q -U gremion -d gremion <"$MIGRATIONS/$base" 2>&1)"; then
    printf '%s\n' "$log" >&2
    echo "RESULT: FAIL — $base is not idempotent" >&2
    exit 1
  fi
done
echo "re-applied ${applied[*]} in order (idempotent)"

bounded 'seed news_posts' docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -q -U gremion -d gremion <<'SQL'
INSERT INTO news_posts (title, slug, body_html, author_id, published_at) VALUES
  ('published', 'published', '<p>p</p>', 'author-1', now() - interval '1 day'),
  ('draft',     'draft',     '<p>d</p>', 'author-2', NULL),
  ('scheduled', 'scheduled', '<p>s</p>', 'author-3', now() + interval '1 day');
SQL

fail=0
# A refused query is an expected outcome here, so its exit status is captured
# in the output rather than tripping set -e.
reader() { bounded "reader query [$1]" docker exec "$NAME" psql -X -tA -U gremion_public_reader -d gremion -c "$1" </dev/null 2>&1 || true; }
owner() { bounded "owner query [$1]" docker exec "$NAME" psql -X -tA -U gremion -d gremion -c "$1" </dev/null 2>&1 || true; }
check() { # name, actual, expected
  if [ "$2" = "$3" ]; then echo "  ok   $1 -> $2"; else echo "  FAIL $1 -> got [$2], want [$3]"; fail=1; fi
}

out="$(reader 'SELECT author_id FROM news_posts ORDER BY id LIMIT 1')"
case "$out" in *"permission denied"*) got=denied ;; *) got="readable:$out" ;; esac
check 'anon SELECT author_id' "$got" denied

out="$(reader "SELECT string_agg(slug, ',' ORDER BY id) FROM news_posts")"
check 'anon rows visible (all published_at states)' "$out" published

out="$(reader 'SELECT count(*) FROM news_posts')"
check 'anon count(*)' "$out" 1

out="$(reader "SELECT id, title, slug, body_html, published_at IS NOT NULL, created_at IS NOT NULL, updated_at IS NOT NULL FROM news_posts WHERE slug = 'published'")"
check 'anon reads the seven portal columns' "$(printf '%s' "$out" | cut -d'|' -f2-)" 'published|published|<p>p</p>|t|t|t'

out="$(owner 'SELECT count(*) FROM news_posts')"
check 'owner sees every row' "$out" 3

out="$(reader "INSERT INTO news_posts (title, slug, author_id) VALUES ('x','x','x')")"
case "$out" in *"permission denied"*) got=denied ;; *) got="allowed:$out" ;; esac
check 'anon INSERT' "$got" denied

# The head migration's own effective-privilege check: with the reader reaching
# author_id through PUBLIC — which its REVOKE cannot touch — it must ABORT.
if [ -z "$THROUGH" ]; then
  head="${applied[${#applied[@]}-1]}"
  owner 'GRANT SELECT ON news_posts TO PUBLIC' >/dev/null
  if bounded "re-apply $head over a PUBLIC grant" docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -q -U gremion -d gremion <"$MIGRATIONS/$head" >/dev/null 2>&1; then
    got=applied
  else
    got=aborted
  fi
  owner 'REVOKE SELECT ON news_posts FROM PUBLIC' >/dev/null
  check "$head with a PUBLIC grant reaching author_id" "$got" aborted
fi

if [ "$fail" -ne 0 ]; then echo "RESULT: FAIL"; exit 1; fi
echo "RESULT: OK"
