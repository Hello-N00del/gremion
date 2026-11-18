#!/usr/bin/env bash
# infra/host/lib/cd/notify.sh -- the gremion-cd notifier: the mail queue, the relay send,
# the daily digest and the optional outbound ping.
#
# SOURCED, NEVER EXECUTED. Like core.sh it sets no shell options and runs nothing at the
# top level except plain assignments.
#
# WHAT IS HERE
#   cd_notify KIND [k=v ...]    queue one mail: render it from an allow-list of fields into
#                               data/cd/outbox/<epoch>-<kind>.eml. It sends nothing, never
#                               waits on the network and ALWAYS returns 0 (a rollback must
#                               not wait for mail, and a refused or capped mail must not
#                               stop the caller). Two reserved arguments are not fields:
#                                 key=TOKEN    dedupe: one mail per KIND and TOKEN, kept in
#                                              the `notified` map of the state file (or, for
#                                              a process that must not write the state, in
#                                              data/cd/notified.marks)
#                                 every=SECS   with key=: the same key may mail again after
#                                              that many seconds (a reminder)
#   cd_notify_flush             send the queued files through the relay, oldest first. The
#                               first failure stops the pass and keeps every unsent file for
#                               the next flush. A flush lock keeps two flushers (the tick
#                               and the watchdog) from sending one file twice. 0 nothing
#                               left, 1 a send failed, 2 no recipient or the transport is
#                               not the relay, 3 another flusher is running.
#   cd_notify_transport_ok      0 when the mail transport is the relay, 1 otherwise
#                               (Stalwart, or a transport that cannot be read).
#   cd_notify_outbox_age        seconds since the oldest queued file was queued (0: none).
#   cd_notify_fields KIND       the allow-listed field names of a kind, one per line.
#   cd_notify_digest            the daily `alive` mail, once per day after CD_ALIVE_HOUR.
#   cd_ping                     the optional outbound GET (CD_PING_URL).
#
# THE REAL-DATA BOUNDARY. A mail is built from an allow-list: a field the kind does not
# list is dropped, and every value must match the shape of its field (a number, a short
# SHA, a release tag, a colour, a stage or rule or hold code, a gremion-cd command) or it
# is written as <redacted>; cd_scrub_value runs on top. The mail is still queued. The
# recipient is CD_MAIL_TO of etc/cd.env and nothing else. No secret is ever in the file:
# the relay password reaches curl on stdin only (`gremion-mail relay-curl-config` output
# piped to `curl -K -`), and the optional ping URL the same way.
#
# RELAY ONLY. On the Stalwart transport the file is queued, `notify: transport not
# supported` is logged and nothing is sent (the start gate then needs CD_ALLOW_NO_MAIL=1).

# -- the mail kinds and what each may carry ----------------------------------------------
# Rendering order is CD_NOTIFY_ORDER; `kind`, `time` and `host` are set by the program and
# are not arguments.
CD_NOTIFY_ORDER=(
    phase sha12 prev_sha12 uncovered tag colour prev_colour stage rule hold reason detail result notes
    commits requests fivexx tenants_not_ready
    modules_total modules_upgraded modules_failed leaves_total leaves_migrated leaves_skipped leaves_failed
    customers_total customers_ok customers_failed customers_skipped
    observed_min paused_min snapshot_s module_s reconcile_s hostlock_min
    dump_label dump_mb heartbeat_age_min poll_age_min outbox_age_min blocks mails_hour mails_day
    command
)

