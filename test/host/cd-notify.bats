#!/usr/bin/env bats
# test/host/cd-notify.bats -- cd-notify: infra/host/lib/cd/notify.sh (the mail queue, the
# relay send, the caps, the daily digest and the optional ping of gremion-cd).
#
# Run: MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo:ro" -w /repo gremion-bats:local test/host/cd-notify.bats
#
# Every address in this file is a reserved example name. `gremion-mail` and `curl` are
# shims (test_helper/cd-notify.bash): the relay "password" is a constant that the tests
# prove reaches curl's stdin and nothing else.

load 'test_helper/host'
load 'test_helper/cd'
load 'test_helper/cd-notify'

setup() { notify_setup; }
teardown() { cd_teardown; }

SHA_A=aaaaaaaaaaaa
SHA_B=bbbbbbbbbbbb
MAIL_TO=ops@example.org

# the body fields of a queued file (everything after the blank line)
body_of() { sed -n '/^$/,$p' "$1" | sed '1d'; }

# ---------------------------------------------------------------------------
# Rendering and the allow-list
# ---------------------------------------------------------------------------

@test "render: a released mail carries its allow-listed fields as numbers and codes, in a 0600 file named by epoch and kind" {
    run nlib 'cd_notify released sha12='"$SHA_A"' prev_sha12='"$SHA_B"' tag=pilot-'"$SHA_A"' colour=blue prev_colour=green commits=3 requests=1200 fivexx=2 tenants_not_ready=0 observed_min=20 snapshot_s=45 module_s=12 reconcile_s=30 hostlock_min=41 modules_total=4 modules_upgraded=2 modules_failed=0 leaves_total=3 leaves_migrated=2 leaves_skipped=1 leaves_failed=0 dump_label=pilot-'"$SHA_A"' dump_mb=312 zz_secret=hello'
    [ "$status" -eq 0 ]
    [ "$(mail_count)" -eq 1 ]
    f="$(mail_files)"
    [[ "$f" == "${GREMION_ROOT}/data/cd/outbox/1700000000-released.eml" ]]
    [ "$(stat -c %a "$f")" = "600" ]
    grep -qx 'To: ops@example.org' "$f"
    grep -qx "Subject: \[gremion-cd\] released ${SHA_A} blue" "$f"
    grep -qx 'kind: released' "$f"
    grep -qx 'host: pilot-a' "$f"
    grep -qx 'time: 2023-11-14T22:13:20Z' "$f"
    grep -qx 'observed_min: 20' "$f"
    grep -qx 'snapshot_s: 45' "$f"
    grep -qx 'module_s: 12' "$f"
    grep -qx 'reconcile_s: 30' "$f"
    grep -qx 'hostlock_min: 41' "$f"
    grep -qx 'leaves_total: 3' "$f"
    grep -qx 'leaves_migrated: 2' "$f"
    grep -qx 'leaves_skipped: 1' "$f"
    grep -qx 'leaves_failed: 0' "$f"
    grep -qx "tag: pilot-${SHA_A}" "$f"
    # a field the kind does not list is dropped, not rendered
    refute_in "$f" zz_secret
    refute_in "$f" hello
}

@test "render: the body order is fixed whatever the argument order is" {
    run nlib 'cd_notify released colour=blue hostlock_min=9 sha12='"$SHA_A"' observed_min=20'
    [ "$status" -eq 0 ]
    run body_of "$(mail_files)"
    [ "$output" = "$(printf 'kind: released\ntime: 2023-11-14T22:13:20Z\nhost: pilot-a\nsha12: %s\ncolour: blue\nobserved_min: 20\nhostlock_min: 9' "$SHA_A")" ]
}

@test "render: a field that is not in the kind's allow-list is dropped (a held mail has no 5xx count)" {
    run nlib 'cd_notify held sha12='"$SHA_A"' hold=blocked fivexx=7 leaves_failed=1'
    [ "$status" -eq 0 ]
    f="$(mail_files)"
    grep -qx 'hold: blocked' "$f"
    refute_in "$f" fivexx
    refute_in "$f" leaves_failed
}

