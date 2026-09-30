#!/usr/bin/env bats
# R29-RETENTION-30 [D R29-I6]: no edge or identity-provider log outlives 30 days.
# Guards for the kernel half: the docker/vector scripts (collected here, because
# scripts/verify/suites/unit.mjs collects only test/*.bats and test/host/*.bats,
# so no docker/vector/test-*.sh ran under verify before), the entrypoint loop,
# the Keycloak event expirations, and the two stdout changes (Keycloak event
# lines off, Traefik's own log in a rotated file).
#
# The 60-day simulation through the real logrotate needs the built image and is
# run by hand (docker/vector/test-edge-retention-sim.sh); this file holds the
# static and fast guards. Every mutation below is applied to a scratch copy and
# must turn the bound model RED.
#
# Run: bats test/edge-log-retention.bats

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
VEC="${PROJECT_ROOT}/docker/vector"
TRAEFIK_YML="${PROJECT_ROOT}/docker/traefik/traefik.yml"
COMPOSE="${PROJECT_ROOT}/docker-compose.yml"
REALMS=("${PROJECT_ROOT}/docker/keycloak/realm-export.base.json")

# --- helpers ---------------------------------------------------------------

# scratch: a mutable copy of the vector dir and traefik.yml under BATS_TEST_TMPDIR.
scratch() {
    S="${BATS_TEST_TMPDIR}/mut"
    mkdir -p "$S/vector"
    cp "$VEC/logrotate.conf" "$VEC/entrypoint.sh" "$VEC/prune-retained.sh" "$S/vector/"
    cp "$TRAEFIK_YML" "$S/traefik.yml"
}

# bound_in_scratch: run the bound model against the scratch copy.
bound_in_scratch() {
    run env EDGE_VECTOR_DIR="$S/vector" EDGE_TRAEFIK_YML="$S/traefik.yml" bash "$VEC/test-edge-retention-bound.sh"
}

# --- K6: the docker/vector guards run under verify ---------------------------

@test "test-retained-prune.sh passes (27-day window, boundary at today-27)" {
    run bash "$VEC/test-retained-prune.sh"
    [ "$status" -eq 0 ]
    [[ "$output" == *"RESULT: PASS"* ]]
}

@test "the bound model passes: every family <= 30 d, printed table" {
    run bash "$VEC/test-edge-retention-bound.sh"
    [ "$status" -eq 0 ]
    [[ "$output" == *"RESULT: PASS"* ]]
    [[ "$output" == *"1299900"* ]]
    [[ "$output" == *"2513100"* ]]
}

# --- K1: the bound model refuses every regression ----------------------------

@test "bound model: rotate 28 + maxage 28 on security.log is refused (2599500 s > 2592000 s)" {
    scratch
    awk '/^\/logs\/processed\/security\.log \{/ { on = 1 } on && /^    (rotate|maxage) 27$/ { sub(/27/, "28") } /^\}/ { on = 0 } { print }' "$S/vector/logrotate.conf" >"$S/vector/x" && mv "$S/vector/x" "$S/vector/logrotate.conf"
    bound_in_scratch
    [ "$status" -eq 1 ]
    [[ "$output" == *"2599500"* ]]
    [[ "$output" == *"EXCEEDS B"* ]]
}

@test "bound model: retained window W = 28 is refused" {
    scratch
    sed -i 's/RETAINED_RETENTION_DAYS:-27/RETAINED_RETENTION_DAYS:-28/' "$S/vector/prune-retained.sh"
    bound_in_scratch
    [ "$status" -eq 1 ]
    [[ "$output" == *"2599500"* ]]
}

@test "bound model: rotate 27 with maxage 28 (mismatch) is refused" {
    scratch
    awk '/^\/logs\/processed\/security\.log \{/ { on = 1 } on && /^    maxage 27$/ { sub(/27/, "28") } /^\}/ { on = 0 } { print }' "$S/vector/logrotate.conf" >"$S/vector/x" && mv "$S/vector/x" "$S/vector/logrotate.conf"
    bound_in_scratch
    [ "$status" -eq 1 ]
    [[ "$output" == *"differ"* ]]
}