declare -gA CD_NOTIFY_TYPE=(
    [phase]=phase [sha12]=sha [prev_sha12]=sha [uncovered]=shalist [tag]=tag [colour]=colour [prev_colour]=colour
    [stage]=stage [rule]=rule [hold]=hold [reason]=code [detail]=detail [result]=result
    [dump_label]=label [command]=cmd [notes]=notes
)
# The closed vocabularies: the stage names, the block rules, the hold kinds and the watchdog
# details are the program's own words, so a field that names one accepts only those.
CD_NOTIFY_STAGES="none tick poll idle select fetch classify host_apply state_apply retag render build snapshot migrate start gates switch watch commit reconcile"
CD_NOTIFY_RULES="none build_failed migrate_failed start_failed readiness_failed isolation_failed verify_failed post_switch_verify watch_readiness watch_crash watch_5xx watch_pause_cap manual_rollback proof_end commit_stuck stuck_stage"
CD_NOTIFY_HOLDS="none operator blocked state_tier unsupported_chain contract_migration waived_migration ci_changed chain_class_changed batch_too_large not_ancestor ruleset_missing range_unverified classify_failed failure proof rollback_failed killswitch stuck_stage reconcile_failed"
CD_NOTIFY_DETAILS="no_heartbeat heartbeat_unreadable no_tick release_stuck release_over_budget state_unreadable poll_stale main_red outbox_old alert"
# The fixed sentences of the driver, as words: the `notes` field is a comma-separated list of
# at most four of them. A free sentence would be dropped or redacted, so the program's own
# remarks travel as words of this list and the reader of the mail knows what each one says.
#   lock_span_over           the host lock was held longer than CD_LOCK_SPAN_MIN (hostlock_min says how long)
#   reconcile_not_run        the reconcile stage was skipped (CD_RECONCILE=0)
#   rollback_off_lock_held   the kill switch is on: automatic rollback is OFF and the host lock is held
#   unhealthy_after_rollback the old colour is unhealthy after a rollback; nothing is left to try
CD_NOTIFY_NOTES="lock_span_over reconcile_not_run rollback_off_lock_held unhealthy_after_rollback"

declare -gA CD_NOTIFY_KIND_FIELDS=(
    [released]="sha12 prev_sha12 tag colour prev_colour commits requests fivexx tenants_not_ready modules_total modules_upgraded modules_failed leaves_total leaves_migrated leaves_skipped leaves_failed observed_min snapshot_s module_s reconcile_s hostlock_min dump_label dump_mb notes"
    [rolled_back]="sha12 prev_sha12 tag colour prev_colour stage rule observed_min requests fivexx tenants_not_ready hostlock_min command"
    [rejected]="sha12 prev_sha12 tag colour stage rule reason commits modules_total modules_upgraded modules_failed leaves_total leaves_migrated leaves_skipped leaves_failed dump_label command"
    [held]="sha12 prev_sha12 uncovered hold reason commits command"
    [stopped]="sha12 prev_sha12 tag colour stage rule reason modules_failed leaves_skipped leaves_failed dump_label command"
    [paused]="sha12 colour stage rule observed_min paused_min requests fivexx tenants_not_ready"
    [parked]="sha12 prev_sha12 colour prev_colour stage rule observed_min paused_min hostlock_min command"
    [stalled]="phase sha12 stage detail heartbeat_age_min poll_age_min outbox_age_min command"
    [alive]="phase sha12 hold blocks poll_age_min outbox_age_min"
    [rollback_failed]="sha12 prev_sha12 tag colour prev_colour stage rule reason notes command"
    [killswitch]="phase sha12 stage notes command"
    [adopted]="sha12 prev_sha12 colour reason command"
    [proof_on]="sha12 reason"
    [selftest]="sha12 stage result reason"
    [reconciled]="sha12 colour customers_total customers_ok customers_failed customers_skipped reconcile_s hostlock_min"
    [reconcile_failed]="sha12 colour customers_total customers_ok customers_failed customers_skipped reconcile_s reason command"
    [summary]="mails_hour mails_day"
)

CD_NOTIFY_HOURLY_CAP=20
CD_NOTIFY_DAILY_CAP=60
# `auto`: the state file's notified map when this process holds the cd lock, else the
# sidecar file. The watchdog sets `file`: it never writes the state.
CD_NOTIFY_MARKS=auto
CD_NOTIFY_TRANSPORT_VALUE=unknown

# cd_notify_fields KIND -- the allow-listed fields, one per line (a test and a reader use it).
cd_notify_fields() {
    local kind="${1:-}" f
    [[ -n "${CD_NOTIFY_KIND_FIELDS[$kind]+set}" ]] || return 2
    for f in ${CD_NOTIFY_KIND_FIELDS[$kind]}; do printf '%s\n' "$f"; done
}

_cd_nf_type() {
    local f="$1"
    if [[ -n "${CD_NOTIFY_TYPE[$f]+set}" ]]; then
        printf '%s' "${CD_NOTIFY_TYPE[$f]}"
    else
        printf 'num'
    fi
}

