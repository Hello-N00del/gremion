#!/usr/bin/env bash
# infra/host/lib/executor/handlers/import_members.sh — the `import_members`
# request (TASK-031, PRD-IDN-010): a member list, validated, then applied to one
# customer. SOURCED, NEVER EXECUTED.
#
# handle_import_members <request-id> <slug> <operator-id> <args.json> <workdir>
#   <args.json> is request-verify's NORMALISED args: slug, phase
#   (validate|apply), vertical, csv, expectSha256 (apply only). The list is
#   written 0600 into the request's workdir (which the executor removes after
#   the run; the request row's copy is purged on any final state, platform
#   0010) and reaches the container on STDIN, never in an argv or an env.
#
#   validate  the container's import-validate verb; writes NOTHING. The event
#             stream carries the sha256 the operator must name at apply.
#   apply     1. import-validate again (read-only): the list must validate AND
#                be the one whose sha256 the request names; the result names
#                the customer's kernel database;
#             2. gremion-migration-dump take: ONE checked dump of that database,
#                before the first write (TASK-075 ledger);
#             3. import-apply --expect-sha256;
#             4. the SAME import-apply again: it must create nothing, create no
#                account and send no mail (idempotency, proven on the running
#                system);
#             5. discard the dump with a logged reason.
#             A failure at 3 or 4 KEEPS the dump and names the restore and
#             discard commands. A list the apply rejects before any write (a
#             role change) discards its dump, nothing having been written.
#
# E-mail addresses are never printed: the report names a row by number + name.

IMPORT_SHA_RE='^[0-9a-f]{64}$'
IMPORT_DB_RE='^t_[0-9a-f]{32}__kernel$'
IMPORT_ROW_LINES=50

migration_dump() { "${CUSTOMER_OPS_BIN}/gremion-migration-dump" "$@"; }

# import_step <name> — the executor's step marker (renews the lease), when run under it.
import_step() { if declare -F executor_step >/dev/null; then executor_step "$1"; fi; }

# import_tc <list file> <verb args...> — the container verb with the list on
# STDIN; sets IMPORT_JSON (the verb's one JSON result line) and returns the
# verb's exit code. Its stderr (log lines) goes through unchanged.
IMPORT_JSON=""
import_tc() {
    local list="$1" out rc=0; shift
    out="$(tc "$@" < "$list")" || rc=$?
    IMPORT_JSON="$(grep '^{' <<< "$out" | tail -n 1 || true)"
    return "$rc"
}

# import_report <phase> — events for IMPORT_JSON: one summary line, then the rejected rows.
import_report() {
    local phase="$1"
    jq -r --arg p "$phase" '"import \($p): status=\(.status) sha256=\(.sha256) created=\(.counts.created) linked_existing=\(.counts.linked_existing) unchanged=\(.counts.unchanged) rejected=\(.counts.rejected) accounts_created=\(.counts.accounts_created) invites_sent=\(.counts.invites_sent)"' <<< "$IMPORT_JSON"
    jq -r --argjson max "$IMPORT_ROW_LINES" '.rows[:$max][] | "  row \(.row) (\(.name)): \(.reason)"' <<< "$IMPORT_JSON"
    jq -r --argjson max "$IMPORT_ROW_LINES" 'select((.rows | length) > $max) | "  ... and \((.rows | length) - $max) more rejected rows"' <<< "$IMPORT_JSON"
    jq -r 'select(.error) | "  error: \(.error)"' <<< "$IMPORT_JSON"
}

import_field() { jq -r "$1" <<< "$IMPORT_JSON"; }

# import_keep <id> <release> <db> <why> — the dump is KEPT; names the way back.
import_keep() {
    bad "import_members ${1}: ${4}"
    bad "the pre-import dump ${2} is KEPT. Inspect: gremion-migration-dump status --release ${2}"
    bad "  restore: gremion-migration-dump restore --release ${2} --db ${3} --accept-loss-since <time>   (Keycloak accounts are not restored)"
    bad "  discard: gremion-migration-dump discard --release ${2} --reason <text>"
    exit "$GREMION_EXIT_ASSERT"
}

