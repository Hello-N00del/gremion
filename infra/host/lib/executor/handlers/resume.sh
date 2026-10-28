#!/usr/bin/env bash
# infra/host/lib/executor/handlers/resume.sh — the `resume` request
# (TRD-044, PRD-OPS-004: "Mandant fortsetzen"). SOURCED, NEVER EXECUTED.
#
# handle_resume <request-id> <slug> <operator-id> <args.json> <workdir>
#   <args.json> is request-verify's NORMALISED args: {slug}. The SAME
#   customer_resume gremion-tenant ran: a FRESH mail principal issued and
#   stamped first (never --rotate), then the container verb (realm enabled,
#   broker users restored, status `active` LAST), then the TRD-440 fingerprint
#   is asserted equal to the one taken before the suspend.
handle_resume() {
    # shellcheck disable=SC2034  # the handler signature is the registry's: <id> <slug> <operator> <args> <work>
    local id="$1" slug="$2" operator="$3" args="$4" work="$5"
    [[ -f "$args" ]] || die "resume ${id}: no verified args" "$GREMION_EXIT_ASSERT"
    jq -e --arg s "$slug" '.slug == $s' "$args" >/dev/null \
        || die "resume ${id}: the verified args name another customer than ${slug}" "$GREMION_EXIT_ASSERT"
    customer_resume "$slug" --operator "$operator"
}
