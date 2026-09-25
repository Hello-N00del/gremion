#!/usr/bin/env bash
#
# INTEGRATION (Docker) — the spec B section 6 no-truncate guard, asserted from
# INSIDE a container (TASK-028 / B15 task 12).
#
# Every harness that truncates or drops refuses to start unless DATABASE_URL
# names a host whose ${STACK} differs from the production ${STACK}. The
# production stack is not knowable from inside a container, so the host env
# files carry it as GREMION_PRODUCTION_STACK (AM-B-05), next to the project's
# own GREMION_STACK. This proof starts ONE scratch container from <image> with
# <env-file>, reads both keys back out of the container with `docker exec ...
# env` -- never from the file, never from this shell -- and runs the real
# guard (gremion-ui/tests/integration/assert-safe-test-db-url.ts) inside it:
#
#   1. both keys are present and non-empty in the container;
#   2. GREMION_STACK differs from GREMION_PRODUCTION_STACK -- a stack that IS
#      production must not host a truncating harness at all (the RED case);
#   3. a URL naming postgres-<production stack> is REFUSED (skipped only when
#      the host declares `none`), and so is the unqualified host `postgres`;
#   4. an EMPTY GREMION_PRODUCTION_STACK is refused (the key has no default);
#   5. a URL naming postgres-<GREMION_STACK> is ACCEPTED -- a guard that
#      refuses everything would pass 3 and 4 and prove nothing.
#
# Only the two keys are ever printed; the env file may carry real secrets.
# The container is `docker run -d --rm`, named for this proof, and removed by
# name in the EXIT trap (`docker rm -f`). Nothing else is created or removed:
# no compose project, no volume, no network.
#
# The guard runs as TypeScript through Node's built-in type stripping, so the
# image must carry Node >= 23.6 (the gremion-ui image is node:26-alpine).
# NO_TRUNCATE_GUARD_FILE points the proof at another copy of the guard: that is
# how its own efficacy is drilled (a mutilated guard must turn it red).
#
# Usage: test/host/integration/no-truncate-proof.sh <env-file> <image>
# Exit:  0 proof green · 1 a proof failed · 2 missing precondition
set -euo pipefail

# Docker Desktop under Git Bash mangles container-side paths.
case "${OSTYPE:-}" in msys*|cygwin*) export MSYS_NO_PATHCONV=1 ;; esac

