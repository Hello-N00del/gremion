#!/usr/bin/env bash
# infra/host/lib/executor/registry.sh — request kind -> handler function
# (TASK-043d-1 D6, D11). SOURCED, NEVER EXECUTED.
#
# A kind runs only when it is registered here AND @gremion/provisioning's
# HANDLED_KINDS lists it (request-verify refuses it otherwise, naming the
# owner task); an unregistered kind that got past request-verify is finished
# `refused` "no handler for <kind>". A new kind is ONE handler file under
# handlers/ and ONE `register` line below (TASK-031 import_members and
# seed_vertical, TASK-044 record_dpia and import_isolation, TASK-043d-2 the
# operate kinds).

declare -gA EXECUTOR_HANDLERS=()

register() {   # <kind> <function>
    [[ "$1" =~ ^[a-z][a-z_]{1,39}$ ]] || die "registry: invalid kind '$1'" "$GREMION_EXIT_USAGE"
    declare -F "$2" >/dev/null || die "registry: handler $2 of kind $1 is not defined" "$GREMION_EXIT_USAGE"
    EXECUTOR_HANDLERS["$1"]="$2"
}

# handler_for <kind> — the registered function, or exit 1 with no output.
handler_for() {
    [[ -n "${EXECUTOR_HANDLERS[$1]:-}" ]] || return 1
    printf '%s' "${EXECUTOR_HANDLERS[$1]}"
}

EXECUTOR_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=handlers/create.sh
. "${EXECUTOR_LIB_DIR}/handlers/create.sh"

register create handle_create

# shellcheck source=handlers/import_members.sh
. "${EXECUTOR_LIB_DIR}/handlers/import_members.sh"
register import_members handle_import_members
# shellcheck source=handlers/seed_vertical.sh
. "${EXECUTOR_LIB_DIR}/handlers/seed_vertical.sh"
register seed_vertical handle_seed_vertical
