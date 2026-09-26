#!/usr/bin/env bats
# The edge's env contract (TASK-022; spec A §E, TRD-039 "keys in both readers").
#
# Every ${KEY} compose interpolates for the edge -- in the traefik service
# block, in the x-required-env guard and in the traefik-acme volume entry of
# docker-compose.yml -- must be DECLARED in both of the files that feed that
# interpolation:
#
#   infra/host/templates/env/state.env.tmpl  the host (rendered state.env)
#   .env.example                             a workstation / CI (`cp` to .env)
#
# A key missing from state.env.tmpl is a host whose first `docker compose`
# verb dies in x-required-env (or, for an unguarded key, renders empty); a key
# missing from .env.example turns CI's `docker compose config` red for
# everyone. Neither is visible until someone runs compose with that file.
#
# `$${VAR}` in the traefik command is the CONTAINER's shell variable, escaped
# from compose, and is deliberately not a compose key: it is stripped before
# the scan.
#
# Run: bats test/host/edge-env.bats

load 'test_helper/host'

COMPOSE="${KERNEL_ROOT}/docker-compose.yml"
STATE_TMPL="${HOST_SRC}/templates/env/state.env.tmpl"
ENV_EXAMPLE="${KERNEL_ROOT}/.env.example"

# edge_blocks — the three regions of docker-compose.yml the edge owns: the
# top-level x-required-env block, the `traefik:` service and the `traefik-acme:`
# volume entry. Each ends at the next line of equal or lower indentation.
edge_blocks() {
    awk '
        function indent(s) { match(s, /^ */); return RLENGTH }
        /^[[:space:]]*(#|$)/ { if (on) print; next }
        on && indent($0) <= depth { on = 0 }
        /^x-required-env:/          { on = 1; depth = 0; print; next }
        /^  traefik:[[:space:]]*$/  { on = 1; depth = 2; print; next }
        /^  traefik-acme:[[:space:]]*$/ { on = 1; depth = 2; print; next }
        on { print }
    ' "$COMPOSE"
}

# compose_keys — the compose interpolation keys in stdin, one per line. `$$`
# is dropped first, so `$${VAR}` (the container's own variable) never matches.
compose_keys() {
    sed -e 's/\$\$//g' | { grep -oE '\$\{[A-Z_][A-Z0-9_]*' || true; } | sed 's/^\${//' | sort -u
}

edge_keys() {
    edge_blocks | compose_keys
}

declared_in() {
    grep -qE "^$1=" "$2"
}

@test "vacuity: the edge regions are found and name the keys the edge cannot run without" {
    [ -f "$COMPOSE" ] && [ -f "$STATE_TMPL" ] && [ -f "$ENV_EXAMPLE" ]
    run edge_keys
    [ "$status" -eq 0 ]
    # All three regions are reached: one key only the guard names indirectly,
    # one only the service names, one only the volume entry names.
    for k in EDGE_BIND_IP EDGE_BIND_IP6 ACME_CA_SERVER ACME_EMAIL TRAEFIK_CERT_RESOLVER \
             EDGE_V4_SUBNET EDGE_V6_SUBNET GREMION_ROOT STACK TRAEFIK_API_PORT INTERNALTEST_PORT; do
        grep -qx "$k" <<<"$output" || { echo "edge_keys did not find ${k}:"; echo "$output"; return 1; }
    done
}

@test "the container's own \$\${VAR} is not mistaken for a compose key" {
    run compose_keys <<<'  - x: "$${ONLY_IN_CONTAINER} ${REAL_KEY} ${OTHER:-d}"'
    [ "$status" -eq 0 ]
    [ "$output" = "$(printf 'OTHER\nREAL_KEY')" ]
}

@test "every edge key is declared in infra/host/templates/env/state.env.tmpl" {
    local k missing=()
    while IFS= read -r k; do
        declared_in "$k" "$STATE_TMPL" || missing+=("$k")
    done < <(edge_keys)
    [ "${#missing[@]}" -eq 0 ] || { echo "not declared in state.env.tmpl: ${missing[*]}"; return 1; }
}

@test "every edge key is declared in .env.example" {
    local k missing=()
    while IFS= read -r k; do
        declared_in "$k" "$ENV_EXAMPLE" || missing+=("$k")
    done < <(edge_keys)
    [ "${#missing[@]}" -eq 0 ] || { echo "not declared in .env.example: ${missing[*]}"; return 1; }
}

@test "every x-required-env key is non-empty in both files (an empty value is what the guard refuses)" {
    local k f missing=()
    while IFS= read -r k; do
        for f in "$STATE_TMPL" "$ENV_EXAMPLE"; do
            grep -qE "^${k}=.+" "$f" || missing+=("${k}@$(basename "$f")")
        done
    done < <(awk '/^x-required-env:/{on=1;next} on && /^[^ #]/{on=0} on' "$COMPOSE" \
             | grep -oE '\$\{[A-Z_][A-Z0-9_]*:\?' | sed -e 's/^\${//' -e 's/:?$//' | sort -u)
    [ "${#missing[@]}" -eq 0 ] || { echo "empty or missing: ${missing[*]}"; return 1; }
}
