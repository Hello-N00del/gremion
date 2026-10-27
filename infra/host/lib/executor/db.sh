#!/usr/bin/env bash
# infra/host/lib/executor/db.sh — how the host reaches gremion_platform for
# the request queue (TASK-043d-1 D3/D6). SOURCED, NEVER EXECUTED.
#
# Through `docker exec` into the state project's postgres, over its LOCAL
# socket (the postgres:18 image's pg_hba: `local all all trust`; measured by
# packages/provisioning/test/integration/pg-roles.int.test.ts), as
#   gremion_executor   LOGIN without a password: EXECUTE on the request
#                      functions only, no table privilege (ensureExecutorRole);
#                      over TCP it cannot authenticate at all.
# The host-privileged path (docker group) is the only one that reaches it.
# SQL comes on stdin; every SMALL value is a psql variable (-v name=value, used as
# :'name' in the SQL), never interpolated into the SQL text. A value that can
# be large or that names people (a request's args: a member list, up to 1 MiB)
# is NEVER a -v: that is an argv of `docker exec` - one argument is capped at
# 128 KiB (E2BIG, so the list cap would be unreachable) and every word of it
# sits in the host's process table. It goes on STDIN inside the SQL, through
# sql_jsonb_literal.
#
# Needs: common.sh, env_key (customer-ops.sh), ROOT.

EXECUTOR_DB_ROLE="${EXECUTOR_DB_ROLE:-gremion_executor}"
PLATFORM_DB="gremion_platform"
EXECUTOR_PG_CONTAINER=""

# executor_pg_container — the ONE running postgres of <STACK>-state, by its
# compose labels (gremion-migration-dump's lookup); GREMION_EXECUTOR_PG_CONTAINER
# overrides it (a scratch proof stack).
executor_pg_container() {
    if [[ -n "$EXECUTOR_PG_CONTAINER" ]]; then printf '%s' "$EXECUTOR_PG_CONTAINER"; return 0; fi
    if [[ -n "${GREMION_EXECUTOR_PG_CONTAINER:-}" ]]; then
        EXECUTOR_PG_CONTAINER="$GREMION_EXECUTOR_PG_CONTAINER"
        printf '%s' "$EXECUTOR_PG_CONTAINER"; return 0
    fi
    local stack ids n
    stack="$(env_key "${ROOT}/etc/env/state.env" STACK)"
    [[ -n "$stack" ]] || die "STACK is empty in ${ROOT}/etc/env/state.env" "$GREMION_EXIT_USAGE"
    ids="$(docker ps -q --filter "label=com.docker.compose.project=${stack}-state" \
                       --filter "label=com.docker.compose.service=postgres")" \
        || die "docker ps failed while looking for the state postgres" "$GREMION_EXIT_ASSERT"
    n="$(grep -c . <<< "$ids" || true)"
    [[ "$n" == "1" ]] || die "expected exactly one running postgres in ${stack}-state, found ${n}" "$GREMION_EXIT_ASSERT"
    EXECUTOR_PG_CONTAINER="${ids//[[:space:]]/}"
    printf '%s' "$EXECUTOR_PG_CONTAINER"
}

# sql_jsonb_literal <json> — the JSON as a dollar-quoted jsonb SQL literal, for
# the SQL that platform_sql pipes to psql's STDIN. Inside a dollar quote psql
# does no variable interpolation and Postgres no escape processing, so any JSON
# text is safe; the tag is random and refused if the JSON happens to contain it.
sql_jsonb_literal() {
    local json="$1" tag n
    for n in 1 2 3; do
        tag="g$(openssl rand -hex 8 | tr -d '\r\n')"
        if [[ "$json" != *"\$${tag}\$"* ]]; then
            printf '$%s$%s$%s$::jsonb' "$tag" "$json" "$tag"
            return 0
        fi
    done
    die "could not pick a dollar-quote tag absent from the JSON" "$GREMION_EXIT_ASSERT"
}

# platform_sql <role> <sql> [-v name=value ...] — tuples only, unaligned,
# fields separated by '|'; any SQL error is a non-zero exit (ON_ERROR_STOP).
platform_sql() {
    local role="$1" sql="$2" c
    shift 2
    c="$(executor_pg_container)"
    printf '%s\n' "$sql" | docker exec -i "$c" psql -X -U "$role" -d "$PLATFORM_DB" -tAq -v ON_ERROR_STOP=1 "$@" -f -
}

# executor_sql <sql> [-v ...] — as the executor role.
executor_sql() {
    local sql="$1"
    shift
    platform_sql "$EXECUTOR_DB_ROLE" "$sql" "$@"
}