# _cd_nf_in_list WORD LIST -- 0 when WORD is one of the words of LIST.
_cd_nf_in_list() {
    [[ "$1" =~ ^[a-z0-9_]{1,40}$ ]] && [[ " $2 " == *" $1 "* ]]
}

# _cd_nf_cmd_ok VALUE -- 0 when VALUE is `gremion-cd VERB [ARG ...]` made only of the program's
# own words: a verb of the list, a flag of the list, a short SHA or `main`. A free word (a
# customer's name, a reason text, a branch) is not a command the mail may carry.
CD_NOTIFY_VERBS="status hold resume release-now rollback reconcile adopt selftest classify tick poll watchdog"
CD_NOTIFY_FLAGS="--json --discard-dump --accept-descendants --with-state --force-blocked --accept-range --unverified --re-adopt --post-apply --resume-only"
_cd_nf_cmd_ok() {
    local -a w=()
    local i
    read -r -a w <<< "${1-}" || return 1
    (( ${#w[@]} >= 2 && ${#w[@]} <= 7 )) || return 1
    [[ "${w[0]}" == gremion-cd ]] || return 1
    [[ " $CD_NOTIFY_VERBS " == *" ${w[1]} "* ]] || return 1
    for (( i = 2; i < ${#w[@]}; i++ )); do
        if [[ "${w[i]}" == --* ]]; then
            [[ " $CD_NOTIFY_FLAGS " == *" ${w[i]} "* ]] || return 1
        else
            [[ "${w[i]}" =~ ^([0-9a-f]{12}|main)$ ]] || return 1
        fi
    done
    # single spaces only: what was checked is what is printed
    [[ "$1" == "${w[*]}" ]]
}

# _cd_nf_notes_ok VALUE -- 0 when VALUE is one to four words of CD_NOTIFY_NOTES, comma-separated.
_cd_nf_notes_ok() {
    local -a w=()
    local i
    [[ "${1-}" =~ ^[a-z_]+(,[a-z_]+){0,3}$ ]] || return 1
    IFS=',' read -r -a w <<< "$1" || return 1
    for (( i = 0; i < ${#w[@]}; i++ )); do
        [[ " $CD_NOTIFY_NOTES " == *" ${w[i]} "* ]] || return 1
    done
    return 0
}

# _cd_nf_clean TYPE VALUE -- VALUE when it has the shape of its field and passes the
# scrubber, else <redacted>.
_cd_nf_clean() {
    local type="$1" v="${2-}" ok=0
    local re_num='^([0-9]{1,9}(\.[0-9]{1,2})?|unknown)$'
    local re_sha='^([0-9a-f]{12}|none)$'
    local re_shalist='^[0-9a-f]{12}(,[0-9a-f]{12}){0,9}$'
    local re_tag='^pilot-[0-9a-f]{12}$'
    local re_code='^[a-z][a-z0-9_]{0,59}$'
    local re_phase='^(idle|releasing|watching|rolling_back|parked|unknown)$'
    local re_label='^(state-)?pilot-[0-9a-f]{12}$'
    case "$type" in
        num) [[ "$v" =~ $re_num ]] && ok=1 ;;
        sha) [[ "$v" =~ $re_sha ]] && ok=1 ;;
        tag) [[ "$v" =~ $re_tag ]] && ok=1 ;;
        colour) [[ "$v" == blue || "$v" == green ]] && ok=1 ;;
        code) [[ "$v" =~ $re_code ]] && ok=1 ;;
        shalist) [[ "$v" =~ $re_shalist ]] && ok=1 ;;
        stage) _cd_nf_in_list "$v" "$CD_NOTIFY_STAGES" && ok=1 ;;
        rule) _cd_nf_in_list "$v" "$CD_NOTIFY_RULES" && ok=1 ;;
        hold) _cd_nf_in_list "$v" "$CD_NOTIFY_HOLDS" && ok=1 ;;
        detail) _cd_nf_in_list "$v" "$CD_NOTIFY_DETAILS" && ok=1 ;;
        result) [[ "$v" == ok || "$v" == failed ]] && ok=1 ;;
        phase) [[ "$v" =~ $re_phase ]] && ok=1 ;;
        cmd) _cd_nf_cmd_ok "$v" && ok=1 ;;
        label) [[ "$v" =~ $re_label ]] && ok=1 ;;
        notes) _cd_nf_notes_ok "$v" && ok=1 ;;
    esac
    if (( ok == 1 )); then
        cd_scrub_value "$v"
    else
        printf '%s\n' '<redacted>'
    fi
}