@test "render: PROOF mode puts [PROOF] in the subject" {
    cd_write_cfg CD_PROOF_MODE=1
    run nlib 'cd_notify proof_on sha12='"$SHA_A"
    [ "$status" -eq 0 ]
    grep -qx 'Subject: \[gremion-cd\] \[PROOF\] proof_on aaaaaaaaaaaa -' "$(mail_files)"
}

@test "render: a held mail carries the uncovered short SHAs of a range as a list of short SHAs" {
    run nlib 'cd_notify held sha12='"$SHA_A"' hold=range_unverified uncovered='"$SHA_A,$SHA_B"' command="gremion-cd release-now '"$SHA_A"' --accept-range"'
    [ "$status" -eq 0 ]
    f="$(mail_files)"
    grep -qx "uncovered: ${SHA_A},${SHA_B}" "$f"
    grep -qx "command: gremion-cd release-now ${SHA_A} --accept-range" "$f"
}

@test "render: a bad kind is refused and cd_notify still returns 0" {
    run nlib 'cd_notify not_a_kind sha12='"$SHA_A"'; echo "rc=$?"'
    [ "$status" -eq 0 ]
    [[ "$output" == *"rc=0"* ]]
    [ "$(mail_count)" -eq 0 ]
}

@test "render: no recipient (CD_ALLOW_NO_MAIL=1 and no CD_MAIL_TO) queues nothing and returns 0" {
    sed -i '/^CD_MAIL_TO=/d' "${GREMION_ROOT}/etc/cd.env"
    cd_write_cfg CD_ALLOW_NO_MAIL=1
    sed -i '/^CD_MAIL_TO=/d' "${GREMION_ROOT}/etc/cd.env"
    run nlib 'cd_notify held sha12='"$SHA_A"'; echo "rc=$?"'
    [ "$status" -eq 0 ]
    [[ "$output" == *"rc=0"* ]]
    [ "$(mail_count)" -eq 0 ]
}

# ---------------------------------------------------------------------------
# The leak test: a value shaped like an address, an IP, a URL or a path, through EVERY field
# of EVERY kind
# ---------------------------------------------------------------------------

@test "leak: an e-mail address, an IPv4, an IPv6, a URL with a host and a /home path in every field of every kind are <redacted> in the file and the mail is still queued" {
    local -a poisons=('leak@example.org' '198.51.100.23' '2001:db8::17' 'https://leak.example.org/x' '/home/deploy/secret')
    # one mail per kind and per shape; the clock moves 4000 s per mail so no cap is met
    run nlib '
        i=0
        for kind in "${!CD_NOTIFY_KIND_FIELDS[@]}"; do
            cd_notify_fields "$kind" > "${GREMION_ROOT}/.fields.${kind}"
            for p in "$@"; do
                args=()
                for f in $(cd_notify_fields "$kind"); do args+=("$f=$p"); done
                i=$((i + 1))
                printf "%s\n" $((1700000000 + i * 4000)) > "$GREMION_CD_NOW_FILE"
                cd_notify "$kind" "${args[@]}"
            done
        done
        echo "kinds=${#CD_NOTIFY_KIND_FIELDS[@]}"' "${poisons[@]}"
    [ "$status" -eq 0 ]
    local kinds="${output##*kinds=}"
    # the mail is still queued: one file per kind and shape
    [ "$(mail_count)" -eq $(( kinds * 5 )) ]
    [ "$kinds" -eq 17 ]
    local f kind fields n p
    while IFS= read -r f; do
        kind="$(sed -n 's/^kind: //p' "$f")"
        fields="${GREMION_ROOT}/.fields.${kind}"
        [ -s "$fields" ]
        # every allow-listed field is there and redacted, and nothing else is
        n=0
        while IFS= read -r fld; do
            grep -qx "${fld}: <redacted>" "$f" || { echo "no '${fld}: <redacted>' in $f" >&2; cat "$f" >&2; return 1; }
            n=$(( n + 1 ))
        done < "$fields"
        [ "$(grep -c ': <redacted>$' "$f")" -eq "$n" ]
        for p in "${poisons[@]}"; do refute_in "$f" "$p"; done
    done < <(mail_files)
}

