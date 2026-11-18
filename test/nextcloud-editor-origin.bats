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
    run grep -E '^[[:space:]]*NEXTCLOUD_PUBLIC_HOSTS:[[:space:]]+\$\{PILOT_TENANT_HOST' <<<"$block"
    [ "$status" -eq 0 ]
    # The forwarded host is honoured from a trusted proxy only: both address families of the state network.
    run grep -E '^[[:space:]]*NEXTCLOUD_TRUSTED_PROXIES:.*STATE_V4_SUBNET.*STATE_V6_SUBNET' <<<"$block"
    [ "$status" -eq 0 ]
}
