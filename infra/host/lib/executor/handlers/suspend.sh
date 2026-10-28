#!/usr/bin/env bash
# infra/host/lib/executor/handlers/suspend.sh — the `suspend` request
# (TRD-044, PRD-OPS-004: "Mandant sperren"). SOURCED, NEVER EXECUTED.
#
# handle_suspend <request-id> <slug> <operator-id> <args.json> <workdir>
#   <args.json> is request-verify's NORMALISED args: {slug}. The SAME
#   customer_suspend gremion-tenant ran (customer-ops.sh): the container verb
#   first (status `suspended`, realm disabled, sessions out, broker users
#   evicted), then the mail principal revoked, then the TRD-440 fingerprint
#   is asserted unchanged. The customer's data and its router file are not
#   touched: the app serves the branded 503 on a suspended customer.
handle_suspend() {
    # shellcheck disable=SC2034  # the handler signature is the registry's: <id> <slug> <operator> <args> <work>
    local id="$1" slug="$2" operator="$3" args="$4" work="$5"
    [[ -f "$args" ]] || die "suspend ${id}: no verified args" "$GREMION_EXIT_ASSERT"
    jq -e --arg s "$slug" '.slug == $s' "$args" >/dev/null \
        || die "suspend ${id}: the verified args name another customer than ${slug}" "$GREMION_EXIT_ASSERT"
    customer_suspend "$slug" --operator "$operator"
}