# -- marks (dedupe) ----------------------------------------------------------------------
_cd_nf_marks_file() { printf '%s' "${CD_DATA}/notified.marks"; }

# _cd_nf_mark_get KEY -- prints the ISO time of the mark; 0 when there is one. Both stores
# are read: a mark in either one counts.
_cd_nf_mark_get() {
    local key="$1" v="" f
    if [[ "$CD_NOTIFY_MARKS" != file && -f "$CD_STATE_FILE" ]]; then
        v="$(jq -r --arg k "$key" '(.notified // {})[$k] // empty' "$CD_STATE_FILE" 2>/dev/null </dev/null)" || v=""
    fi
    f="$(_cd_nf_marks_file)"
    if [[ -z "$v" && -f "$f" ]]; then
        v="$(awk -v k="$key" '$1 == k { t = $2 } END { if (t != "") print t }' "$f" 2>/dev/null)" || v=""
    fi
    [[ -n "$v" ]] || return 1
    printf '%s\n' "$v"
}

# _cd_nf_mark_put KEY EPOCH -- into the state file's notified map when this process holds
# the cd lock (and may write it), else into the sidecar. Entries older than 35 days go.
_cd_nf_mark_put() {
    local key="$1" epoch="$2" iso cut f tmp
    iso="$(cd_iso "$epoch")" || return 1
    cut="$(cd_iso $(( epoch - 35 * 86400 )))" || return 1
    if [[ "$CD_NOTIFY_MARKS" != file && "${CD_LOCK_PID:-}" == "$$" && -f "$CD_STATE_FILE" ]]; then
        # a subshell: an unreadable state makes cd_state_load exit, and that must end this
        # attempt only, never the caller (cd_notify cannot take the caller down)
        # shellcheck disable=SC2016,SC2034  # SC2016: a jq filter, $k $t $c are jq variables; SC2034: CD_HB_PID is read by cd_die -> cd_heartbeat_stop in core.sh
        if ( CD_HB_PID=""; cd_state_set '.notified[$k] = $t | .notified |= with_entries(select(.value > $c))' \
                --arg k "$key" --arg t "$iso" --arg c "$cut" ) 2>/dev/null; then
            return 0
        fi
    fi
    f="$(_cd_nf_marks_file)"
    cd_mkdir "$CD_DATA" || return 1
    tmp="$( { [[ -f "$f" ]] && awk -v c="$cut" '$2 > c' "$f"; printf '%s %s\n' "$key" "$iso"; } 2>/dev/null )" || tmp=""
    printf '%s\n' "$tmp" | sed '/^$/d' | cd_atomic_write "$f" 600
}