handle_import_members() {
    # shellcheck disable=SC2034  # the handler signature is the registry's: <id> <slug> <operator> <args> <work>
    local id="$1" slug="$2" operator="$3" args="$4" work="$5"
    local list="${work}/list.csv" phase vertical expect rel db rc status
    [[ -f "$args" ]] || die "import_members ${id}: no verified args" "$GREMION_EXIT_ASSERT"
    jq -e --arg s "$slug" '.slug == $s' "$args" >/dev/null \
        || die "import_members ${id}: the verified args name another customer than ${slug}" "$GREMION_EXIT_ASSERT"
    phase="$(jq -r '.phase' "$args")"
    vertical="$(jq -r '.vertical' "$args")"
    jq -j '.csv' "$args" | atomic_write "$list" 600 \
        || die "import_members ${id}: could not write the list" "$GREMION_EXIT_ASSERT"
    [[ -s "$list" ]] || die "import_members ${id}: the member list is empty" "$GREMION_EXIT_ASSERT"

    import_step validate
    rc=0
    import_tc "$list" import-validate "$slug" --vertical "$vertical" || rc=$?
    [[ -n "$IMPORT_JSON" ]] || die "import_members ${id}: import-validate printed no result (exit ${rc})" "$GREMION_EXIT_ASSERT"
    import_report validate
    status="$(import_field '.status')"
    if [[ "$phase" == validate ]]; then
        [[ "$rc" -eq 0 && "$status" == validated ]] \
            || die "import_members ${id}: the list does not validate; nothing was written" "$GREMION_EXIT_ASSERT"
        info "validated: name this sha256 in the apply request: $(import_field '.sha256')"
        return 0
    fi

    # ---- apply ----
    expect="$(jq -r '.expectSha256' "$args")"
    [[ "$expect" =~ $IMPORT_SHA_RE ]] || die "import_members ${id}: the apply names no sha256" "$GREMION_EXIT_ASSERT"
    [[ "$rc" -eq 0 && "$status" == validated ]] \
        || die "import_members ${id}: the list does not validate; nothing was written" "$GREMION_EXIT_ASSERT"
    [[ "$(import_field '.sha256')" == "$expect" ]] \
        || die "import_members ${id}: this list is not the one that was validated (sha256 differs); nothing was written" "$GREMION_EXIT_ASSERT"
    db="$(import_field '.database')"
    [[ "$db" =~ $IMPORT_DB_RE ]] \
        || die "import_members ${id}: the container named no customer kernel database; nothing was written" "$GREMION_EXIT_ASSERT"
    rel="import-${id:0:8}"

    import_step dump
    migration_dump take --release "$rel" --db "$db" \
        || die "import_members ${id}: the pre-import dump could not be taken; nothing was written" "$GREMION_EXIT_ASSERT"

    import_step apply
    rc=0
    import_tc "$list" import-apply "$slug" --vertical "$vertical" --expect-sha256 "$expect" || rc=$?
    if [[ -z "$IMPORT_JSON" ]]; then
        import_keep "$id" "$rel" "$db" "import-apply printed no result (exit ${rc})"
    fi
    import_report apply
    status="$(import_field '.status')"
    if [[ "$status" == rejected && "$rc" -ne 0 ]]; then
        # refused before any account or membership: nothing to restore
        migration_dump discard --release "$rel" --reason "member import rejected before any write (request ${id})" \
            || bad "the unused dump ${rel} could not be discarded: gremion-migration-dump discard --release ${rel} --reason <text>"
        die "import_members ${id}: the apply was rejected before any write" "$GREMION_EXIT_ASSERT"
    fi
    if [[ "$rc" -ne 0 || "$status" != applied ]]; then
        import_keep "$id" "$rel" "$db" "import-apply ended ${status} (exit ${rc})"
    fi

    import_step rerun
    rc=0
    import_tc "$list" import-apply "$slug" --vertical "$vertical" --expect-sha256 "$expect" || rc=$?
    [[ -n "$IMPORT_JSON" ]] || import_keep "$id" "$rel" "$db" "the idempotency rerun printed no result (exit ${rc})"
    import_report rerun
    if [[ "$rc" -ne 0 ]] || ! jq -e '.status == "applied" and .counts.created == 0 and .counts.accounts_created == 0 and .counts.invites_sent == 0 and .counts.rejected == 0' <<< "$IMPORT_JSON" >/dev/null; then
        import_keep "$id" "$rel" "$db" "the rerun was not a no-op (it must create nothing and mail nobody)"
    fi

    import_step discard
    migration_dump discard --release "$rel" --reason "member import verified: rerun created nothing (request ${id})" \
        || die "import_members ${id}: applied and verified, but the dump ${rel} could not be discarded: gremion-migration-dump discard --release ${rel} --reason <text>" "$GREMION_EXIT_ASSERT"
    ok "import applied and verified for ${slug}; the pre-import dump was discarded"
}
