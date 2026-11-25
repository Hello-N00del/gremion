#!/usr/bin/env bats
# The document editor (Collabora) posts its messages (save, close, UI_Close) to the origin Nextcloud
# recorded when it minted the WOPI token. docker/nextcloud/hooks/before-starting/pin-editor-origin.sh
# makes the customer host a trusted domain and removes a stale overwritehost / overwriteprotocol pin
# (either would hide the host gremion-ui forwards), on every container start. These tests run the real
# hook against a stateful stand-in for occ, so no Nextcloud container is needed. That Nextcloud really
# stores the forwarded host as the editor's PostMessageOrigin is checked on the running system after deploy.

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
HOOK="$REPO_ROOT/docker/nextcloud/hooks/before-starting/pin-editor-origin.sh"
COMPOSE="$REPO_ROOT/docker-compose.yml"

setup() {
    export OCC_STATE="$BATS_TEST_TMPDIR/state"
    mkdir -p "$OCC_STATE"
    export OCC="$BATS_TEST_TMPDIR/occ"
    cat >"$OCC" <<'EOF'
#!/bin/sh
# Stateful occ stand-in: config:system:get|set|delete over one file per key (and index).
f() { if [ -n "${2:-}" ] && [ "${2#--}" = "$2" ]; then echo "$OCC_STATE/$1.$2"; else echo "$OCC_STATE/$1"; fi; }
case "$1" in
  status) echo "  - installed: true" ;;
  config:system:get)
    if [ "$2" = trusted_domains ] && [ -z "${3:-}" ]; then
      for t in "$OCC_STATE"/trusted_domains.*; do [ -f "$t" ] && { cat "$t"; echo; }; done
      exit 0
    fi
    [ -f "$(f "$2" "${3:-}")" ] && cat "$(f "$2" "${3:-}")" || exit 1 ;;
  config:system:set)
    key="$2"; idx=""
    case "$3" in --value=*) ;; *) idx="$3" ;; esac
    for a in "$@"; do case "$a" in --value=*) val="${a#--value=}" ;; esac; done
    printf '%s' "$val" >"$(f "$key" "$idx")" ;;
  config:system:delete) rm -f "$(f "$2" "")" ;;
  *) exit 1 ;;
esac
EOF
    chmod +x "$OCC"
    printf 'localhost' >"$OCC_STATE/trusted_domains.0"
    printf 'nextcloud' >"$OCC_STATE/trusted_domains.1"
    unset NEXTCLOUD_PUBLIC_HOSTS NEXTCLOUD_OVERWRITEHOST NEXTCLOUD_OVERWRITEPROTOCOL
}

trusted() {
    local f out=""
    for f in "$OCC_STATE"/trusted_domains.*; do out="$out$(cat "$f") "; done
    printf '%s' "${out% }"
}

@test "without NEXTCLOUD_PUBLIC_HOSTS the hook changes nothing" {
    printf 'nextcloud' >"$OCC_STATE/overwritehost"
    run sh "$HOOK"
    [ "$status" -eq 0 ]
    [ "$(cat "$OCC_STATE/overwritehost")" = "nextcloud" ]
    [ ! -f "$OCC_STATE/trusted_domains.2" ]
}

@test "the customer host becomes a trusted domain, once, however often the container starts" {
    export NEXTCLOUD_PUBLIC_HOSTS=rat.example.test
    run sh "$HOOK"
    [ "$status" -eq 0 ]
    [ "$(cat "$OCC_STATE/trusted_domains.2")" = "rat.example.test" ]
    run sh "$HOOK"
    [ "$status" -eq 0 ]
    [[ "$output" == *"already trusted"* ]]
    [ ! -f "$OCC_STATE/trusted_domains.3" ]
}

@test "a stale overwritehost and overwriteprotocol pin is removed: it would hide the forwarded host" {
    printf 'nextcloud' >"$OCC_STATE/overwritehost"
    printf 'http' >"$OCC_STATE/overwriteprotocol"
    printf 'http://nextcloud' >"$OCC_STATE/overwrite.cli.url"
    export NEXTCLOUD_PUBLIC_HOSTS=rat.example.test
    run sh "$HOOK"
    [ "$status" -eq 0 ]
    [ ! -f "$OCC_STATE/overwritehost" ]
    [ ! -f "$OCC_STATE/overwriteprotocol" ]
    # cron and occ have no request: their URL stays.
    [ "$(cat "$OCC_STATE/overwrite.cli.url")" = "http://nextcloud" ]
}

