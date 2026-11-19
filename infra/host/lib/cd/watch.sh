#!/usr/bin/env bash
# infra/host/lib/cd/watch.sh - the watch of the continuous deployment program: one sample
# of the new colour, the access-log counter and the evaluation of a sample into a verdict.
# There is NO loop here (commit.sh owns it).
#
# SOURCED, NEVER EXECUTED. Like colour.sh it sets no shell options and runs nothing at the
# top level. It calls core.sh (cd_now, cd_cfg, cd_state_get, cd_state_set, cd_hist,
# cd_atomic_write, cd_mkdir, cd_iso), docker.sh (cd_envfile, cd_kv_get, cd_traefik_api,
# cd_svc_cid, cd_project_cids, cd_wait_healthy, cd_colour_other), colour.sh
# (cd_colour_probe, cd_colour_portal_probe, cd_colour_identity, cd_colour_workers) and
# notify.sh (cd_notify) when they exist, and docker, curl, jq, timeout and coreutils.
#
# WHAT IS HERE
#   cd_watch_baseline              the baselines of the release, taken from the LIVE colour at
#                                  its start: tenants.notReady (internal /readyz) and the raw
#                                  5xx count of the CD_BASELINE_S seconds before now. Written
#                                  to release.watch. 4 when the live colour does not answer.
#   cd_watch_probe_public          the public /readyz and the login page of the probe host
#                                  through the real edge (curl --resolve, certificate
#                                  verified). Prints "<readyz status> <login status>"; 0 only
#                                  when /readyz is 200 with {"ready":true} and the login page
#                                  answers below 500. One code path: the sample calls it.
#   cd_watch_accesslog_count SINCE the 5xx answers of app@file and public@file since SINCE
#                                  (an epoch) from the edge access log; prints an integer, and
#                                  returns non-zero (prints nothing) when the log cannot be
#                                  read or does not reach back to SINCE: never a low number.
#   cd_watch_sample [COLOUR TAG TREE]
#                                  prints ONE JSON sample of the colour (default: the release
#                                  of the state). Every call of it is bounded, and the whole
#                                  sample is bounded by CD_SAMPLE_TIMEOUT_S.
#   cd_watch_eval SAMPLE_JSON      updates the watch counters of the state and prints the
#                                  verdict on line 1: ok, bad, paused, parked or
#                                  trigger:<rule>. Further lines: `blind` (the access log was
#                                  unreadable; the verdict on line 1 is unaffected) and
#                                  `flip <colour> on|off` (the worker gate file of that colour
#                                  has diverged and must be rewritten: old off first, then new
#                                  on). It writes no gate file itself and starts no rollback.
#
# RETURN CODES. 0 ok, 2 usage or a missing precondition (no release, no probe host, no edge
# address, a bad sample), 4 an infrastructure answer is missing. Unknown is never green: an
# answer that is not exactly the expected shape is a failed probe, never a pass.
#
# THE REAL-DATA BOUNDARY. The probe host is customer data: it appears on the argv of curl
# and nowhere else (curl's own stderr is discarded; no sample, no state, no history line and
# no message carries it). The access log is read as COUNTS: the lines are piped through jq
# and never stored. Names of components, stages and counts only.
#
# THE SIDECAR data/cd/watch-eval.json (0600): {v, release, grace, restarts, last_duration_s}.
# release.watch is a closed key set (core.sh), so the three facts it cannot hold live here,
# keyed by the release id and durable: the restart baseline of the new colour's containers,
# the number of samples after a resume that may not trigger (the reboot rule), and the
# duration of the previous sample (a slow sample is not a resume).

_cd_watch_err() { printf 'cd-watch: %s\n' "$*" >&2; }

# The edge access log of the state project's traefik container, and how far back one read
# goes. A read that returns this many lines and still does not reach back to SINCE is
# incomplete, so it is "unreadable".
_CD_WATCH_LOG_PATH=/logs/access.log
_CD_WATCH_TAIL_LINES=200000
# The reboot rule: this many samples after a resume are never counted as triggers.
_CD_WATCH_GRACE_SAMPLES=2
# Ten unreadable-log samples in a row warn the operator.
_CD_WATCH_BLIND_WARN=10

# _cd_watch_int KEY - the config value of KEY as a whole number; 2 when it is not one.
_cd_watch_int() {
    local v
    v="$(cd_cfg "$1" 2>/dev/null)" || { _cd_watch_err "the config key $1 cannot be read"; return 2; }
    [[ "$v" =~ ^[0-9]{1,9}$ ]] || { _cd_watch_err "the config key $1 is not a whole number"; return 2; }
    printf '%s' "$((10#$v))"
}

