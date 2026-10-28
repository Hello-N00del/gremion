#!/usr/bin/env bash
# infra/host/lib/access-log.sh -- the vendor/operator ACCESS RECORD, host side
# (TRD-092 / TRD-191 / PRD-OPS-006). SOURCED, NEVER EXECUTED.
#
# Every host tool that reaches a council's data as the vendor or an operator
# (the break-glass `gremion-tenant request`, `suspend`, `resume`,
# `reconcile --apply`) records WHO (the invoking login user), WHEN (the server's
# clock), WHAT (action and what is reached) and WHY, in gremion_platform's
# oac.access_record through oac.record_access, as the executor role over the
# state server's local socket (lib/executor/db.sh). The council administrator
# reads the rows of their own customer inside the product. The record is
# append-only and kept at least as long as the security-log window (RC-LOG-AUD);
# the host keeps no copy of its own (an audit.log on the host is local, not the
# record).
#
# FAIL CLOSED: the record is written BEFORE the access it describes, and a tool
# that cannot write it does not proceed (access_record_or_die). A recorded
# attempt that then fails is still an attempt; the record says "requested", not
# "succeeded".
#
# Executor lane: gremion-executor claims a queued request and runs the handler
# against the customer's data. Its call site is
#     access_record_or_die "$slug" executor_<kind> "<what>" "<why>"
# (the handler's request is already audited by its own row; the access record
# adds the council-visible line) and is NOT wired here, because
# infra/host/bin/gremion-executor belongs to another lane. TODO(executor lane):
# source this file next to db.sh and call it before each handler runs.
#
# Needs: common.sh (die, GREMION_EXIT_*), executor/db.sh (executor_sql), ROOT.

# access_actor -- the invoking login user (sudo-aware), lowercased, validated.
access_actor() {
    local actor
    actor="$(printf '%s' "${SUDO_USER:-$(id -un)}" | tr '[:upper:]' '[:lower:]')"
    [[ "$actor" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || return 1
    printf '%s' "$actor"
}

# access_record <slug> <action> <what> <why>
# Prints the record's id. Non-zero (and a message on stderr) when the record
# could not be written; callers that must not proceed use access_record_or_die.
#   action  short lowercase identifier ([a-z][a-z0-9_.-]{0,39}), e.g. break_glass_request
#   what    3..500 characters: what is reached
#   why     10..500 characters: the reason given by the operator
access_record() {
    local slug="$1" action="$2" what="$3" why="$4" actor id
    [[ "$slug" =~ ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ && ${#slug} -ge 3 && ${#slug} -le 30 ]] \
        || { printf 'access_record: invalid customer slug\n' >&2; return 2; }
    [[ "$action" =~ ^[a-z][a-z0-9_.-]{0,39}$ ]] || { printf 'access_record: invalid action\n' >&2; return 2; }
    [[ ${#what} -ge 3 && ${#what} -le 500 ]] || { printf 'access_record: what is 3 to 500 characters\n' >&2; return 2; }
    [[ ${#why} -ge 10 && ${#why} -le 500 ]] || { printf 'access_record: why is 10 to 500 characters\n' >&2; return 2; }
    actor="$(access_actor)" || { printf 'access_record: the invoking login user is not a plain user name\n' >&2; return 2; }
    id="$(executor_sql "SELECT oac.record_access(:'slug', :'action', :'what', :'why', :'actor', NULL);" \
            -v slug="$slug" -v action="$action" -v what="$what" -v why="$why" -v actor="$actor")" || return 1
    id="${id%%$'\n'*}"
    id="${id%$'\r'}"
    [[ "$id" =~ ^[0-9a-f-]{36}$ ]] || { printf 'access_record: gremion_platform returned no record id\n' >&2; return 1; }
    printf '%s' "$id"
}

# access_record_or_die <slug> <action> <what> <why> -- fail closed.
access_record_or_die() {
    access_record "$@" >/dev/null \
        || die "the access to ${1} could not be recorded in gremion_platform (oac.access_record); nothing was done. Record first, then act (TRD-092)" "${GREMION_EXIT_ASSERT:-1}"
}