@test "bound model: notifempty back on the access log, the Traefik log or security.log is refused" {
    local rule
    for rule in '/logs/traefik/access.log' '/logs/traefik/traefik.log' '/logs/processed/security.log'; do
        scratch
        awk -v r="$rule {" '$0 == r { on = 1 } on && /^    ifempty$/ { print "    notifempty"; next } /^\}/ { on = 0 } { print }' "$S/vector/logrotate.conf" >"$S/vector/x" && mv "$S/vector/x" "$S/vector/logrotate.conf"
        bound_in_scratch
        [ "$status" -eq 1 ]
        [[ "$output" == *"unbounded (notifempty)"* ]]
    done
}

@test "bound model: weekly, dateext and size in a rule are each refused" {
    local d
    for d in weekly dateext 'size 100M'; do
        scratch
        awk -v add="    $d" '/^\/logs\/processed\/security\.log \{/ { print; print add; next } { print }' "$S/vector/logrotate.conf" >"$S/vector/x" && mv "$S/vector/x" "$S/vector/logrotate.conf"
        bound_in_scratch
        [ "$status" -eq 1 ]
        [[ "$output" == *"forbidden directive"* || "$output" == *"exactly one 'daily'"* ]]
    done
}

@test "bound model: the logrotate state path removed from the entrypoint is refused" {
    scratch
    sed -i 's# -s /logs/processed/.logrotate.status##' "$S/vector/entrypoint.sh"
    bound_in_scratch
    [ "$status" -eq 1 ]
    [[ "$output" == *"state file"* ]]
}

@test "bound model: the Traefik rule removed from logrotate.conf is refused" {
    scratch
    awk '$0 == "/logs/traefik/traefik.log {" { on = 1 } !on { print } on && /^\}/ { on = 0 }' "$S/vector/logrotate.conf" >"$S/vector/x" && mv "$S/vector/x" "$S/vector/logrotate.conf"
    bound_in_scratch
    [ "$status" -eq 1 ]
    [[ "$output" == *"no rule for /logs/traefik/traefik.log"* ]]
}

@test "bound model: no log.filePath in traefik.yml is refused" {
    scratch
    sed -i '/^log:/,/^[A-Za-z]/{/filePath/d}' "$S/traefik.yml"
    bound_in_scratch
    [ "$status" -eq 1 ]
    [[ "$output" == *"no log.filePath"* ]]
}

@test "bound model: the interval clamp reduced to the default is refused (86400 s interval, 2678700 s)" {
    scratch
    sed -i '/^# BEGIN interval$/,/^# END interval$/{/^# BEGIN interval$/!{/^# END interval$/!d}}' "$S/vector/entrypoint.sh"
    sed -i '/^# BEGIN interval$/a LOGROTATE_INTERVAL="${LOGROTATE_INTERVAL:-3600}"' "$S/vector/entrypoint.sh"
    bound_in_scratch
    [ "$status" -eq 1 ]
    [[ "$output" == *"2678700"* ]]
}

# --- K4: entrypoint interval clamp and failure reporting ----------------------

@test "entrypoint: LOGROTATE_INTERVAL non-integer, < 60 or > 3600 becomes 3600 with one stderr line" {
    local clamp v
    clamp="$(awk '$0 == "# BEGIN interval" { on = 1; next } $0 == "# END interval" { on = 0 } on' "$VEC/entrypoint.sh")"
    [ -n "$clamp" ]
    for v in 86400 abc 0 59 3601 -5 ' ' 99999999999999999999999; do
        LOGROTATE_INTERVAL="$v" bash -c "$clamp"$'\n''printf "%s" "$LOGROTATE_INTERVAL"' >"$BATS_TEST_TMPDIR/out" 2>"$BATS_TEST_TMPDIR/err"
        [ "$(cat "$BATS_TEST_TMPDIR/out")" = "3600" ]
        [ "$(wc -l <"$BATS_TEST_TMPDIR/err")" -eq 1 ]
    done
}

@test "entrypoint: LOGROTATE_INTERVAL 60, 900, 3600 and unset are accepted without a stderr line" {
    local clamp v
    clamp="$(awk '$0 == "# BEGIN interval" { on = 1; next } $0 == "# END interval" { on = 0 } on' "$VEC/entrypoint.sh")"
    for v in 60 900 3600; do
        LOGROTATE_INTERVAL="$v" bash -c "$clamp"$'\n''printf "%s" "$LOGROTATE_INTERVAL"' >"$BATS_TEST_TMPDIR/out" 2>"$BATS_TEST_TMPDIR/err"
        [ "$(cat "$BATS_TEST_TMPDIR/out")" = "$v" ]
        [ ! -s "$BATS_TEST_TMPDIR/err" ]
    done
    env -u LOGROTATE_INTERVAL bash -c "$clamp"$'\n''printf "%s" "$LOGROTATE_INTERVAL"' >"$BATS_TEST_TMPDIR/out" 2>"$BATS_TEST_TMPDIR/err"
    [ "$(cat "$BATS_TEST_TMPDIR/out")" = "3600" ]
    [ ! -s "$BATS_TEST_TMPDIR/err" ]
}

