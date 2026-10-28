#!/usr/bin/env bats
# LOW-7: the PgBouncer auth_query function must never hand out a SUPERUSER's
# SCRAM verifier. Both definitions (docker/pgbouncer/pgbouncer-auth.sql and the
# GET_AUTH constant in packages/tenant-store/src/lifecycle/kernel.ts) are applied
# to a scratch postgres and called AS pgbouncer_auth: a normal role yields a row,
# the postgres superuser yields none.

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
# Pinned to the docker-compose.yml digest.
PG_IMAGE="${PGBOUNCER_AUTH_TEST_IMAGE:-postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873}"

setup_file() {
    command -v docker >/dev/null || skip "docker not available"
    docker info >/dev/null 2>&1 || skip "docker daemon unavailable"
    export PG_CT="pgb-auth-$$-${RANDOM}"
    docker run -d --rm --name "$PG_CT" -e POSTGRES_PASSWORD=scratch "$PG_IMAGE" >/dev/null
    local i ready=0
    for i in $(seq 1 60); do
        # the entrypoint restarts the server once after initdb: require two answers
        if docker exec "$PG_CT" psql -U postgres -tAc 'SELECT 1' >/dev/null 2>&1 \
           && sleep 1 && docker exec "$PG_CT" psql -U postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
            ready=1
            break
        fi
        sleep 1
    done
    if [ "$ready" -ne 1 ]; then
        docker logs "$PG_CT" >&2 || true
        echo "scratch postgres $PG_CT never became ready" >&2
        return 1
    fi
    docker exec -i "$PG_CT" psql -U postgres -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE ROLE pgbouncer_auth LOGIN;
CREATE ROLE app_normal LOGIN PASSWORD 'normal-pw';
ALTER ROLE postgres PASSWORD 'super-pw';
SQL
}

teardown_file() {
    [ -n "${PG_CT:-}" ] && docker rm -f "$PG_CT" >/dev/null 2>&1 || true
}

# <sql-file-on-host> -- install the function as the superuser, then query as pgbouncer_auth.
check_auth_function() {
    docker exec -i "$PG_CT" psql -U postgres -v ON_ERROR_STOP=1 -q < "$1"
    docker exec "$PG_CT" psql -U postgres -v ON_ERROR_STOP=1 -q -c \
        'GRANT USAGE ON SCHEMA pgbouncer TO pgbouncer_auth; GRANT EXECUTE ON FUNCTION pgbouncer.get_auth(text) TO pgbouncer_auth'
    run docker exec "$PG_CT" psql -U pgbouncer_auth -d postgres -tAc \
        "SELECT usename FROM pgbouncer.get_auth('app_normal')"
    [ "$status" -eq 0 ]
    [ "$output" = "app_normal" ]
    run docker exec "$PG_CT" psql -U pgbouncer_auth -d postgres -tAc \
        "SELECT count(*) FROM pgbouncer.get_auth('postgres')"
    [ "$status" -eq 0 ]
    [ "$output" = "0" ]
}

@test "LOW-7: docker/pgbouncer/pgbouncer-auth.sql returns a row for a normal role and none for a superuser" {
    check_auth_function "${REPO_ROOT}/docker/pgbouncer/pgbouncer-auth.sql"
}

@test "LOW-7: kernel.ts GET_AUTH returns a row for a normal role and none for a superuser" {
    local sql="${BATS_TEST_TMPDIR}/kernel-get-auth.sql"
    awk '/^const GET_AUTH = `/ { on=1; sub(/^const GET_AUTH = `/, "") }
         on { if (sub(/`[[:space:]]*$/, "")) { print; exit } print }' \
        "${REPO_ROOT}/packages/tenant-store/src/lifecycle/kernel.ts" > "$sql"
    grep -q 'pgbouncer.get_auth' "$sql"
    check_auth_function "$sql"
}