# Arguments FIRST: a missing or empty one aborts here, before any container
# exists, with the precondition exit code.
if [[ $# -ne 2 || -z "$1" || -z "$2" ]]; then
    echo "usage: no-truncate-proof.sh <env-file> <image>" >&2
    exit 2
fi
ENV_FILE="$1"
IMAGE="$2"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
GUARD="${NO_TRUNCATE_GUARD_FILE:-${ROOT}/gremion-ui/tests/integration/assert-safe-test-db-url.ts}"

command -v docker >/dev/null || { echo "precondition: docker not on PATH"; exit 2; }
[[ -f "$ENV_FILE" ]] || { echo "precondition: no env file at ${ENV_FILE}"; exit 2; }
[[ -f "$GUARD" ]] || { echo "precondition: no guard at ${GUARD}"; exit 2; }
docker image inspect "$IMAGE" >/dev/null 2>&1 \
    || { echo "precondition: image ${IMAGE} is not present locally (build it first)"; exit 2; }

FAILS=0
pass() { printf 'PROOF ok   %s\n' "$1"; }
fail() { printf 'PROOF FAIL %s\n' "$1"; FAILS=$((FAILS + 1)); }

NAME="task028-no-truncate-proof-$$"
CID=""
cleanup() {
    if [[ -n "$CID" ]]; then docker rm -f "$CID" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

# The image's own CMD would boot the app; the proof needs a process that only
# keeps the container alive for `docker exec`.
CID="$(docker run -d --rm --name "$NAME" --env-file "$ENV_FILE" \
    --entrypoint /bin/sh "$IMAGE" -c 'sleep 600')"
[[ -n "$CID" ]] || { echo "precondition: the scratch container did not start"; exit 2; }

# key_in_container <KEY> -> the value the CONTAINER holds, read with `env`.
key_in_container() {
    docker exec "$CID" env | sed -n "s/^$1=//p" | head -n1
}

PROD="$(key_in_container GREMION_PRODUCTION_STACK)"
STACK_IN="$(key_in_container GREMION_STACK)"
printf 'container: GREMION_PRODUCTION_STACK=%s GREMION_STACK=%s\n' "${PROD:-<unset>}" "${STACK_IN:-<unset>}"

# 1. both keys present
if [[ -n "$PROD" && -n "$STACK_IN" ]]; then
    pass "1 both keys are set inside the container"
else
    fail "1 GREMION_PRODUCTION_STACK and GREMION_STACK must both be set inside the container"
fi

docker cp "$GUARD" "${CID}:/tmp/no-truncate-guard.ts" >/dev/null

# guard <url> [extra docker-exec args...] -> the guard's exit status; its
# refusal text goes to $GUARD_OUT (it never contains the URL).
GUARD_OUT=""
guard() {
    local url="$1"; shift
    local rc=0
    GUARD_OUT="$(docker exec -e DATABASE_URL="$url" "$@" "$CID" node -e \
        "import('/tmp/no-truncate-guard.ts').then((m) => m.assertNonProductionDbUrl(process.env.DATABASE_URL, 'DATABASE_URL')).catch((e) => { console.error(e.message); process.exit(1) })" \
        2>&1)" || rc=$?
    return "$rc"
}

# 2. this stack is not production
if [[ -n "$PROD" && -n "$STACK_IN" && "$STACK_IN" == "$PROD" ]]; then
    fail "2 GREMION_STACK equals GREMION_PRODUCTION_STACK (${PROD}): this stack IS production; no truncating harness may run on it"
elif [[ -n "$STACK_IN" ]]; then
    pass "2 GREMION_STACK differs from GREMION_PRODUCTION_STACK"
fi

# 3. production and unqualified hosts are refused
if [[ -n "$PROD" && "$PROD" != "none" ]]; then
    if guard "postgres://proof:fake-proof-pw@postgres-${PROD}:5432/proof"; then
        fail "3a the guard ACCEPTED postgres-${PROD}, the production database"
    elif [[ "$GUARD_OUT" == *"PRODUCTION"* ]]; then
        pass "3a postgres-${PROD} is refused as production"
    else
        fail "3a postgres-${PROD} was refused, but not as production: ${GUARD_OUT}"
    fi
else
    printf 'PROOF skip 3a GREMION_PRODUCTION_STACK=%s: no production stack to point at\n' "${PROD:-<unset>}"
fi
if guard "postgres://proof:fake-proof-pw@postgres:5432/proof"; then
    fail "3b the guard ACCEPTED the unqualified host postgres"
else
    pass "3b the unqualified host postgres is refused"
fi

# 4. an empty GREMION_PRODUCTION_STACK is refused
if guard "postgres://proof:fake-proof-pw@postgres-proofother:5432/proof" -e GREMION_PRODUCTION_STACK=; then
    fail "4 the guard ran with an EMPTY GREMION_PRODUCTION_STACK"
else
    pass "4 an empty GREMION_PRODUCTION_STACK is refused"
fi

# 5. this (non-production) stack is accepted
if [[ -n "$STACK_IN" && "$STACK_IN" != "$PROD" ]]; then
    if guard "postgres://proof:fake-proof-pw@postgres-${STACK_IN}:5432/proof"; then
        pass "5 postgres-${STACK_IN} is accepted"
    else
        fail "5 the guard refused postgres-${STACK_IN}, a non-production stack: ${GUARD_OUT}"
    fi
fi

if [[ "$FAILS" -gt 0 ]]; then
    printf 'NO-TRUNCATE-PROOF: %d failure(s)\n' "$FAILS"
    exit 1
fi
printf 'NO-TRUNCATE-PROOF: ok\n'