@test "leak: a slug-shaped value in a leaf count of a rejected, a stopped and a released mail is <redacted>, a number is kept" {
    run nlib '
        cd_notify rejected sha12='"$SHA_A"' stage=migrate rule=migrate_failed leaves_failed=acme-verein leaves_skipped=2
        printf "%s\n" 1700000100 > "$GREMION_CD_NOW_FILE"
        cd_notify stopped sha12='"$SHA_A"' stage=migrate leaves_failed=3 leaves_skipped=kanzlei-nord
        printf "%s\n" 1700000200 > "$GREMION_CD_NOW_FILE"
        cd_notify released sha12='"$SHA_A"' leaves_total=3 leaves_migrated=verein leaves_failed=0'
    [ "$status" -eq 0 ]
    grep -qx 'leaves_failed: <redacted>' "${GREMION_ROOT}/data/cd/outbox/1700000000-rejected.eml"
    grep -qx 'leaves_skipped: 2' "${GREMION_ROOT}/data/cd/outbox/1700000000-rejected.eml"
    grep -qx 'leaves_failed: 3' "${GREMION_ROOT}/data/cd/outbox/1700000100-stopped.eml"
    grep -qx 'leaves_skipped: <redacted>' "${GREMION_ROOT}/data/cd/outbox/1700000100-stopped.eml"
    grep -qx 'leaves_migrated: <redacted>' "${GREMION_ROOT}/data/cd/outbox/1700000200-released.eml"
    grep -qx 'leaves_total: 3' "${GREMION_ROOT}/data/cd/outbox/1700000200-released.eml"
    grep -qx 'leaves_failed: 0' "${GREMION_ROOT}/data/cd/outbox/1700000200-released.eml"
}

@test "leak: the stage, rule, hold and detail fields accept only the program's own words (a customer-shaped token is <redacted>)" {
    run nlib 'cd_notify rejected sha12='"$SHA_A"' stage=acmeverein rule=kanzlei'
    [ "$status" -eq 0 ]
    f="$(mail_files)"
    grep -qx 'stage: <redacted>' "$f"
    grep -qx 'rule: <redacted>' "$f"
    run nlib 'cd_notify rejected sha12='"$SHA_A"' stage=build rule=build_failed'
    f2="${GREMION_ROOT}/data/cd/outbox/1700000000-rejected-2.eml"
    grep -qx 'stage: build' "$f2"
    grep -qx 'rule: build_failed' "$f2"
}

@test "leak: no address outside the reserved example names is written into any file of this unit" {
    local f hit
    for f in infra/host/lib/cd/notify.sh infra/host/lib/cd/watchdog.sh test/host/cd-notify.bats test/host/cd-watchdog.bats test/host/test_helper/cd-notify.bash; do
        hit="$(grep -oE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+' "${KERNEL_ROOT}/${f}" | grep -vE '@(example\.org|example\.com|[A-Za-z0-9.-]+\.invalid|[A-Za-z0-9.-]+\.test)$' || true)"
        if [ -n "$hit" ]; then
            echo "an address outside the reserved names in ${f}: ${hit}" >&2
            return 1
        fi
    done
}

# ---------------------------------------------------------------------------
# The relay path
# ---------------------------------------------------------------------------

@test "relay: gremion-mail is asked for relay-curl-config --to the one address --message an absolute path, and its output reaches curl -K - on stdin" {
    run nlib 'cd_notify held sha12='"$SHA_A"' hold=blocked; cd_notify_flush'
    [ "$status" -eq 0 ]
    [ "$(curl_calls)" -eq 1 ]
    grep -qE "^gremion-mail relay-curl-config --to ${MAIL_TO//./[.]} --message /[A-Za-z0-9._/@+-]+$" "$SHIM_LOG"
    grep -qE '^curl .*-K -( |$)' "$SHIM_LOG"
    grep -q "$RELAY_PW" "${GREMION_ROOT}/.curl-stdin.all"
    # the sent message has the sender of the config, the recipient and CRLF line ends
    [ "$(sent_count)" -eq 1 ]
    local sent
    sent="$(ls "${GREMION_ROOT}"/.sent.* | head -n 1)"
    grep -q $'^From: system@example.org\r$' "$sent"
    grep -q $'^To: ops@example.org\r$' "$sent"
    # and the queued file is gone
    [ "$(mail_count)" -eq 0 ]
}

