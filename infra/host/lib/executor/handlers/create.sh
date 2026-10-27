#!/usr/bin/env bash
# infra/host/lib/executor/handlers/create.sh — the `create` request
# ("Neuer Mandant", FLOW-OPS-001; and "Fortsetzen" of a failed create, which
# is a NEW create request with the stored args: the engine resumes from the
# ledger). SOURCED, NEVER EXECUTED.
#
# handle_create <request-id> <slug> <operator-id> <args.json> <workdir>
#   <args.json> is request-verify's NORMALISED args (never the raw request):
#   slug, host, itAdmin, councilAdmin, bodyName, brand {product, orgShort},
#   enable [], dpia {}. The tenant config the engine needs is ONLY the brand
#   identity (materialize.ts requires brand.product and brand.org_short); it
#   is written 0600 into the request's workdir, which the executor removes
#   after the run. Then the SAME customer_create gremion-tenant create ran
#   (customer-ops.sh): phase A, the mail step, record-step, phase B, the
#   router, the TRD-440 fingerprint.
handle_create() {
    local id="$1" slug="$2" operator="$3" args="$4" work="$5"
    local cfg="${work}/tenant-config.json" dpia="${work}/dpia.json" v
    [[ -f "$args" ]] || die "create ${id}: no verified args" "$GREMION_EXIT_ASSERT"
    jq -e --arg s "$slug" '.slug == $s' "$args" >/dev/null \
        || die "create ${id}: the verified args name another customer than ${slug}" "$GREMION_EXIT_ASSERT"
    jq -c '{brand: {product: .brand.product, org_short: .brand.orgShort}, modules: {}}' "$args" | atomic_write "$cfg" 600 \
        || die "create ${id}: could not write the tenant config" "$GREMION_EXIT_ASSERT"
    local -a argv=("$slug"
        --host "$(jq -r '.host' "$args")"
        --config "$cfg"
        --it-admin "$(jq -r '.itAdmin' "$args")"
        --council-admin "$(jq -r '.councilAdmin' "$args")"
        --operator "$operator")
    v="$(jq -r '.enable | join(",")' "$args")"
    [[ -z "$v" ]] || argv+=(--enable "$v")
    v="$(jq -r '.bodyName // empty' "$args")"
    [[ -z "$v" ]] || argv+=(--body-name "$v")
    if jq -e '(.dpia // {}) | length > 0' "$args" >/dev/null; then
        jq -c '.dpia' "$args" | atomic_write "$dpia" 600 \
            || die "create ${id}: could not write the DPIA decisions" "$GREMION_EXIT_ASSERT"
        argv+=(--dpia-json "$dpia")
    fi
    customer_create "${argv[@]}"
}