# _cd_nf_epoch ISO -- the epoch of an ISO time (the YYYY-MM-DDTHH:MM:SSZ that cd_iso writes),
# nothing and 1 when it is anything else. GNU date reads "" as today's midnight on the real
# clock and "today" as now, so the shape is checked before date sees the value.
_cd_nf_epoch() {
    local v
    [[ "${1:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
    v="$(date -u -d "$1" +%s 2>/dev/null)" || return 1
    [[ "$v" =~ ^[0-9]+$ ]] || return 1
    printf '%s\n' "$v"
}

# -- the cap -----------------------------------------------------------------------------
_cd_nf_ledger() { printf '%s' "${CD_DATA}/mail-ledger"; }

# _cd_nf_cap_verdict NOW -- prints "ok|summary|drop HOURCOUNT DAYCOUNT [hour|day]" (the counts
# and the summary type travel in the output: the function runs inside $( ), so it cannot set a
# variable for its caller). Twenty mails an hour and sixty a day; the first one over a line
# becomes one summary mail of that line's type, the rest are dropped. The ledger keeps the
# type of a summary (summary-hour, summary-day) and each line counts only its own type: an
# hourly summary sent earlier in the day must not stop the daily line from speaking.
_cd_nf_cap_verdict() {
    local now="$1" f e k age nh=0 nd=0 sh=0 sd=0
    f="$(_cd_nf_ledger)"
    if [[ -f "$f" ]]; then
        while read -r e k; do
            [[ "$e" =~ ^[0-9]{1,12}$ ]] || continue
            age=$(( now - e ))
            (( age < 0 )) && age=0
            if (( age < 86400 )); then
                nd=$(( nd + 1 ))
                [[ "$k" == summary-day ]] && sd=$(( sd + 1 ))
                if (( age < 3600 )); then
                    nh=$(( nh + 1 ))
                    [[ "$k" == summary-hour ]] && sh=$(( sh + 1 ))
                fi
            fi
        done < "$f"
    fi
    if (( nh >= CD_NOTIFY_HOURLY_CAP )); then
        if (( sh == 0 )); then printf 'summary %s %s hour\n' "$nh" "$nd"; else printf 'drop %s %s\n' "$nh" "$nd"; fi
        return 0
    fi
    if (( nd >= CD_NOTIFY_DAILY_CAP )); then
        if (( sd == 0 )); then printf 'summary %s %s day\n' "$nh" "$nd"; else printf 'drop %s %s\n' "$nh" "$nd"; fi
        return 0
    fi
    printf 'ok %s %s\n' "$nh" "$nd"
}

_cd_nf_ledger_add() {
    local now="$1" kind="$2" f size tmp
    f="$(_cd_nf_ledger)"
    cd_mkdir "$CD_DATA" || return 1
    ( umask 077; printf '%s %s\n' "$now" "$kind" >> "$f" ) || return 1
    size="$(stat -c %s "$f" 2>/dev/null || echo 0)"
    if (( size > 4096 )); then
        tmp="$(awk -v n="$now" '($1 + 0) > (n - 86400)' "$f" 2>/dev/null)" || return 0
        printf '%s\n' "$tmp" | cd_atomic_write "$f" 600 || true
    fi
    return 0
}

# -- queue -------------------------------------------------------------------------------
# _cd_nf_write_file KIND NOW BODY SUBJECT TO -- the file, mode 0600, the first free name.
_cd_nf_write_file() {
    local kind="$1" now="$2" subject="$3" body="$4" to="$5" dir path n=1 date_h id
    dir="${CD_DATA}/outbox"
    cd_mkdir "$CD_DATA" && cd_mkdir "$dir" || return 1
    date_h="$(date -u -d "@${now}" '+%a, %d %b %Y %H:%M:%S +0000')" || return 1
    id="${now}.${kind}.${RANDOM}${RANDOM}@gremion-cd.invalid"
    path="${dir}/${now}-${kind}.eml"
    while ! ( set -o noclobber; umask 077; printf 'To: %s\nSubject: %s\nDate: %s\nMessage-ID: <%s>\nMIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\n\n%s\n' \
            "$to" "$subject" "$date_h" "$id" "$body" > "$path" ) 2>/dev/null; do
        n=$(( n + 1 ))
        (( n > 200 )) && return 1
        path="${dir}/${now}-${kind}-${n}.eml"
    done
    printf '%s\n' "$path"
}

_cd_nf_queue() {
    local kind="${1:-}" arg name val ftype allowed f line to now iso label subject body
    local dedupe_key="" every="" mark mark_epoch verdict="ok" cap_h=0 cap_d=0 cap_t="" proof sha_s col_s path ledger_kind="$kind"
    local -A vals=()
    local -a dropped=()
    shift || true

    if [[ -z "$kind" || -z "${CD_NOTIFY_KIND_FIELDS[$kind]+set}" ]]; then
        cd_err "notify: not a mail kind"
        cd_hist mail_refused reason=bad_kind || true
        return 0
    fi
    allowed=" ${CD_NOTIFY_KIND_FIELDS[$kind]} "
    for arg in "$@"; do
        if [[ "$arg" != *=* ]]; then
            dropped+=(arg)
            continue
        fi
        name="${arg%%=*}"
        val="${arg#*=}"
        if [[ ! "$name" =~ ^[a-z][a-z0-9_]{0,40}$ ]]; then
            dropped+=(badname)
            continue
        fi
        case "$name" in
            key)
                if [[ "$val" =~ ^[A-Za-z0-9_.-]{1,64}$ ]]; then dedupe_key="$val"; else dropped+=(badkey); fi
                continue
                ;;
            every)
                if [[ "$val" =~ ^[0-9]{1,9}$ ]]; then every="$val"; else dropped+=(badevery); fi
                continue
                ;;
        esac
        if [[ "$allowed" != *" ${name} "* ]]; then
            dropped+=("$name")
            continue
        fi
        vals[$name]="$val"
    done

    to="$(cd_cfg CD_MAIL_TO 2>/dev/null)" || to=""
    [[ -n "$to" ]] || return 0
    now="$(cd_now)" || return 0

    if [[ -n "$dedupe_key" ]]; then
        if mark="$(_cd_nf_mark_get "${kind}:${dedupe_key}")"; then
            # the already-sent path is silent: a periodic caller would otherwise write one
            # history line per tick for a mail that went out days ago
            [[ -n "$every" ]] || return 0
            mark_epoch="$(_cd_nf_epoch "$mark")" || mark_epoch=""
            if [[ -n "$mark_epoch" ]] && (( now - mark_epoch < every )); then
                return 0
            fi
        fi
    fi

    if [[ "$kind" != summary ]]; then
        read -r verdict cap_h cap_d cap_t <<< "$(_cd_nf_cap_verdict "$now")" || true
        case "$verdict" in
            drop)
                cd_hist mail_dropped kind="$kind" reason=cap || true
                return 0
                ;;
            summary)
                cd_hist mail_capped hour="$cap_h" day="$cap_d" || true
                # _cd_nf_summary_type is read by the call below (dynamic scope): the ledger
                # line of the summary says which line it speaks for
                # shellcheck disable=SC2034
                local _cd_nf_summary_type="summary-${cap_t}"
                _cd_nf_queue summary "mails_hour=${cap_h}" "mails_day=${cap_d}" || true
                return 0
                ;;
        esac
    fi

    label="$(cd_cfg CD_HOST_LABEL 2>/dev/null)" || label=""
    [[ "$label" =~ ^[a-z0-9-]{1,32}$ ]] || label="unknown"
    iso="$(cd_iso "$now")" || return 0
    body="kind: ${kind}"$'\n'"time: ${iso}"$'\n'"host: ${label}"
    for f in "${CD_NOTIFY_ORDER[@]}"; do
        [[ -n "${vals[$f]+set}" ]] || continue
        [[ -n "${vals[$f]}" ]] || continue
        ftype="$(_cd_nf_type "$f")"
        line="$(_cd_nf_clean "$ftype" "${vals[$f]}")"
        body+=$'\n'"${f}: ${line}"
    done
    if (( ${#dropped[@]} > 0 )); then
        cd_hist mail_fields_dropped kind="$kind" count="${#dropped[@]}" || true
    fi
    sha_s="-"
    [[ -n "${vals[sha12]+set}" ]] && sha_s="$(_cd_nf_clean sha "${vals[sha12]}")"
    col_s="-"
    [[ -n "${vals[colour]+set}" ]] && col_s="$(_cd_nf_clean colour "${vals[colour]}")"
    proof=""
    [[ "$(cd_cfg CD_PROOF_MODE 2>/dev/null)" == 1 ]] && proof="[PROOF] "
    subject="[gremion-cd] ${proof}${kind} ${sha_s} ${col_s}"

    path="$(_cd_nf_write_file "$kind" "$now" "$subject" "$body" "$to")" || {
        cd_hist mail_queue_failed kind="$kind" || true
        return 0
    }
    [[ "$kind" == summary ]] && ledger_kind="${_cd_nf_summary_type:-summary-hour}"
    _cd_nf_ledger_add "$now" "$ledger_kind" || true
    if [[ -n "$dedupe_key" ]]; then
        _cd_nf_mark_put "${kind}:${dedupe_key}" "$now" || true
    fi
    cd_hist mail_queued kind="$kind" || true
    return 0
}

# cd_notify KIND [k=v ...] -- queue one mail. Always 0.
cd_notify() {
    _cd_nf_queue "$@" || true
    return 0
}

# -- transport and send ------------------------------------------------------------------
_cd_nf_mail_bin() { printf '%s' "${CD_ROOT}/bin/gremion-mail"; }

# cd_notify_transport_ok -- 0 on the relay transport, 1 on Stalwart or when it cannot be read
# (CD_NOTIFY_TRANSPORT_VALUE says which). Nothing is printed.
cd_notify_transport_ok() {
    local bin out
    CD_NOTIFY_TRANSPORT_VALUE=unknown
    bin="$(_cd_nf_mail_bin)"
    [[ -x "$bin" ]] || return 1
    out="$("$bin" transport </dev/null 2>/dev/null)" || return 1
    case "$out" in
        relay) CD_NOTIFY_TRANSPORT_VALUE=relay; return 0 ;;
        stalwart) CD_NOTIFY_TRANSPORT_VALUE=stalwart; return 1 ;;
    esac
    return 1
}