@test "an operator who pins the host on purpose keeps the pin, and the hook says what that costs" {
    printf 'nextcloud' >"$OCC_STATE/overwritehost"
    export NEXTCLOUD_PUBLIC_HOSTS=rat.example.test NEXTCLOUD_OVERWRITEHOST=nextcloud
    run sh "$HOOK"
    [ "$status" -eq 0 ]
    [ "$(cat "$OCC_STATE/overwritehost")" = "nextcloud" ]
    [[ "$output" == *"posts to the in-network name"* ]]
}

@test "several hosts are trusted, spaces are ignored and a malformed entry is skipped" {
    export NEXTCLOUD_PUBLIC_HOSTS="rat.example.test, rat2.example.test:8443,not a host!,"
    run sh "$HOOK"
    [ "$status" -eq 0 ]
    [ "$(trusted)" = "localhost nextcloud rat.example.test rat2.example.test:8443" ]
    [[ "$output" == *"ignoring"* ]]
}

@test "an occ that cannot read trusted_domains never gets an entry overwritten" {
    printf '%s\n' '#!/bin/sh' 'case "$1" in' \
        '  status) echo "installed: true" ;;' \
        '  config:system:get) exit 1 ;;' \
        '  config:system:set) printf "%s" "$*" >>"$OCC_STATE/writes" ;;' \
        '  *) exit 1 ;;' 'esac' >"$OCC"
    export NEXTCLOUD_PUBLIC_HOSTS=rat.example.test
    run sh "$HOOK"
    [ "$status" -eq 0 ]
    [ ! -f "$OCC_STATE/writes" ]
    [ "$(trusted)" = "localhost nextcloud" ]
}

@test "a failing occ never makes the hook fail (it must not block the container)" {
    printf '#!/bin/sh\ncase "$1" in status) echo "installed: true" ;; *) exit 1 ;; esac\n' >"$OCC"
    export NEXTCLOUD_PUBLIC_HOSTS=rat.example.test
    run sh "$HOOK"
    [ "$status" -eq 0 ]
}

@test "compose: Nextcloud pins no host and trusts the customer host" {
    block="$(awk '/^  nextcloud:/{f=1;next} f&&/^  [a-z]/{f=0} f' "$COMPOSE")"
    [ -n "$block" ]
    # An uncommented pin would win over the forwarded host.
    # (`! cmd` never fails a bats test, so the status is checked explicitly.)
    run grep -E '^[[:space:]]*NEXTCLOUD_OVERWRITE(HOST|PROTOCOL):' <<<"$block"
    [ "$status" -eq 1 ]
    # The customer host and every secondary customer host (SECONDARY_TENANT_HOSTS, empty: the customer host alone).
    run grep -E '^[[:space:]]*NEXTCLOUD_PUBLIC_HOSTS:[[:space:]]+\$\{PILOT_TENANT_HOST:-\}\$\{SECONDARY_TENANT_HOSTS:\+,\$\{SECONDARY_TENANT_HOSTS\}\}[[:space:]]*$' <<<"$block"
    [ "$status" -eq 0 ]
    # The forwarded host is honoured from a trusted proxy only: both address families of the state network.
    run grep -E '^[[:space:]]*NEXTCLOUD_TRUSTED_PROXIES:.*STATE_V4_SUBNET.*STATE_V6_SUBNET' <<<"$block"
    [ "$status" -eq 0 ]
}

# --- several customer hosts on one Nextcloud and one Collabora --------------------------------------------
# docker compose is not available in the bats runner, so the interpolation is proved in two steps. The compose
# values use only ${VAR:-x} and ${VAR:+x}, which a POSIX shell expands with the very same meaning, so the tests
# expand the value text that stands in docker-compose.yml. The fixtures under test/fixtures/multihost were written
# from `docker compose config --format json` of the same file (single-customer.env: the file as it was before the
# secondary hosts, so the unchanged single-customer rendering is a golden; two-secondary.env: PILOT_TENANT_HOST
# a.example.test, SECONDARY_TENANT_HOSTS b.example.test,c.example.test), so the shell expansion is held to what
# compose itself renders.

FIXTURES="$REPO_ROOT/test/fixtures/multihost"

# service_block <service> -- the lines of the service in docker-compose.yml
service_block() {
    awk -v s="  $1:" '$0==s{f=1;next} f&&/^  [a-z]/{f=0} f' "$COMPOSE"
}