@test "relay: the relay password is in curl's stdin only -- not in its argv, its environment, the outbox, the upload file, the history or any file of data/cd" {
    run nlib 'cd_notify held sha12='"$SHA_A"' hold=blocked; cd_notify_flush'
    [ "$status" -eq 0 ]
    grep -q "$RELAY_PW" "${GREMION_ROOT}/.curl-stdin.all"
    refute_in "$SHIM_LOG" "$RELAY_PW"
    local f
    for f in "${GREMION_ROOT}"/.curl-env.* "${GREMION_ROOT}"/.sent.*; do
        refute_in "$f" "$RELAY_PW"
    done
    run grep -rlF -- "$RELAY_PW" "${GREMION_ROOT}/data/cd" "${GREMION_ROOT}/runtime"
    [ "$status" -eq 1 ]
}

@test "relay: a mail goes to the one address of CD_MAIL_TO and to nobody else" {
    run nlib 'cd_notify held sha12='"$SHA_A"' hold=blocked; cd_notify_flush'
    [ "$status" -eq 0 ]
    run grep -c '^gremion-mail relay-curl-config' "$SHIM_LOG"
    [ "$output" = "1" ]
    run grep '^gremion-mail relay-curl-config' "$SHIM_LOG"
    [[ "$output" == *"--to ops@example.org "* ]]
}

@test "relay: the Stalwart transport queues the file, logs 'notify: transport not supported', sends nothing, and cd_notify_transport_ok is 1" {
    echo stalwart > "${GREMION_ROOT}/.transport"
    run nlib 'cd_notify held sha12='"$SHA_A"' hold=blocked; echo "queued"; cd_notify_flush || echo "flush=$?"'
    [ "$status" -eq 0 ]
    [[ "$output" == *"queued"* ]]
    [[ "$output" == *"notify: transport not supported"* ]]
    [[ "$output" == *"flush=2"* ]]
    [ "$(mail_count)" -eq 1 ]
    [ "$(curl_calls)" -eq 0 ]
    run nlib 'cd_notify_transport_ok'
    [ "$status" -eq 1 ]
}

@test "relay: the relay transport answers cd_notify_transport_ok 0, an unreadable transport 1" {
    run nlib 'cd_notify_transport_ok'
    [ "$status" -eq 0 ]
    echo garbage > "${GREMION_ROOT}/.transport"
    run nlib 'cd_notify_transport_ok'
    [ "$status" -eq 1 ]
}