# cd_notify_outbox_age -- seconds since the oldest queued file was queued, from the epoch in
# its name (the fake clock reaches it); 0 when the outbox is empty.
cd_notify_outbox_age() {
    local f e oldest="" now
    now="$(cd_now)" || { printf '0\n'; return 0; }
    for f in "${CD_DATA}/outbox"/*.eml; do
        [[ -f "$f" ]] || continue
        e="${f##*/}"
        e="${e%%-*}"
        [[ "$e" =~ ^[0-9]{9,12}$ ]] || continue
        if [[ -z "$oldest" ]] || (( e < oldest )); then oldest="$e"; fi
    done
    if [[ -z "$oldest" ]] || (( now <= oldest )); then
        printf '0\n'
    else
        printf '%s\n' "$(( now - oldest ))"
    fi
}

# _cd_nf_send FILE TO -- one message through the relay: `gremion-mail relay-curl-config --to
# --message` prints a curl config (it holds the relay password) that is piped to `curl -K -`.
# The password is in a shell variable and on curl's stdin, never in an argument, an
# environment or a file. The From header is the config's own `mail-from` (the envelope
# sender), so header and envelope agree and the relay accepts it; the upload file is a
# copy of the queued file with CRLF line ends and that header, rewritten in place once the
# config has named the sender (the program needs the path first).
_cd_nf_send() {
    local file="$1" to="$2" bin from tmp cfg rc=0
    bin="$(_cd_nf_mail_bin)"
    [[ -x "$bin" ]] || return 1
    tmp="${CD_DATA}/outbox/.send.$$.eml"
    ( umask 077; awk '{ printf "%s\r\n", $0 }' "$file" > "$tmp" ) || { rm -f "$tmp"; return 1; }
    if ! cfg="$("$bin" relay-curl-config --to "$to" --message "$tmp" </dev/null 2>/dev/null)" || [[ -z "$cfg" ]]; then
        rm -f "$tmp"
        return 1
    fi
    from="$(printf '%s\n' "$cfg" | sed -n 's/^mail-from = "\(.*\)"$/\1/p' | head -n 1)"
    if [[ ! "$from" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]]; then
        cfg=""
        rm -f "$tmp"
        return 1
    fi
    ( umask 077; { printf 'From: %s\r\n' "$from"; awk '{ printf "%s\r\n", $0 }' "$file"; } > "$tmp" ) || { cfg=""; rm -f "$tmp"; return 1; }
    printf '%s\n' "$cfg" | curl --silent --show-error --connect-timeout 10 --max-time 60 -K - >/dev/null 2>&1 7>&- || rc=$?
    cfg=""
    rm -f "$tmp"
    return "$rc"
}