# expand_value <text> -- the text with its ${...} expanded by a shell, from PILOT / SECONDARY (when set in the test)
expand_value() {
    env -i PATH="$PATH" ${PILOT+PILOT_TENANT_HOST="$PILOT"} ${SECONDARY+SECONDARY_TENANT_HOSTS="$SECONDARY"} \
        sh -c 'eval "printf %s \"$1\""' _ "$1"
}

# rendered_env -- the relevant environment of nextcloud and collabora as KEY=VALUE lines (the fixtures' format)
rendered_env() {
    local line key val
    while IFS= read -r line; do
        key="${line%%:*}"; key="${key//[[:space:]]/}"
        val="${line#*:}"; val="${val#"${val%%[![:space:]]*}"}"
        printf 'nextcloud.%s=%s\n' "$key" "$(expand_value "$val")"
    done < <(service_block nextcloud | grep -E '^      (NEXTCLOUD_PUBLIC_HOSTS|COLLABORA_PUBLIC_URL):')
    # collabora's environment: a list of KEY=VALUE entries (a map of KEY: value is read the same way)
    while IFS= read -r line; do
        printf 'collabora.%s\n' "$(expand_value "$line")"
    done < <(service_block collabora | awk '
        /^    environment:/ { f = 1; next }
        f && /^    [a-z]/ { f = 0 }
        f && /^      - / { sub(/^      - /, ""); print; next }
        f && /^      [A-Za-z0-9_]+:/ {
            k = $0; sub(/^ +/, "", k); sub(/:.*/, "", k)
            v = $0; sub(/^ +[A-Za-z0-9_]+: */, "", v); gsub(/^"|"$/, "", v)
            print k "=" v
        }')
}

sorted_rendered() { rendered_env | LC_ALL=C sort; }

@test "multihost compose: with SECONDARY_TENANT_HOSTS unset the rendering of both services is the single-customer golden" {
    PILOT=a.example.test
    run sorted_rendered
    [ "$status" -eq 0 ]
    [ -n "$output" ]
    [ "$output" = "$(cat "$FIXTURES/single-customer.env")" ]
}

@test "multihost compose: with SECONDARY_TENANT_HOSTS set but empty the rendering is the same golden" {
    PILOT=a.example.test SECONDARY=
    run sorted_rendered
    [ "$status" -eq 0 ]
    [ "$output" = "$(cat "$FIXTURES/single-customer.env")" ]
}

@test "multihost compose: NEXTCLOUD_PUBLIC_HOSTS equals PILOT_TENANT_HOST exactly when there are no secondary hosts" {
    PILOT=a.example.test
    run sorted_rendered
    [ "$status" -eq 0 ]
    grep -qxF 'nextcloud.NEXTCLOUD_PUBLIC_HOSTS=a.example.test' <<<"$output"
}

@test "multihost compose: NEXTCLOUD_PUBLIC_HOSTS lists the customer host and every secondary host" {
    PILOT=a.example.test SECONDARY=b.example.test,c.example.test
    run sorted_rendered
    [ "$status" -eq 0 ]
    grep -qxF 'nextcloud.NEXTCLOUD_PUBLIC_HOSTS=a.example.test,b.example.test,c.example.test' <<<"$output"
}

@test "multihost compose: the shell expansion matches what docker compose rendered for two secondary hosts" {
    PILOT=a.example.test SECONDARY=b.example.test,c.example.test
    run sorted_rendered
    [ "$status" -eq 0 ]
    [ "$output" = "$(cat "$FIXTURES/two-secondary.env")" ]
}

@test "multihost compose: Collabora gets no server_name when there are secondary hosts, so it names the host of each request" {
    PILOT=a.example.test SECONDARY=b.example.test
    run sorted_rendered
    [ "$status" -eq 0 ]
    [ "$(grep -c '^collabora\.server_name=' <<<"$output" || true)" = "0" ]
    # the WOPI host stays the one literal in-network name, and the rest of the service is unchanged
    grep -qxF 'collabora.aliasgroup1=http://nextcloud:80' <<<"$output"
    grep -qxF 'collabora.extra_params=--o:ssl.enable=false --o:ssl.termination=true --o:net.service_root=/office' <<<"$output"
}

@test "multihost compose: Collabora keeps server_name = the customer host without secondary hosts" {
    PILOT=a.example.test
    run sorted_rendered
    [ "$status" -eq 0 ]
    grep -qxF 'collabora.server_name=a.example.test' <<<"$output"
}