# -- the time budget ------------------------------------------------------------------
# While a sample runs, CD_WATCH_DEADLINE is the epoch its budget ends at (set by the sample
# only). _cd_watch_ct prints the timeout for the NEXT call: CD_SAMPLE_TIMEOUT_S, or what is
# left of the budget when that is less (at least 1), and returns 1 once the budget is spent.
# Outside a sample (U10b's public probe, the baseline) every call gets the full timeout.
_cd_watch_ct() {
    local t left
    t="$(_cd_watch_int CD_SAMPLE_TIMEOUT_S)" || return 1
    if [[ -n "${CD_WATCH_DEADLINE:-}" ]]; then
        left=$((CD_WATCH_DEADLINE - $(cd_now)))
        ((left >= 1)) || return 1
        ((left < t)) && t=$left
    fi
    printf '%s' "$t"
}

# -- the probe host and the edge --------------------------------------------------------

# _cd_watch_probe_host - CD_PROBE_HOST, else the first field of the first line of
# etc/tenant-hosts.txt that is no comment (the same rule as the start gate). Prints it; 2
# when there is none or it is not a host name.
_cd_watch_probe_host() {
    local h f line
    h="$(cd_cfg CD_PROBE_HOST 2>/dev/null)" || return 2
    if [[ -z "$h" ]]; then
        f="${CD_ROOT}/etc/tenant-hosts.txt"
        if [[ -r "$f" ]]; then
            while IFS= read -r line || [[ -n "$line" ]]; do
                line="${line%$'\r'}"
                line="${line#"${line%%[![:space:]]*}"}"
                [[ -z "$line" || "$line" == \#* ]] && continue
                h="${line%%[[:space:]]*}"
                break
            done <"$f"
        fi
    fi
    [[ "$h" =~ ^[a-z0-9.-]{1,253}$ ]] || { _cd_watch_err "no probe host (CD_PROBE_HOST, or a line of etc/tenant-hosts.txt)"; return 2; }
    printf '%s' "$h"
}

# _cd_watch_state_env KEY - one value of state.env (a single plain line); 2 when it is not.
_cd_watch_state_env() {
    local f v
    f="$(cd_envfile state)" || return 2
    [[ -f "$f" && -r "$f" ]] || { _cd_watch_err "no readable state.env"; return 2; }
    v="$(cd_kv_get "$f" "$1" 2>/dev/null)" || { _cd_watch_err "state.env has no single ${1}"; return 2; }
    printf '%s' "$v"
}

# _cd_watch_edge - "<ip> <https port>" of the edge, the way gremion-verify reaches it
# (EDGE_BIND_IP and EDGE_HTTPS_PORT of state.env). 2 on a missing or placeholder value.
_cd_watch_edge() {
    local ip port
    ip="$(_cd_watch_state_env EDGE_BIND_IP)" || return 2
    port="$(_cd_watch_state_env EDGE_HTTPS_PORT)" || return 2
    [[ "$ip" =~ ^([0-9]{1,3}(\.[0-9]{1,3}){3}|[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*)$ ]] || { _cd_watch_err "EDGE_BIND_IP of state.env is not an address"; return 2; }
    [[ "$port" =~ ^[0-9]{1,5}$ && "$((10#$port))" -ge 1 && "$((10#$port))" -le 65535 ]] || { _cd_watch_err "EDGE_HTTPS_PORT of state.env is not a port"; return 2; }
    printf '%s %s' "$ip" "$((10#$port))"
}

# -- the public probe -----------------------------------------------------------------

# _cd_watch_http URL RESOLVE BODYFILE - the HTTP status of one request through --resolve, the
# certificate verified (no -k), bounded, curl's stderr discarded (it names the host). Prints
# the three digits, or 000 for anything that is not an answer (a timeout included).
_cd_watch_http() {
    local url="$1" resolve="$2" bodyf="$3" t code
    t="$(_cd_watch_ct)" || { printf '000'; return 0; }
    code="$(curl -sS --max-time "$t" --connect-timeout "$t" --max-filesize 65536 \
        --resolve "$resolve" -o "$bodyf" -w '%{http_code}' "$url" </dev/null 2>/dev/null)" || true
    [[ "$code" =~ ^[0-9]{3}$ ]] || code=000
    printf '%s' "$code"
}

# cd_watch_probe_public - see the header. Returns 0 when both are good, 1 when either is not
# (the statuses are still printed), 2 when the probe host or the edge address is missing.
cd_watch_probe_public() {
    local host ip port edge resolve base ready login bodyf rc=0
    host="$(_cd_watch_probe_host)" || { printf '000 000\n'; return 2; }
    edge="$(_cd_watch_edge)" || { printf '000 000\n'; return 2; }
    ip="${edge%% *}"
    port="${edge##* }"
    if [[ "$ip" == *:* ]]; then resolve="${host}:${port}:[${ip}]"; else resolve="${host}:${port}:${ip}"; fi
    base="https://${host}"
    [[ "$port" == 443 ]] || base="${base}:${port}"
    bodyf="$(mktemp 2>/dev/null)" || { _cd_watch_err "cannot create a temporary file"; printf '000 000\n'; return 2; }
    ready="$(_cd_watch_http "${base}/readyz" "$resolve" "$bodyf")"
    if [[ "$ready" == 200 ]]; then
        head -c 4096 -- "$bodyf" 2>/dev/null | jq -e '. == {"ready": true}' >/dev/null 2>&1 || rc=1
    else
        rc=1
    fi
    login="$(_cd_watch_http "${base}/auth/login" "$resolve" "$bodyf")"
    rm -f -- "$bodyf"
    [[ "$login" =~ ^[1-4][0-9][0-9]$ ]] || rc=1
    printf '%s %s\n' "$ready" "$login"
    return "$rc"
}

# -- the access log -------------------------------------------------------------------

# _cd_watch_scan SINCE - prints "<5xx answers> <requests>" of app@file and public@file since
# SINCE (counts only; the lines go through jq and are never stored). Routers named test-* and
# every other service are not counted. 1 when the log cannot be read or the read does not
# reach back to SINCE; 2 on a bad argument.
_cd_watch_scan() {
    local since="${1:-}" cid t out n req first lines
    [[ "$since" =~ ^[0-9]{1,12}$ ]] || { _cd_watch_err "the access log count needs an epoch"; return 2; }
    t="$(_cd_watch_ct)" || return 1
    cid="$(cd_svc_cid state traefik 2>/dev/null)" || return 1
    [[ -n "$cid" ]] || return 1
    out="$(timeout -k 2 "$t" docker exec "$cid" tail -n "$_CD_WATCH_TAIL_LINES" "$_CD_WATCH_LOG_PATH" </dev/null 2>/dev/null \
        | jq -R -n -r --argjson since "$since" '
            def ts: (.StartUTC // .time // "") | tostring | sub("\\.[0-9]+"; "") | (try fromdateiso8601 catch null);
            reduce (inputs | fromjson? | select(type == "object")) as $l ({n: 0, r: 0, first: 0, lines: 0};
                ($l | ts) as $t
                | .lines += 1
                | (if .first == 0 and $t != null then .first = $t else (.) end)
                | (if $t != null and $t >= $since
                       and ($l.ServiceName | IN("app@file", "public@file"))
                       and (($l.RouterName // "") | tostring | startswith("test-") | not)
                   then .r += 1
                        | (if ($l.DownstreamStatus | type) == "number" and $l.DownstreamStatus >= 500 and $l.DownstreamStatus <= 599
                           then .n += 1 else (.) end)
                   else (.) end))
            | "\(.n) \(.r) \(.first) \(.lines)"' 2>/dev/null)" || return 1
    read -r n req first lines <<<"$out"
    [[ "$n" =~ ^[0-9]{1,9}$ && "$req" =~ ^[0-9]{1,9}$ && "$first" =~ ^[0-9]{1,12}$ && "$lines" =~ ^[0-9]{1,9}$ ]] || return 1
    # a read that filled the tail and still starts after SINCE has lost the older lines
    if ((10#$lines >= _CD_WATCH_TAIL_LINES)) && { ((10#$first == 0)) || ((10#$first > since)); }; then
        _cd_watch_err "the access log read does not reach back to the start of the window"
        return 1
    fi
    printf '%s %s' "$((10#$n))" "$((10#$req))"
}

# cd_watch_accesslog_count SINCE_EPOCH - the 5xx count since SINCE_EPOCH, an integer, or
# nothing and a non-zero code when the log is unreadable.
cd_watch_accesslog_count() {
    local out rc=0
    out="$(_cd_watch_scan "${1:-}")" || rc=$?
    [[ "$rc" -eq 0 ]] || return "$rc"
    printf '%s\n' "${out%% *}"
}

# -- the Traefik API ------------------------------------------------------------------

# _cd_watch_api_up - 0 when the Traefik API answers (bounded); 1 when it does not.
_cd_watch_api_up() {
    local api t
    api="$(cd_traefik_api 2>/dev/null)" || return 1
    t="$(_cd_watch_ct)" || return 1
    curl -fsS --max-time "$t" "${api}/api/version" </dev/null >/dev/null 2>&1
}

# _cd_watch_route NAME SVC COLOUR - 0 when the Traefik service NAME has servers, every server
# is http://SVC-COLOUR:3000 and every one is UP; 1 when not; 4 when the API gave no answer.
_cd_watch_route() {
    local name="$1" svc="$2" colour="$3" api t body url st n=0
    api="$(cd_traefik_api 2>/dev/null)" || return 4
    t="$(_cd_watch_ct)" || return 4
    body="$(curl -fsS --max-time "$t" "${api}/api/http/services/${name}" </dev/null 2>/dev/null)" || return 4
    printf '%s' "$body" | jq -e 'type == "object"' >/dev/null 2>&1 || return 4
    while IFS= read -r url; do
        [[ -n "$url" ]] || continue
        n=$((n + 1))
        [[ "$url" == "http://${svc}-${colour}:3000" ]] || return 1
        st="$(printf '%s' "$body" | jq -r --arg u "$url" '.serverStatus[$u] // "none"' 2>/dev/null)" || st=none
        [[ "$st" == UP ]] || return 1
    done < <(printf '%s' "$body" | jq -r '.loadBalancer.servers[]?.url // empty' 2>/dev/null)
    ((n > 0))
}

# -- the old colour (the evidence of the pause rule) -------------------------------------

# _cd_watch_old_ready OLD - 0 when the old colour answers ready through the loopback route
# app-next@file, which after a switch names the OLD colour (F8): the route names that colour
# and is UP, and the public ready-only answer is 200 with {"ready":true}. 1 when not.
_cd_watch_old_ready() {
    local old="$1" port t out code body
    port="$(_cd_watch_state_env INTERNALTEST_PORT)" || return 1
    [[ "$port" =~ ^[0-9]{1,5}$ ]] || return 1
    _cd_watch_route app-next@file gremion-ui "$old" || return 1
    t="$(_cd_watch_ct)" || return 1
    out="$(curl -sS --max-time "$t" -H 'Host: cd-readiness.invalid' -w $'\n%{http_code}' "http://127.0.0.1:${port}/readyz" </dev/null 2>/dev/null)" || return 1
    code="${out##*$'\n'}"
    body="${out%$'\n'*}"
    [[ "$code" == 200 ]] || return 1
    printf '%s' "$body" | jq -e '. == {"ready": true}' >/dev/null 2>&1
}

# -- the baseline ---------------------------------------------------------------------

# cd_watch_baseline - see the header. The 5xx baseline is the RAW count over CD_BASELINE_S;
# the rule scales it to the real elapsed time when it compares (as data.sh's live signal does).
cd_watch_baseline() {
    local colour t span now ans nr base rc=0 rid
    rid="$(cd_state_get '.release.id // empty')" || return 2
    [[ -n "$rid" ]] || { _cd_watch_err "baseline: there is no release in the state"; return 2; }
    colour="$(cd_state_get '.live.colour // empty')" || return 2
    [[ "$colour" == blue || "$colour" == green ]] || { _cd_watch_err "baseline: there is no live colour in the state"; return 2; }
    t="$(_cd_watch_ct)" || return 2
    span="$(_cd_watch_int CD_BASELINE_S)" || return 2
    ans="$(CD_COLOUR_EXEC_TIMEOUT_S="$t" cd_colour_probe "$colour")" || rc=$?
    if [[ "$rc" -ne 0 ]]; then
        _cd_watch_err "baseline: the live colour did not answer; no baseline is written"
        return 4
    fi
    nr="$(printf '%s' "$ans" | jq -r 'if (.tenants.notReady | type) == "number" and .tenants.notReady >= 0 and (.tenants.notReady | floor) == .tenants.notReady then (.tenants.notReady | tostring) else empty end' 2>/dev/null)" || nr=''
    [[ "$nr" =~ ^[0-9]{1,9}$ ]] || { _cd_watch_err "baseline: the live colour gave no tenant count; no baseline is written"; return 4; }
    now="$(cd_now)" || return 2
    base="$(cd_watch_accesslog_count "$((now - span))" 2>/dev/null)" || base=null
    [[ "$base" == null || "$base" =~ ^[0-9]{1,9}$ ]] || base=null
    cd_state_set '.release.watch = ({observed_s: 0, samples: 0, bad_streak: 0, paused_s: 0, blind: 0, requests: 0, last_sample_epoch: 0}
        + (.release.watch // {}) + {baseline_5xx: $b, baseline_not_ready: $n})' \
        --argjson b "$base" --argjson n "$((10#$nr))" || return 2
    cd_hist watch_baseline not_ready="$((10#$nr))" log_readable="$([[ "$base" == null ]] && echo 0 || echo 1)" || true
    return 0
}

# -- the sample -----------------------------------------------------------------------

# _cd_watch_rcb RC - prints true when RC is 0 and false otherwise (a JSON boolean from a code).
_cd_watch_rcb() { if [[ "${1:-1}" -eq 0 ]]; then printf 'true'; else printf 'false'; fi; }

# _cd_watch_containers COLOUR - prints "<known> <total> <bad> <restarts>" of every container
# of the colour's project, every state: bad is a container that is not running and healthy,
# except a one-shot that exited 0; restarts is the sum of the restart counts. known is 0 when
# docker did not answer.
_cd_watch_containers() {
    local colour="$1" proj cids cid line st code health rs total=0 bad=0 restarts=0
    proj="$(_cd_docker_proj "app-${colour}" cd_watch 2>/dev/null)" || { printf '0 0 0 0'; return 0; }
    cids="$(docker ps -a -q --filter "label=com.docker.compose.project=${proj}" \
        --filter "label=com.docker.compose.oneoff=False" </dev/null 2>/dev/null)" || { printf '0 0 0 0'; return 0; }
    while IFS= read -r cid; do
        [[ -n "$cid" ]] || continue
        line="$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}} {{if .State.Health}}{{.State.Health.Status}}{{else}}nohealthcheck{{end}} {{.RestartCount}}' "$cid" </dev/null 2>/dev/null)" || { printf '0 0 0 0'; return 0; }
        read -r st code health rs <<<"$line"
        [[ "$st" =~ ^[a-z]+$ && "$code" =~ ^[0-9]+$ && "$rs" =~ ^[0-9]+$ ]] || { printf '0 0 0 0'; return 0; }
        total=$((total + 1))
        restarts=$((restarts + 10#$rs))
        if [[ "$st" == running && ( "$health" == healthy || "$health" == nohealthcheck ) ]]; then
            continue
        elif [[ "$st" == exited && "$code" == 0 ]]; then
            continue
        fi
        bad=$((bad + 1))
    done <<<"$cids"
    printf '1 %s %s %s' "$total" "$bad" "$restarts"
}

# _cd_watch_sample_run [COLOUR TAG TREE] - the body of cd_watch_sample (runs in a subshell).
_cd_watch_sample_run() {
    local colour="${1:-}" tag="${2:-}" tree="${3:-}" t start at old sw_epoch
    local st_ok=false api_ok=false docker_ok=false pub_out pub_rc=0 ready login pub_ok
    local ans portal_rc=0 ident_rc=0 w_new w_old route_ok=false route_known=true r1 r2
    local cont known total bad restarts since window n req old_ok=false timed_out=false
    local int_json='{"answered":false,"ready":false,"colour":"","release":"","not_ready":null}'
    local iw f_col f_tag f_tree f_sw
    t="$(_cd_watch_int CD_SAMPLE_TIMEOUT_S)" || return 2
    start="$(cd_now)" || return 2
    at="$start"
    CD_WATCH_DEADLINE=$((start + t))
    _CD_WATCH_REAL_DOCKER="$(type -P docker || true)"
    # every docker call of this sample (and of the docker.sh functions it calls) is bounded
    docker() {
        local ct
        [[ -n "$_CD_WATCH_REAL_DOCKER" ]] || return 127
        ct="$(_cd_watch_ct)" || return 124
        timeout -k 2 "$ct" "$_CD_WATCH_REAL_DOCKER" "$@"
    }
    iw="$(cd_state_get '[.release.id // "", .release.colour // "", .release.tag // "", .release.tree // "", .release.switched_at // ""] | join("|")')" || return 2
    # the release fields in one go: id, colour, tag, tree, switched_at
    IFS='|' read -r _ f_col f_tag f_tree f_sw <<<"$iw"
    [[ -n "$colour" ]] || colour="$f_col"
    [[ -n "$tag" ]] || tag="$f_tag"
    [[ -n "$tree" ]] || tree="$f_tree"
    [[ "$colour" == blue || "$colour" == green ]] || { _cd_watch_err "sample: there is no colour to sample"; return 2; }
    old="$(cd_colour_other "$colour")" || return 2
    sw_epoch=0
    if [[ -n "$f_sw" ]]; then sw_epoch="$(date -u -d "$f_sw" +%s 2>/dev/null)" || sw_epoch=0; fi
    [[ "$sw_epoch" =~ ^[0-9]{1,12}$ ]] || sw_epoch=0

    # 1. the shared services first: a hung app probe must not starve the paused-or-bad decision
    if [[ -n "$tree" && -d "$tree" ]]; then
        if CD_DC_TIMEOUT="$t" cd_wait_healthy state 0 "$tree" >/dev/null 2>&1; then st_ok=true; fi
    fi
    if _cd_watch_api_up; then api_ok=true; fi
    # 2. the containers of the colour
    cont="$(_cd_watch_containers "$colour")"
    read -r known total bad restarts <<<"$cont"
    [[ "$known" == 1 ]] && docker_ok=true
    # 3. the probes: the public one through the edge, the internal one inside the container
    pub_out="$(cd_watch_probe_public)" || pub_rc=$?
    read -r ready login <<<"${pub_out:-000 000}"
    [[ "$ready" =~ ^[0-9]{3}$ ]] || ready=000
    [[ "$login" =~ ^[0-9]{3}$ ]] || login=000
    pub_ok="$(_cd_watch_rcb "$pub_rc")"
    if [[ "$ready" == 000 || "$login" == 000 ]]; then timed_out=true; fi
    if ans="$(CD_COLOUR_EXEC_TIMEOUT_S="$(_cd_watch_ct || echo 1)" cd_colour_probe "$colour" 2>/dev/null)"; then
        int_json="$(printf '%s' "$ans" | jq -c '{answered: true, ready: (.ready == true), colour: (.colour | tostring), release: (.release | tostring), not_ready: .tenants.notReady}' 2>/dev/null)" \
            || int_json='{"answered":false,"ready":false,"colour":"","release":"","not_ready":null}'
    fi
    # 4. the route: app@file and public@file name the colour and are UP
    r1=0
    _cd_watch_route app@file gremion-ui "$colour" || r1=$?
    r2=0
    _cd_watch_route public@file gremion-public "$colour" || r2=$?
    [[ "$r1" -eq 4 || "$r2" -eq 4 ]] && route_known=false
    [[ "$r1" -eq 0 && "$r2" -eq 0 ]] && route_ok=true
    # 5. the portal page, the image identity
    CD_COLOUR_EXEC_TIMEOUT_S="$(_cd_watch_ct || echo 1)" cd_colour_portal_probe "$colour" >/dev/null 2>&1 || portal_rc=$?
    if [[ -n "$tag" ]]; then
        cd_colour_identity "$colour" "$tag" >/dev/null 2>&1 || ident_rc=$?
    else
        ident_rc=2
    fi
    # 6. the worker gate files, as the host holds them
    w_new="$(cd_colour_workers "$colour" get 2>/dev/null)" || w_new=unknown
    w_old="$(cd_colour_workers "$old" get 2>/dev/null)" || w_old=unknown
    [[ "$w_new" == on || "$w_new" == off ]] || w_new=unknown
    [[ "$w_old" == on || "$w_old" == off ]] || w_old=unknown
    # 7. the 5xx count of the window, which never reaches back before the switch: the names
    # app@file and public@file are the same for both colours
    since=$((at - $(_cd_watch_int CD_5XX_WINDOW_S)))
    ((sw_epoch > since)) && since=$sw_epoch
    window=$((at - since))
    ((window >= 1)) || window=1
    n=null
    req=null
    if cont="$(_cd_watch_scan "$since" 2>/dev/null)"; then
        read -r n req <<<"$cont"
    else
        n=null
        req=null
    fi
    # 8. the old colour through the next route: the evidence of the pause rule
    _cd_watch_old_ready "$old" && old_ok=true
    [[ -z "${CD_WATCH_DEADLINE:-}" ]] || { (($(cd_now) < CD_WATCH_DEADLINE)) || timed_out=true; }
    jq -cn \
        --argjson at "$at" --argjson dur "$(($(cd_now) - start))" --arg colour "$colour" --arg tag "$tag" --arg old "$old" \
        --arg ready "$ready" --arg login "$login" --argjson pub_ok "$pub_ok" --argjson internal "$int_json" \
        --argjson route_known "$route_known" --argjson route_ok "$route_ok" \
        --argjson ident_ok "$(_cd_watch_rcb "$ident_rc")" --argjson portal_ok "$(_cd_watch_rcb "$portal_rc")" \
        --argjson known "$docker_ok" --argjson total "${total:-0}" --argjson bad "${bad:-0}" --argjson restarts "${restarts:-0}" \
        --argjson n "$n" --argjson req "$req" --argjson window "$window" \
        --arg w_new "$w_new" --arg w_old "$w_old" --argjson old_ok "$old_ok" \
        --argjson st_ok "$st_ok" --argjson api_ok "$api_ok" --argjson timed_out "$timed_out" '
        {v: 1, at: $at, duration_s: $dur, colour: $colour, tag: $tag, old_colour: $old,
         public: {readyz: $ready, login: $login, ok: $pub_ok},
         internal: $internal,
         route: {known: $route_known, ok: $route_ok},
         identity: {ok: $ident_ok},
         portal: {ok: $portal_ok},
         containers: {known: $known, total: $total, bad: $bad, restarts: $restarts},
         fivexx: $n, requests: $req, window_s: $window,
         workers: {new: $w_new, old: $w_old},
         old_ready: $old_ok,
         shared: {state_ok: $st_ok, traefik_ok: $api_ok, docker_ok: $known},
         timed_out: $timed_out}'
}

# cd_watch_sample [COLOUR TAG TREE] - one JSON sample on stdout; 2 when there is no release
# (or no colour) to sample. It never decides anything: cd_watch_eval does.
cd_watch_sample() {
    ( _cd_watch_sample_run "$@" )
}

# -- the evaluation -------------------------------------------------------------------

# _cd_watch_sidecar_file
_cd_watch_sidecar_file() { printf '%s' "${CD_DATA}/watch-eval.json"; }

# cd_watch_eval SAMPLE_JSON - see the header. Needs the cd lock (it writes the state).
cd_watch_eval() {
    local sample="${1:-}" rid f st sc
    local at colour tag old_colour interval failn min5 factor span cap_s
    local observed samples streak paused blind requests last base5 basenr
    local grace restarts_base last_dur counted gap resume=0 timed_out
    local pub_ok int_ok route_ok ident_ok portal_ok cont_known cont_bad cont_restarts shared_ok=true
    local ready_fail=false crash=false hit5=false new_not_ready=false old_ready n window w_new w_old
    local verdict extra='' delta mail_blind=false mail_paused=false req failing=false
    [[ -n "$sample" ]] || { _cd_watch_err "eval: no sample"; return 2; }
    printf '%s' "$sample" | jq -e '
        type == "object" and .v == 1 and (.at | type) == "number"
        and (.colour | IN("blue", "green")) and (.old_colour | IN("blue", "green"))
        and (.public.ok | type) == "boolean" and (.internal.answered | type) == "boolean"
        and (.route.ok | type) == "boolean" and (.identity.ok | type) == "boolean"
        and (.portal.ok | type) == "boolean" and (.containers.known | type) == "boolean"
        and (.shared.state_ok | type) == "boolean" and (.shared.traefik_ok | type) == "boolean"
        and (.workers.new | type) == "string" and (.workers.old | type) == "string"
        and (.timed_out | type) == "boolean" and (.window_s | type) == "number"' >/dev/null 2>&1 \
        || { _cd_watch_err "eval: the sample is not a sample"; return 2; }
    interval="$(_cd_watch_int CD_WATCH_INTERVAL_S)" || return 2
    failn="$(_cd_watch_int CD_FAIL_SAMPLES)" || return 2
    min5="$(_cd_watch_int CD_5XX_MIN)" || return 2
    factor="$(_cd_watch_int CD_5XX_FACTOR)" || return 2
    span="$(_cd_watch_int CD_BASELINE_S)" || return 2
    cap_s=$(($(_cd_watch_int CD_PAUSE_MAX_MIN) * 60))
    st="$(cd_state_get '[.release.id // "", (.release.watch.observed_s // 0), (.release.watch.samples // 0), (.release.watch.bad_streak // 0), (.release.watch.paused_s // 0), (.release.watch.blind // 0), (.release.watch.requests // 0), (.release.watch.last_sample_epoch // 0), (.release.watch.baseline_5xx | if . == null then "null" else tostring end), (.release.watch.baseline_not_ready | if . == null then "null" else tostring end)] | map(tostring) | join("|")')" || return 2
    IFS='|' read -r rid observed samples streak paused blind requests last base5 basenr <<<"$st"
    [[ -n "$rid" ]] || { _cd_watch_err "eval: there is no release in the state"; return 2; }
    observed="${observed%.*}"
    paused="${paused%.*}"
    [[ "$observed" =~ ^[0-9]+$ && "$samples" =~ ^[0-9]+$ && "$streak" =~ ^[0-9]+$ && "$paused" =~ ^[0-9]+$ && "$blind" =~ ^[0-9]+$ && "$requests" =~ ^[0-9]+$ && "$last" =~ ^[0-9]+$ ]] \
        || { _cd_watch_err "eval: the watch counters of the state are not numbers"; return 2; }
    f="$(printf '%s' "$sample" | jq -r '[.at, .colour, .tag, .old_colour, (.timed_out | tostring), (.public.ok | tostring), (.route.ok | tostring), (.identity.ok | tostring), (.portal.ok | tostring), (.containers.known | tostring), (.containers.bad // 0), (.containers.restarts // 0), (.window_s), (.fivexx | if . == null then "null" else tostring end), (.requests | if . == null then "null" else tostring end), .workers.new, .workers.old, (.old_ready | if . == true then "true" else "false" end)] | map(tostring) | join("|")')"
    IFS='|' read -r at colour tag old_colour timed_out pub_ok route_ok ident_ok portal_ok cont_known cont_bad cont_restarts window n req w_new w_old old_ready <<<"$f"
    [[ "$at" =~ ^[0-9]{1,12}$ && "$cont_bad" =~ ^[0-9]+$ && "$cont_restarts" =~ ^[0-9]+$ && "$window" =~ ^[0-9]+$ ]] || { _cd_watch_err "eval: the sample carries a bad number"; return 2; }
    ((window >= 1)) || window=1
    # the internal answer: ready, the colour and the release asked for, no more tenants not
    # ready than the live colour had. A baseline that was never taken cannot be compared with.
    int_ok=false
    if printf '%s' "$sample" | jq -e --arg c "$colour" --arg t "$tag" --arg b "$basenr" '
        .internal.answered == true and .internal.ready == true and .internal.colour == $c and .internal.release == $t
        and (.internal.not_ready | type) == "number" and ($b | test("^[0-9]+$")) and .internal.not_ready <= ($b | tonumber)' >/dev/null 2>&1; then
        int_ok=true
    fi
    [[ "$cont_known" == true && "$cont_bad" -eq 0 ]] || ready_fail=true
    [[ "$pub_ok" == true && "$int_ok" == true && "$route_ok" == true && "$ident_ok" == true && "$portal_ok" == true ]] || ready_fail=true
    [[ "$pub_ok" == true && "$int_ok" == true ]] || new_not_ready=true
    printf '%s' "$sample" | jq -e '.shared.state_ok == true and .shared.traefik_ok == true and .shared.docker_ok == true' >/dev/null 2>&1 || shared_ok=false

    # -- the sidecar: the restart baseline, the grace after a resume, the last duration
    sc="$(_cd_watch_sidecar_file)"
    grace=0
    restarts_base=''
    last_dur=0
    if [[ -r "$sc" ]]; then
        f="$(jq -r --arg r "$rid" 'select(.v == 1 and .release == $r) | [(.grace // 0), (.restarts // ""), (.last_duration_s // 0)] | map(tostring) | join("|")' "$sc" 2>/dev/null)" || f=''
        [[ -z "$f" ]] || IFS='|' read -r grace restarts_base last_dur <<<"$f"
    fi
    [[ "$grace" =~ ^[0-9]+$ ]] || grace=0
    [[ "$last_dur" =~ ^[0-9]+$ ]] || last_dur=0
    [[ "$restarts_base" =~ ^[0-9]+$ ]] || restarts_base=''

    # -- time: the real gap counts when it is at most twice the interval; a timed-out sample
    # adds at most the interval; a gap that is mostly idle time is a resume (the reboot rule)
    gap=0
    counted=0
    if ((last > 0 && at > last)); then
        gap=$((at - last))
        if ((gap <= 2 * interval)); then
            counted=$gap
            [[ "$timed_out" == true ]] && ((counted > interval)) && counted=$interval
        fi
        if ((gap - last_dur > 2 * interval)); then
            grace=$_CD_WATCH_GRACE_SAMPLES
            resume=1
        fi
    fi

    # -- what failed
    if [[ -z "$restarts_base" ]]; then
        restarts_base=$cont_restarts
    elif ((cont_restarts < restarts_base)); then
        restarts_base=$cont_restarts
    fi
    delta=$((cont_restarts - restarts_base))
    [[ "$cont_known" == true ]] && ((delta >= 2)) && crash=true
    if [[ "$n" == null ]]; then
        blind=$((blind + 1))
        extra+=$'\nblind'
        ((blind == _CD_WATCH_BLIND_WARN)) && mail_blind=true
    else
        blind=0
        if ((n >= min5)) && { [[ "$base5" == null ]] || ((n * span >= factor * base5 * window)); }; then hit5=true; fi
        requests=0
        [[ "$req" =~ ^[0-9]+$ ]] && requests=$req
    fi

    # -- the verdict. Order: the reboot rule, the shared services, the crash, the 5xx, the
    # readiness streak
    [[ "$ready_fail" == true || "$crash" == true || "$hit5" == true ]] && failing=true
    verdict=ok
    [[ "$ready_fail" == true ]] || streak=0
    if [[ "$failing" == false ]]; then
        observed=$((observed + counted))
    elif [[ "$shared_ok" == false ]]; then
        # a failing sample while a shared service is down is nobody's fault but the outage: the
        # observed clock stops and the paused clock runs, up to the cap
        paused=$((paused + counted))
        if ((paused >= cap_s)); then
            if [[ "$old_ready" == true && "$new_not_ready" == true ]]; then
                verdict=trigger:watch_pause_cap
            else
                verdict=parked
            fi
        else
            verdict=paused
            mail_paused=true
        fi
    elif ((grace > 0)); then
        observed=$((observed + counted))
        verdict=bad
    else
        observed=$((observed + counted))
        [[ "$ready_fail" == true ]] && streak=$((streak + 1))
        if [[ "$crash" == true ]]; then
            verdict=trigger:watch_crash
        elif [[ "$hit5" == true ]]; then
            verdict=trigger:watch_5xx
        elif [[ "$ready_fail" == true ]]; then
            if ((streak >= failn)); then verdict=trigger:watch_readiness; else verdict=bad; fi
        fi
    fi
    ((grace > 0)) && grace=$((grace - 1))
    samples=$((samples + 1))

    # -- the worker gate files: old off first, then new on; never on a trigger or a park
    case "$verdict" in
        trigger:* | parked) ;;
        *)
            [[ "$w_old" == on ]] && extra+=$'\n'"flip ${old_colour} off"
            [[ "$w_new" == off ]] && extra+=$'\n'"flip ${colour} on"
            ;;
    esac

    cd_state_set '.release.watch = ((.release.watch // {}) + {observed_s: $o, samples: $s, bad_streak: $b, paused_s: $p, blind: $bl, requests: $rq, last_sample_epoch: $at})' \
        --argjson o "$observed" --argjson s "$samples" --argjson b "$streak" --argjson p "$paused" --argjson bl "$blind" \
        --argjson rq "$requests" --argjson at "$at" || return 2
    cd_mkdir "$CD_DATA" || return 2
    jq -cn --arg r "$rid" --argjson g "$grace" --argjson rs "$restarts_base" --argjson d "$(printf '%s' "$sample" | jq -r '.duration_s // 0 | floor')" \
        '{v: 1, release: $r, grace: $g, restarts: $rs, last_duration_s: $d}' | cd_atomic_write "$sc" 600 || return 2

    case "$verdict" in
        ok | bad) ;;
        *) cd_hist watch_verdict verdict="${verdict//:/_}" observed_s="$observed" paused_s="$paused" streak="$streak" resume="$resume" || true ;;
    esac
    if [[ "$mail_paused" == true ]]; then
        cd_notify paused "key=paused-${rid//[^A-Za-z0-9_.-]/_}" "sha12=${rid%%-*}" "colour=${colour}" stage=watch rule=none \
            "observed_min=$((observed / 60))" "paused_min=$((paused / 60))" "requests=${requests}" \
            "fivexx=$([[ "$n" == null ]] && echo 0 || echo "$n")" || true
    fi
    if [[ "$mail_blind" == true ]]; then
        cd_notify paused "key=blind-${rid//[^A-Za-z0-9_.-]/_}" "sha12=${rid%%-*}" "colour=${colour}" stage=watch rule=none \
            "observed_min=$((observed / 60))" "paused_min=$((paused / 60))" "requests=${requests}" || true
    fi
    printf '%s%s\n' "$verdict" "$extra"
    return 0
}
