#!/usr/bin/env bash
# infra/host/lib/executor/handlers/create.sh — the `create` request
# ("Neuer Mandant", FLOW-OPS-001; and "Fortsetzen" of a failed create, which
# is a NEW create request with the stored args: the engine resumes from the
# ledger). SOURCED, NEVER EXECUTED.
#
# handle_create <request-id> <slug> <operator-id> <args.json> <workdir>
#   <args.json> is request-verify's NORMALISED args (never the raw request):
#   slug, host, itAdmin, councilAdmin, bodyName, brand {product, orgShort,
#   termMonths?}, enable [], dpia {}. The tenant config the engine needs is ONLY
#   the brand identity (materialize.ts requires brand.product and
#   brand.org_short, plus the optional semester start months); it
#   is written 0600 into the request's workdir, which the executor removes
#   after the run. Then the SAME customer_create gremion-tenant create ran
#   (customer-ops.sh): phase A, the mail step, record-step, phase B, the
#   router, the TRD-440 fingerprint.
handle_create() {
    local id="$1" slug="$2" operator="$3" args="$4" work="$5"
    local cfg="${work}/tenant-config.json" dpia="${work}/dpia.json" v want_host got_host secondary why mod off='{}' pinned='[]' platform panel control
    [[ -f "$args" ]] || die "create ${id}: no verified args" "$GREMION_EXIT_ASSERT"
    jq -e --arg s "$slug" '.slug == $s' "$args" >/dev/null \
        || die "create ${id}: the verified args name another customer than ${slug}" "$GREMION_EXIT_ASSERT"
    # The customer host is bound to the install: collabora, the office and call URLs and the leaves' public base
    # URL all carry PILOT_TENANT_HOST, and a customer's host cannot be changed once it is bound. A different
    # host is refused HERE, before anything is created; an unset or placeholder value ties nothing.
    #
    # ONE exception, opt-in: SECONDARY_TENANT_HOSTS (state.env, read HERE and nowhere from the request) lists
    # further hosts, each for a core-only customer (no chat, files, office editing, video, votes: the shared
    # Synapse and Nextcloud stay bound to PILOT_TENANT_HOST). A host on that list is accepted, a malformed
    # list is refused, and for such a host only the modules of secondary_host_module_allowed may be ticked:
    # the create would enable them in phase B, before any later guard could look. The primary host is
    # judged by PILOT_TENANT_HOST alone, exactly as before, whatever the list says.
    want_host="$(env_key "${ROOT}/etc/env/state.env" PILOT_TENANT_HOST)"
    secondary="$(env_key "${ROOT}/etc/env/state.env" SECONDARY_TENANT_HOSTS)"
    if [[ -n "$want_host" && "$want_host" != CHANGE_ME_* ]]; then
        got_host="$(jq -r '.host' "$args")"
        if [[ "${got_host,,}" != "${want_host,,}" ]]; then
            [[ -n "$secondary" ]] \
                || die "create ${id}: the host ${got_host} is not this install's customer host ${want_host} (PILOT_TENANT_HOST); nothing was created. Request the create again with ${want_host}" "$GREMION_EXIT_ASSERT"
            # the control host is THE resolver's answer, as in gremion-validate-env (CONTROL_PANEL_HOST, else control.<domain>)
            platform="$(env_key "${ROOT}/etc/env/state.env" PLATFORM_DOMAIN)"
            panel="$(env_key "${ROOT}/etc/env/state.env" CONTROL_PANEL_HOST)"
            control="$(CONTROL_PANEL_HOST="$panel" PLATFORM_DOMAIN="$platform" PILOT_TENANT_HOST="$want_host" resolve_control_panel_host)" || control="$panel"
            why="$(secondary_hosts_problem "$secondary" "$platform" "$want_host" "$control")" \
                || die "create ${id}: SECONDARY_TENANT_HOSTS in state.env is malformed (${why}); nothing was created" "$GREMION_EXIT_ASSERT"
            secondary_hosts_has "$secondary" "$got_host" \
                || die "create ${id}: the host ${got_host} is not allowed here: this install's customer host is ${want_host} (PILOT_TENANT_HOST) and the secondary hosts are ${secondary} (SECONDARY_TENANT_HOSTS); nothing was created" "$GREMION_EXIT_ASSERT"
            while IFS= read -r mod; do
                secondary_host_module_allowed "$mod" \
                    || die "create ${id}: the module ${mod} cannot be enabled for a customer on the secondary host ${got_host}: it runs on the shared chat or file services, which stay bound to the customer host ${want_host}; a secondary host is core-only (${SECONDARY_HOST_MODULES// /, }); nothing was created" "$GREMION_EXIT_ASSERT"
            done < <(jq -r '(.enable // [])[]' "$args")
            # a config reads every toggleable module as ON until it says otherwise: switch the others OFF
            # record them as pinned_off_modules too: the app pins those ids false on every read and write of the
            # config, so the customer's own settings (a write, a reset to defaults) cannot switch them back on;
            # the switches alone are a value the tenant may overwrite.
            pinned="$(tr ' ' '\n' <<< "$SECONDARY_HOST_MODULES_OFF" | jq -R . | jq -sc '(.)')" \
                || die "create ${id}: could not build the pinned-off module list of the secondary-host customer; nothing was created" "$GREMION_EXIT_ASSERT"
            off="$(jq -c 'map({key: ., value: false}) | from_entries' <<< "$pinned")" \
                || die "create ${id}: could not build the module switches of the secondary-host customer; nothing was created" "$GREMION_EXIT_ASSERT"
        fi
    elif [[ -n "$secondary" ]]; then
        die "create ${id}: SECONDARY_TENANT_HOSTS is set but PILOT_TENANT_HOST is not a usable host: a secondary host is an addition to the install's customer host; nothing was created" "$GREMION_EXIT_ASSERT"
    fi
    # brand.termMonths (the two semester start months, optional: an older stored request has none) becomes
    # brand.term_months, the key the app computes its semester label from; the label itself is never written.
    jq -c --argjson off "$off" --argjson pinned "$pinned" '{brand: ({product: .brand.product, org_short: .brand.orgShort}
                    + (if .brand.termMonths then {term_months: {winter: .brand.termMonths.winter, summer: .brand.termMonths.summer}} else {} end)),
            modules: $off}
            + (if ($pinned | length) > 0 then {pinned_off_modules: $pinned} else {} end)' "$args" | atomic_write "$cfg" 600 \
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
