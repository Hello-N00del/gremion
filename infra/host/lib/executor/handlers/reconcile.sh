#!/usr/bin/env bash
# infra/host/lib/executor/handlers/reconcile.sh — the `reconcile` request
# (TRD-044, PRD-OPS-004: "Abgleich"). SOURCED, NEVER EXECUTED.
#
# handle_reconcile <request-id> <slug> <operator-id> <args.json> <workdir>
#   <args.json> is request-verify's NORMALISED args: {slug, apply}.
#   apply=false  the DRY RUN: gremion-ui's reconcile (provisioner reconcile.ts)
#                in the tenant-create container with --verify-only. Its report
#                lines are the request's events (every output line is one); a
#                red report fails the request, so the outcome says "drift" and
#                the operator reads the checks in the events. Writes nothing.
#   apply=true   the repair (the same customer_reconcile gremion-tenant ran): the
#                container repair, the host rotation of the mail principal when
#                the report says smtp-server is `repair: host`, then a verify-only
#                that must be green. A rerun on a green realm changes nothing.
handle_reconcile() {
    # shellcheck disable=SC2034  # the handler signature is the registry's: <id> <slug> <operator> <args> <work>
    local id="$1" slug="$2" operator="$3" args="$4" work="$5" rc=0
    [[ -f "$args" ]] || die "reconcile ${id}: no verified args" "$GREMION_EXIT_ASSERT"
    jq -e --arg s "$slug" '.slug == $s' "$args" >/dev/null \
        || die "reconcile ${id}: the verified args name another customer than ${slug}" "$GREMION_EXIT_ASSERT"
    if jq -e '.apply == true' "$args" >/dev/null; then
        customer_reconcile "$slug" --apply || rc=$?
        (( rc == 0 )) || die "reconcile --apply of ${slug}: the realm is still not green after the repair (see the report above)" "$GREMION_EXIT_ASSERT"
        ok "reconcile of ${slug} applied: the realm contract holds"
        return 0
    fi
    customer_reconcile "$slug" || rc=$?
    # exit 1 is the verify's "a check fails" (drift); anything else is a crash or a usage error
    (( rc == 0 || rc == 1 )) || die "reconcile dry-run of ${slug}: verify-only failed in the container (exit ${rc})" "$GREMION_EXIT_ASSERT"
    (( rc == 0 )) || die "reconcile dry-run of ${slug}: drift found (the checks are in the events above); nothing was changed" "$GREMION_EXIT_ASSERT"
    ok "reconcile dry-run of ${slug}: the realm is in sync, nothing to repair"
}
