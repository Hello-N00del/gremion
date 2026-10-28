#!/usr/bin/env bash
# infra/host/lib/executor/handlers/enable_module.sh — the `enable_module`
# request (TRD-044, PRD-OPS-004: "Modul aktivieren"). SOURCED, NEVER EXECUTED.
#
# handle_enable_module <request-id> <slug> <operator-id> <args.json> <workdir>
#   <args.json> is request-verify's NORMALISED args: {slug, module, dpia}.
#   `dpia` is the operator's DPIA-applicability decision ({requiresDpia,
#   reasonCodes, documentRef}) or null (then the gate demands the one already
#   recorded). It is written 0600 into the request's workdir (removed by the
#   executor after the run) and handed to the container verb as --dpia-json.
#   The SAME customer_enable_module the break-glass path runs: the container's
#   enable-module verb (deny list, loaded version, isolation pass on the release
#   tip, the decision recorded, enableModule through the gate, broker users),
#   with the TRD-440 fingerprint asserted around it. Idempotent: an enabled
#   module and an identical decision are reused.
handle_enable_module() {
    # shellcheck disable=SC2034  # the handler signature is the registry's: <id> <slug> <operator> <args> <work>
    local id="$1" slug="$2" operator="$3" args="$4" work="$5"
    local module dpia="${work}/dpia.json"
    [[ -f "$args" ]] || die "enable_module ${id}: no verified args" "$GREMION_EXIT_ASSERT"
    jq -e --arg s "$slug" '.slug == $s' "$args" >/dev/null \
        || die "enable_module ${id}: the verified args name another customer than ${slug}" "$GREMION_EXIT_ASSERT"
    module="$(jq -r '.module' "$args")"
    local -a argv=("$slug" "$module" --operator "$operator")
    if jq -e '.dpia != null' "$args" >/dev/null; then
        jq -c '.dpia' "$args" | atomic_write "$dpia" 600 \
            || die "enable_module ${id}: could not write the DPIA decision" "$GREMION_EXIT_ASSERT"
        argv+=(--dpia-json "$dpia")
    fi
    customer_enable_module "${argv[@]}"
}