@test "relay: a second flusher while one holds the flush lock sends nothing (exit 3), so the tick and the watchdog cannot send one file twice" {
    cd_need_flock
    cd_bg 'exec 7>>"${GREMION_ROOT}/runtime/cd/notify.lock"; flock -n 7; echo ready; exec sleep 300'
    run nlib 'cd_notify held sha12='"$SHA_A"' hold=blocked; cd_notify_flush'
    [ "$status" -eq 3 ]
    [ "$(curl_calls)" -eq 0 ]
    [ "$(mail_count)" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Retry, dedupe and the caller
# ---------------------------------------------------------------------------

@test "retry: a failed send keeps the file, the next flush sends it once, and a third flush sends nothing" {
    touch "${GREMION_ROOT}/.curl-fail"
    run nlib 'cd_notify held key=k1 sha12='"$SHA_A"' hold=blocked; cd_notify_flush'
    [ "$status" -eq 1 ]
    [ "$(mail_count)" -eq 1 ]
    [ "$(curl_calls)" -eq 1 ]
    [ "$(sent_count)" -eq 0 ]
    rm -f "${GREMION_ROOT}/.curl-fail"
    run nlib 'cd_notify_flush'
    [ "$status" -eq 0 ]
    [ "$(mail_count)" -eq 0 ]
    [ "$(curl_calls)" -eq 2 ]
    [ "$(sent_count)" -eq 1 ]
    run nlib 'cd_notify_flush'
    [ "$status" -eq 0 ]
    [ "$(curl_calls)" -eq 2 ]
    # the same kind and key is not queued again after it was sent
    run nlib 'cd_notify held key=k1 sha12='"$SHA_A"' hold=blocked; cd_notify_flush'
    [ "$status" -eq 0 ]
    [ "$(curl_calls)" -eq 2 ]
    [ "$(sent_count)" -eq 1 ]
}

@test "retry: the first failed send stops the pass (a dead relay is not asked once per file) and keeps every file" {
    touch "${GREMION_ROOT}/.curl-fail"
    run nlib 'cd_notify held sha12='"$SHA_A"' hold=blocked
        printf "%s\n" 1700000010 > "$GREMION_CD_NOW_FILE"; cd_notify held sha12='"$SHA_B"' hold=operator
        printf "%s\n" 1700000020 > "$GREMION_CD_NOW_FILE"; cd_notify killswitch phase=idle
        cd_notify_flush'
    [ "$status" -eq 1 ]
    [ "$(curl_calls)" -eq 1 ]
    [ "$(mail_count)" -eq 3 ]
}

@test "dedupe: one mail per kind and key; another key, another kind, and a key after its every= window each mail again" {
    run nlib '
        cd_notify held key=aa sha12='"$SHA_A"'
        cd_notify held key=aa sha12='"$SHA_A"'
        cd_notify held key=bb sha12='"$SHA_A"'
        cd_notify killswitch key=aa phase=idle
        printf "%s\n" 1700000200 > "$GREMION_CD_NOW_FILE"
        cd_notify held key=cc every=100 sha12='"$SHA_A"'
        printf "%s\n" 1700000250 > "$GREMION_CD_NOW_FILE"
        cd_notify held key=cc every=100 sha12='"$SHA_A"'
        printf "%s\n" 1700000301 > "$GREMION_CD_NOW_FILE"
        cd_notify held key=cc every=100 sha12='"$SHA_A"''
    [ "$status" -eq 0 ]
    # aa/held, bb/held, aa/killswitch, cc/held at 200, cc/held at 301
    [ "$(mail_count)" -eq 5 ]
}

@test "dedupe: the mark is in the notified map of the state file when this process holds the cd lock, and a second process sees it" {
    cd_need_flock
    cd_seed_state
    run nlib 'cd_lock_take; cd_notify held key=abc sha12='"$SHA_A"'; cd_notify held key=abc sha12='"$SHA_A"''
    [ "$status" -eq 0 ]
    [ "$(mail_count)" -eq 1 ]
    [ "$(jq -r '.notified["held:abc"] | type' "${GREMION_ROOT}/data/cd/state.json")" = "string" ]
    # the schema still accepts the state
    run nlib 'cd_lock_take; cd_state_load; echo state-ok'
    [ "$status" -eq 0 ]
    [[ "$output" == *state-ok* ]]
    # a process with no lock reads the same mark
    run nlib 'cd_notify held key=abc sha12='"$SHA_A"''
    [ "$status" -eq 0 ]
    [ "$(mail_count)" -eq 1 ]
    # and wrote nothing to the sidecar
    [ ! -e "${GREMION_ROOT}/data/cd/notified.marks" ]
}

@test "dedupe: without the cd lock the mark goes to the sidecar and the state file is not touched" {
    cd_seed_state
    local before
    before="$(cat "${GREMION_ROOT}/data/cd/state.json")"
    run nlib 'cd_notify held key=abc sha12='"$SHA_A"''
    [ "$status" -eq 0 ]
    [ "$(cat "${GREMION_ROOT}/data/cd/state.json")" = "$before" ]
    grep -q '^held:abc ' "${GREMION_ROOT}/data/cd/notified.marks"
    run nlib 'cd_notify held key=abc sha12='"$SHA_A"''
    [ "$(mail_count)" -eq 1 ]
}

@test "caller: cd_notify returns 0 when the send fails, when the outbox cannot be written, and when the state is unreadable under the lock; the caller carries on" {
    cd_need_flock
    touch "${GREMION_ROOT}/.curl-fail"
    printf '{' > "${GREMION_ROOT}/data/cd/state.json"
    run nlib 'cd_lock_take; cd_notify held key=zz sha12='"$SHA_A"'; echo "rc1=$?"; cd_notify_flush || true; echo "after-flush"; rm -rf "$CD_DATA/outbox"; : > "$CD_DATA/outbox"; cd_notify held sha12='"$SHA_B"'; echo "rc2=$?"'
    [ "$status" -eq 0 ]
    [[ "$output" == *"rc1=0"* ]]
    [[ "$output" == *"after-flush"* ]]
    [[ "$output" == *"rc2=0"* ]]
}

@test "caller: a cd_notify under the lock does not kill the program's heartbeat when the state is unreadable" {
    cd_need_flock
    printf '{' > "${GREMION_ROOT}/data/cd/state.json"
    # the state write of the dedupe mark runs in a subshell; its cd_die must not stop the
    # parent's real heartbeat subshell (stood in for here by a sleeping process)
    run nlib 'cd_lock_take; sleep 300 & hb=$!; CD_HB_PID=$hb; cd_notify held key=zz sha12='"$SHA_A"'; if kill -0 "$hb" 2>/dev/null; then echo hb-alive; else echo hb-killed; fi; kill "$hb" 2>/dev/null || true'
    [ "$status" -eq 0 ]
    [[ "$output" == *"hb-alive"* ]]
}

# ---------------------------------------------------------------------------
# Caps
# ---------------------------------------------------------------------------

@test "caps: the 21st mail in an hour becomes one summary mail and the rest of the hour is dropped" {
    run nlib 'for i in $(seq 1 25); do cd_notify held sha12='"$SHA_A"' hold=blocked; done'
    [ "$status" -eq 0 ]
    [ "$(mail_count)" -eq 21 ]
    [ "$(mail_files | grep -c -- '-summary')" -eq 1 ]
    f="$(mail_files | grep -- '-summary')"
    grep -qx 'mails_hour: 20' "$f"
    [ "$(mail_files | grep -c -- '-held')" -eq 20 ]
    # an hour later the cap is open again
    run nlib 'printf "%s\n" 1700003700 > "$GREMION_CD_NOW_FILE"; cd_notify held sha12='"$SHA_B"' hold=operator'
    [ "$(mail_count)" -eq 22 ]
}

@test "caps: the 61st mail in a day becomes one summary mail" {
    run nlib 'for i in $(seq 1 62); do printf "%s\n" $((1700000000 + i * 1400)) > "$GREMION_CD_NOW_FILE"; cd_notify held sha12='"$SHA_A"' hold=blocked; done'
    [ "$status" -eq 0 ]
    [ "$(mail_count)" -eq 61 ]
    [ "$(mail_files | grep -c -- '-summary')" -eq 1 ]
    grep -qx 'mails_day: 60' "$(mail_files | grep -- '-summary')"
}

# ---------------------------------------------------------------------------
# The outbox age
# ---------------------------------------------------------------------------

@test "outbox age: seconds since the oldest queued file, 0 when empty, read from the fake clock" {
    run nlib 'cd_notify_outbox_age'
    [ "$output" = "0" ]
    run nlib 'cd_notify held sha12='"$SHA_A"'; printf "%s\n" 1700001800 > "$GREMION_CD_NOW_FILE"; cd_notify held sha12='"$SHA_B"'; cd_notify_outbox_age'
    [ "$output" = "1800" ]
}

# ---------------------------------------------------------------------------
# The digest
# ---------------------------------------------------------------------------

digest_day() { date -u -d "2026-11-18 $1" +%s; }

@test "digest: nothing before CD_ALIVE_HOUR; one alive mail from that hour on; none on the second call of the day; another the next day" {
    cd_seed_state '.phase = "idle" | .live = '"$CD_LIVE_JSON"' | .poll.last_at = "2026-11-18T07:00:00Z"'
    printf '[]\n' > "${GREMION_ROOT}/data/cd/blocked.json"
    cd_fake_now "$(digest_day 07:59:00)"
    run nlib 'cd_notify_digest'
    [ "$status" -eq 0 ]
    [ "$(mail_count)" -eq 0 ]
    cd_fake_now "$(digest_day 08:05:00)"
    run nlib 'cd_notify_digest'
    [ "$status" -eq 0 ]
    [ "$(mail_count)" -eq 1 ]
    cd_fake_now "$(digest_day 12:00:00)"
    run nlib 'cd_notify_digest'
    [ "$(mail_count)" -eq 1 ]
    cd_fake_now "$(( $(digest_day 08:05:00) + 86400 ))"
    run nlib 'cd_notify_digest'
    [ "$(mail_count)" -eq 2 ]
}

@test "digest: it carries the phase, the live short SHA, the last poll age, the hold, the open blocks and the outbox age and nothing else" {
    cd_seed_state '.phase = "idle" | .live = '"$CD_LIVE_JSON"' | .poll.last_at = "2026-11-18T07:00:00Z" | .hold = {"kind":"blocked","reason":"x","sha12":"","since":"2026-11-17T00:00:00Z"}'
    printf '[{"sha":"%s","sha12":"%s","tag":"pilot-%s","at":"2026-11-17T00:00:00Z","rule":"watch_crash","detail":"x","cleared":null}]\n' \
        "$(printf 'b%.0s' $(seq 1 40))" "$SHA_B" "$SHA_B" > "${GREMION_ROOT}/data/cd/blocked.json"
    cd_fake_now "$(digest_day 08:30:00)"
    run nlib 'cd_notify_digest'
    [ "$status" -eq 0 ]
    f="$(mail_files)"
    grep -qx 'Subject: \[gremion-cd\] alive aaaaaaaaaaaa -' "$f"
    run body_of "$f"
    [ "$output" = "$(printf 'kind: alive\ntime: 2026-11-18T08:30:00Z\nhost: pilot-a\nphase: idle\nsha12: aaaaaaaaaaaa\nhold: blocked\npoll_age_min: 90\noutbox_age_min: 0\nblocks: 1')" ]
}

@test "digest: a damaged state still gives a digest (phase unknown)" {
    printf '{' > "${GREMION_ROOT}/data/cd/state.json"
    cd_fake_now "$(digest_day 09:00:00)"
    run nlib 'cd_notify_digest'
    [ "$status" -eq 0 ]
    grep -qx 'phase: unknown' "$(mail_files)"
}

# ---------------------------------------------------------------------------
# The ping
# ---------------------------------------------------------------------------

@test "ping: curl -K - gets the URL on stdin only -- not in argv, not in the environment, never printed or logged" {
    cd_write_cfg CD_PING_URL=https://ping.example.org/hook-TOKEN-9921
    run nlib 'cd_ping'
    [ "$status" -eq 0 ]
    [ -z "$output" ]
    [ "$(curl_calls)" -eq 1 ]
    grep -qE '^curl .*-K -( |$)' "$SHIM_LOG"
    refute_in "$SHIM_LOG" TOKEN-9921
    refute_in "$SHIM_LOG" ping.example.org
    local f
    for f in "${GREMION_ROOT}"/.curl-env.*; do
        refute_in "$f" TOKEN-9921
    done
    grep -qF 'url = "https://ping.example.org/hook-TOKEN-9921"' "${GREMION_ROOT}/.curl-stdin.all"
    if [ -e "${GREMION_ROOT}/data/cd" ]; then
        run grep -rlF TOKEN-9921 "${GREMION_ROOT}/data/cd"
        [ "$status" -eq 1 ]
    fi
}

@test "ping: a failing ping returns 0 and says nothing; no URL means no call" {
    cd_write_cfg CD_PING_URL=https://ping.example.org/hook-TOKEN-9921
    touch "${GREMION_ROOT}/.curl-fail"
    run nlib 'cd_ping; echo "rc=$?"'
    [ "$status" -eq 0 ]
    [ "$output" = "rc=0" ]
    cd_write_cfg
    : > "$SHIM_LOG"
    run nlib 'cd_ping'
    [ "$status" -eq 0 ]
    [ "$(curl_calls)" -eq 0 ]
}

# ---------------------------------------------------------------------------
# The program
# ---------------------------------------------------------------------------

@test "dispatcher: the real notify library loads in gremion-cd and a stub does not shadow it" {
    run bash -c ". '${HOST_SRC}/lib/common.sh'; . '${HOST_SRC}/lib/cd/core.sh'; . '${HOST_SRC}/lib/cd/notify.sh'; . '${GREMION_CD_STUBS_DIR}/cd-stubs.sh'; declare -f cd_notify | grep -q _cd_nf_queue && echo real"
    [ "$output" = "real" ]
}
