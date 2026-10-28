#!/usr/bin/env bash
# infra/host/lib/executor/handlers/record_dpia.sh — the `record_dpia` request
# (TRD-044, TRD-161: the written DPIA-applicability decision). SOURCED, NEVER
# EXECUTED.
#
# handle_record_dpia <request-id> <slug> <operator-id> <args.json> <workdir>
#   <args.json> is request-verify's NORMALISED args: {slug, module, requiresDpia
#   (yes|no), reasonCodes, documentRef}. The container's dpia-record verb records
#   the dated decision with reuse-identical semantics: a rerun with the same
#   decision reuses the latest row instead of minting another (idempotent).
handle_record_dpia() {
    # shellcheck disable=SC2034  # the handler signature is the registry's: <id> <slug> <operator> <args> <work>
    local id="$1" slug="$2" operator="$3" args="$4" work="$5"
    [[ -f "$args" ]] || die "record_dpia ${id}: no verified args" "$GREMION_EXIT_ASSERT"
    jq -e --arg s "$slug" '.slug == $s' "$args" >/dev/null \
        || die "record_dpia ${id}: the verified args name another customer than ${slug}" "$GREMION_EXIT_ASSERT"
    customer_record_dpia "$slug" "$(jq -r '.module' "$args")" \
        --operator "$operator" \
        --requires-dpia "$(jq -r '.requiresDpia' "$args")" \
        --reason-codes "$(jq -r '.reasonCodes | join(",")' "$args")" \
        --document-ref "$(jq -r '.documentRef' "$args")"
}