@test "entrypoint: logrotate runs with the state file on the processed-logs volume" {
    grep -qE 'logrotate -s /logs/processed/\.logrotate\.status /etc/logrotate\.d/vector-logs' "$VEC/entrypoint.sh"
}

@test "entrypoint: no '|| true' remains inside the rotation loop" {
    run awk '/^while true; do$/ { on = 1 } on && /\|\| true/ { n++ } /^done &$/ { on = 0 } END { print n + 0 }' "$VEC/entrypoint.sh"
    [ "$output" = "0" ]
}

@test "entrypoint: a failing logrotate and a failing prune are each reported on stderr" {
    local step stubs
    step="$(awk '$0 == "    # BEGIN rotate-step" { on = 1; next } $0 == "    # END rotate-step" { on = 0 } on' "$VEC/entrypoint.sh")"
    [ -n "$step" ]
    stubs="${BATS_TEST_TMPDIR}/stubs"
    mkdir -p "$stubs"
    printf '#!/bin/sh\nexit 1\n' >"$stubs/logrotate"
    chmod +x "$stubs/logrotate"
    # /usr/local/bin/prune-retained.sh does not exist here, so the prune step fails too.
    PATH="$stubs:$PATH" bash -c "$step" >"$BATS_TEST_TMPDIR/out" 2>"$BATS_TEST_TMPDIR/err"
    [ ! -s "$BATS_TEST_TMPDIR/out" ]
    grep -q 'entrypoint.sh: logrotate failed; logs not rotated this interval' "$BATS_TEST_TMPDIR/err"
    grep -q 'entrypoint.sh: prune-retained.sh failed; retained-\*.log not pruned this interval' "$BATS_TEST_TMPDIR/err"
}

# --- K5: Keycloak events expire inside the bound ------------------------------

@test "realm files: events on, both expirations integers with 0 < x <= 2505600, acr.loa.map kept" {
    local f
    for f in "${REALMS[@]}"; do
        run node -e '
          const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
          const bad = []
          if (r.eventsEnabled !== true) bad.push("eventsEnabled")
          if (r.adminEventsEnabled !== true) bad.push("adminEventsEnabled")
          const ev = r.eventsExpiration
          if (!Number.isInteger(ev) || ev <= 0 || ev > 2505600) bad.push("eventsExpiration=" + ev)
          const raw = r.attributes && r.attributes.adminEventsExpiration
          const ad = typeof raw === "string" && /^[0-9]+$/.test(raw) ? Number(raw) : NaN
          if (!Number.isInteger(ad) || ad <= 0 || ad > 2505600) bad.push("adminEventsExpiration=" + raw)
          if (!r.attributes || r.attributes["acr.loa.map"] !== "{\"loa1\":1,\"loa2\":2}") bad.push("acr.loa.map")
          if (bad.length) { console.log("BAD " + bad.join(",")); process.exit(1) }
          console.log("OK")
        ' "$f"
        [ "$status" -eq 0 ]
        [ "$output" = "OK" ]
    done
}

# --- K7: Keycloak event lines and Traefik's own log leave container stdout ------

@test "docker-compose.yml: the keycloak service raises the jboss-logging error level to debug" {
    run awk '/^  keycloak:$/ { on = 1; next } on && /^  [A-Za-z_-]+:/ { on = 0 } on' "$COMPOSE"
    [ "$status" -eq 0 ]
    [[ $'\n'"$output" == *$'\n      KC_SPI_EVENTS_LISTENER_JBOSS_LOGGING_ERROR_LEVEL: debug'* ]]
}

@test "traefik.yml: top-level log block writes ERROR-level JSON to /logs/traefik.log" {
    run awk '/^log:/ { on = 1; next } /^[A-Za-z]/ { on = 0 } on' "$TRAEFIK_YML"
    [ "$status" -eq 0 ]
    [[ $'\n'"$output" == *$'\n  level: ERROR'* ]]
    [[ $'\n'"$output" == *$'\n  format: json'* ]]
    [[ $'\n'"$output" == *$'\n  filePath: "/logs/traefik.log"'* ]]
}