# cd_notify_flush -- send what is queued. See the header for the codes.
cd_notify_flush() {
    local dir="${CD_DATA}/outbox" to f rc=0 n=0 sent=0 lock
    local -a files=()
    [[ -d "$dir" ]] || return 0
    mapfile -t files < <(find "$dir" -maxdepth 1 -type f -name '[0-9]*-*.eml' 2>/dev/null | LC_ALL=C sort)
    (( ${#files[@]} > 0 )) || return 0
    to="$(cd_cfg CD_MAIL_TO 2>/dev/null)" || to=""
    if [[ -z "$to" ]]; then
        cd_err "notify: no recipient (CD_MAIL_TO)"
        return 2
    fi
    if ! cd_notify_transport_ok; then
        if [[ "$CD_NOTIFY_TRANSPORT_VALUE" == stalwart ]]; then
            cd_err "notify: transport not supported (the relay transport only); ${#files[@]} mail(s) stay queued"
        else
            cd_err "notify: the mail transport cannot be read; ${#files[@]} mail(s) stay queued"
        fi
        cd_hist mail_not_sent reason=transport queued="${#files[@]}" || true
        return 2
    fi
    cd_mkdir "$CD_RUN" || return 2
    lock="${CD_RUN}/notify.lock"
    if ! exec 7>>"$lock"; then
        return 2
    fi
    if ! flock -n 7; then
        exec 7>&-
        return 3
    fi
    # holding the flush lock, no send is running: an upload copy that is left (a send that was
    # killed between writing it and removing it) belongs to nobody and goes
    rm -f "$dir"/.send.*.eml 2>/dev/null || true
    for f in "${files[@]}"; do
        [[ -f "$f" ]] || continue
        n=$(( n + 1 ))
        if _cd_nf_send "$f" "$to"; then
            rm -f "$f"
            sent=$(( sent + 1 ))
        else
            rc=1
            cd_err "notify: a send failed; ${#files[@]} mail(s) stay queued for the next flush"
            cd_hist mail_send_failed || true
            break
        fi
    done
    exec 7>&-
    (( sent > 0 )) && { cd_hist mail_sent count="$sent" || true; }
    return "$rc"
}

# -- the daily digest --------------------------------------------------------------------
# cd_notify_digest -- the `alive` mail: phase, live short SHA, last poll age, hold, open
# blocks and outbox age, and nothing else. It reads the state and the block list with a
# tolerant jq, so a damaged state still gives a digest (phase unknown). Once per host
# calendar day, from the first call at or after CD_ALIVE_HOUR; the absence of this mail is
# the alarm.
cd_notify_digest() {
    local now hour day alive_hour phase sha12 hold blocks poll_age outbox_age last last_e
    now="$(cd_now)" || return 0
    alive_hour="$(cd_cfg CD_ALIVE_HOUR 2>/dev/null)" || return 0
    hour="$(date -d "@${now}" +%H 2>/dev/null)" || return 0
    (( 10#$hour >= alive_hour )) || return 0
    day="$(date -d "@${now}" +%Y-%m-%d 2>/dev/null)" || return 0
    phase=unknown sha12=none hold=none blocks=unknown poll_age=unknown
    if [[ -f "$CD_STATE_FILE" ]] && jq -e 'type == "object" and .v == 1' "$CD_STATE_FILE" >/dev/null 2>&1 </dev/null; then
        phase="$(jq -r '.phase // "unknown"' "$CD_STATE_FILE" 2>/dev/null)" || phase=unknown
        sha12="$(jq -r '.live.sha12 // "none"' "$CD_STATE_FILE" 2>/dev/null)" || sha12=none
        hold="$(jq -r '.hold.kind // "none"' "$CD_STATE_FILE" 2>/dev/null)" || hold=none
        last="$(jq -r '.poll.last_at // empty' "$CD_STATE_FILE" 2>/dev/null)" || last=""
        if [[ -n "$last" ]] && last_e="$(_cd_nf_epoch "$last")"; then
            if (( now > last_e )); then poll_age=$(( (now - last_e) / 60 )); else poll_age=0; fi
        fi
    fi
    if [[ -f "$CD_BLOCKED_FILE" ]]; then
        blocks="$(jq -r 'if type == "array" then [.[] | select(.cleared == null)] | length else "unknown" end' "$CD_BLOCKED_FILE" 2>/dev/null)" || blocks=unknown
    elif [[ -d "$CD_DATA" ]]; then
        blocks=0
    fi
    outbox_age=$(( $(cd_notify_outbox_age) / 60 ))
    cd_notify alive "key=${day}" "phase=${phase}" "sha12=${sha12}" "hold=${hold}" \
        "blocks=${blocks}" "poll_age_min=${poll_age}" "outbox_age_min=${outbox_age}"
    return 0
}

# -- the ping ----------------------------------------------------------------------------
# cd_ping -- one outbound GET to CD_PING_URL after a clean tick (an external check service
# alerts when the pings stop). The URL may carry a token: it goes to curl on stdin as a
# config line, so it is in no argument and no environment, and nothing is printed or
# logged. A ping that fails, or no URL, is still 0.
cd_ping() {
    local url=""
    url="$(cd_cfg CD_PING_URL 2>/dev/null)" || url=""
    [[ -n "$url" ]] || return 0
    printf 'url = "%s"\n' "$url" \
        | curl --silent --show-error --fail --connect-timeout 5 --max-time 10 --output /dev/null -K - >/dev/null 2>&1 7>&- || true
    url=""
    return 0
}
