#!/usr/bin/env bash
# infra/host/lib/cd/traffic.sh - the forward switch of the continuous deployment program:
# move the edge to a colour, read what the edge really does, and confirm it.
#
# SOURCED, NEVER EXECUTED. Like colour.sh it sets no shell options and runs nothing at the
# top level. It calls core.sh (cd_state_get, cd_state_set, cd_stage_fail, cd_hist, cd_cfg)
# and docker.sh (cd_envfile, cd_kv_get, cd_traefik_api, cd_traefik_service) when they exist,
# and curl, jq, timeout and coreutils. It never calls docker.
#
# WHAT IS HERE
#   cd_traffic_switch TREE COLOUR  record release.switch_started in the state, THEN run the
#                                  gremion-switch of TREE with `--no-evict`, the edge template of
#                                  TREE and TRAEFIK_API=http://127.0.0.1:<TRAEFIK_API_PORT of
#                                  state.env>. The call is bounded and its output goes to a 0600
#                                  file under logs/. A failed call, a call that ran out of time and
#                                  an exit 0 that left runtime/active-colour on another colour are
#                                  all a failure (1): the edge may already route to COLOUR (the
#                                  program writes the edge file first and polls afterwards), so
#                                  the colour project is never touched here, switch_started stays
#                                  true, and for the release's own colour the state is told
#                                  (release.failure: stage switch, kind commit, code
#                                  switch_failed) for the driver. A switch BACK (a colour other
#                                  than release.colour) leaves the failure record and the stage of
#                                  the release alone. 2 when a precondition is missing (nothing is
#                                  written, nothing is called).
#   cd_traffic_truth               the colour the running system serves, from runtime/active-colour
#                                  AND the Traefik API (app@file and public@file). Prints that
#                                  one colour and returns 0 when they agree; returns 1 and prints
#                                  `file=<c> app=<c|other> public=<c|other>` when they do not; 2
#                                  when the file cannot be read; 4 when Traefik gives no answer.
#                                  It reads no state and no config: it is what a resume asks.
#   cd_traffic_confirm COLOUR      the post-condition of a switch, read from the running system:
#                                  runtime/active-colour is COLOUR; app@file and public@file point
#                                  at COLOUR; when CONTROL_PANEL_ORIGIN is set in state.env,
#                                  panel@file points at COLOUR and its server is UP; and the
#                                  router graph is clean (a port of gremion-verify check_routers:
#                                  every router that is not Traefik's own is enabled, no rule has
#                                  an empty Host(); an empty list fails, a truncated list is
#                                  refused). The same call confirms the old colour after a
#                                  switch back. It writes nothing.
#
# RETURN CODES. 0 ok, 1 an assertion failed (attributable to the release), 2 usage or a missing
# precondition (a tool, a file, a key, an unreadable file), 4 the Traefik API did not answer.
# Unknown is never success. A failed confirm leaves one short code in CD_TRAFFIC_REASON (check
# names only, never a router, a rule, a host or a slug: the router list names customers). Call
# the function directly, not in $(...), to keep the variable.
#
# Not here, on purpose: the worker gate moves (U7), the readiness probes through the real edge
# (U9), the stage records and the choice between rollback and teardown (the driver, U14a, and
# U8b). release.switched_at is not written here.

# shellcheck disable=SC2016,SC2034  # the jq programs are single-quoted on purpose; CD_TRAFFIC_REASON is read by the caller

CD_TRAFFIC_REASON=''

# How long one gremion-switch call may take (its own Traefik poll is 10 seconds), and the page
# size of the router list (gremion-verify uses the same figure).
_CD_TRAFFIC_SWITCH_TIMEOUT_S=120
_CD_TRAFFIC_PER_PAGE=10000

_cd_traffic_err() { printf 'cd-traffic: %s\n' "$*" >&2; }

_cd_traffic_root() { printf '%s' "${GREMION_ROOT:-/opt/gremion}"; }

# _cd_traffic_fail REASON RC [MESSAGE] - record the reason, say it once, return RC.
_cd_traffic_fail() {
    CD_TRAFFIC_REASON="${1:-failed}"
    _cd_traffic_err "${3:-${1:-failed}}"
    return "${2:-1}"
}

_cd_traffic_check_colour() {
    case "${1:-}" in
        blue | green) return 0 ;;
        *) _cd_traffic_err "${2:-cd_traffic}: the colour is blue or green"; return 2 ;;
    esac
}

# _cd_traffic_int VALUE DEFAULT - VALUE when it is a whole number from 1 to 3600, else DEFAULT.
_cd_traffic_int() {
    if [[ "${1:-}" =~ ^[0-9]{1,4}$ ]] && [[ "$((10#$1))" -ge 1 && "$((10#$1))" -le 3600 ]]; then
        printf '%s' "$((10#$1))"
    else
        printf '%s' "$2"
    fi
}

# _cd_traffic_timeout - the bound of one Traefik API call: CD_SAMPLE_TIMEOUT_S, 10 without it.
_cd_traffic_timeout() {
    local v=''
    v="$(cd_cfg CD_SAMPLE_TIMEOUT_S 2>/dev/null)" || v=''
    _cd_traffic_int "$v" 10
}

# _cd_traffic_logfile NAME - a new 0600 file under logs/ for the output of a child program;
# prints its path. The journal gets the file NAME only.
_cd_traffic_logfile() {
    local dir f
    dir="$(_cd_traffic_root)/logs"
    mkdir -p -- "$dir" 2>/dev/null || true
    f="$(umask 077; mktemp "${dir}/cd-${1}-XXXXXX.log" 2>/dev/null)" || {
        _cd_traffic_err "cannot create a log file under logs/"
        return 2
    }
    printf '%s' "$f"
}

# _cd_traffic_active_file - the colour runtime/active-colour names. 2 when it cannot be read or
# names neither colour.
_cd_traffic_active_file() {
    local f act
    f="$(_cd_traffic_root)/runtime/active-colour"
    if [[ ! -f "$f" || ! -r "$f" ]]; then
        _cd_traffic_err "runtime/active-colour is not readable"
        return 2
    fi
    act="$(head -n 1 -- "$f" 2>/dev/null)" || act=''
    act="${act%$'\r'}"
    case "$act" in
        blue | green) printf '%s' "$act" ;;
        *) _cd_traffic_err "runtime/active-colour names neither colour"; return 2 ;;
    esac
}

# _cd_traffic_inspect NAME SVC - what the Traefik service NAME does. Sets _CT_COLOUR to the
# colour every server of it points at (http://SVC-<colour>:3000), `other` when a server is
# anything else or the servers disagree or there is none, and _CT_UP to 1 when every server is
# reported UP (else 0). Returns 4 when the API gave no answer.
_cd_traffic_inspect() {
    local name="$1" svc="$2" body u c n=0 st
    _CT_COLOUR=other
    _CT_UP=0
    body="$(cd_traefik_service "$name" 2>/dev/null </dev/null)" || return 4
    local colour='' up=1
    while IFS= read -r u; do
        [[ -n "$u" ]] || continue
        n=$((n + 1))
        if [[ "$u" =~ ^http://${svc}-(blue|green):3000$ ]]; then
            c="${BASH_REMATCH[1]}"
        else
            c=other
        fi
        if [[ -z "$colour" ]]; then
            colour="$c"
        elif [[ "$colour" != "$c" ]]; then
            colour=other
        fi
        st="$(printf '%s' "$body" | jq -r --arg u "$u" '.serverStatus[$u] // "none"' 2>/dev/null)" || st=none
        [[ "$st" == UP ]] || up=0
    done < <(printf '%s' "$body" | jq -r '.loadBalancer.servers[]?.url // empty' 2>/dev/null)
    if ((n > 0)) && [[ -n "$colour" ]]; then
        _CT_COLOUR="$colour"
        _CT_UP="$up"
    fi
    return 0
}

# -- the switch ------------------------------------------------------------------

cd_traffic_switch() {
    local tree="${1:-}" colour="${2:-}" prog tmpl api root rid rcol t log rc=0 why='' forward=0 act
    [[ "$#" -eq 2 ]] || { _cd_traffic_err "cd_traffic_switch: usage: TREE COLOUR"; return 2; }
    _cd_traffic_check_colour "$colour" cd_traffic_switch || return 2
    [[ "$tree" == /* && -d "$tree" ]] || { _cd_traffic_err "cd_traffic_switch: the release tree is not an absolute directory"; return 2; }
    prog="${tree}/infra/host/bin/gremion-switch"
    tmpl="${tree}/infra/host/templates/edge/active.yml.tmpl"
    [[ -f "$prog" && -x "$prog" ]] || { _cd_traffic_err "cd_traffic_switch: the release tree has no executable gremion-switch"; return 2; }
    [[ -f "$tmpl" ]] || { _cd_traffic_err "cd_traffic_switch: the release tree has no edge template"; return 2; }
    api="$(cd_traefik_api)" || return 2
    t="$(_cd_traffic_int "${CD_TRAFFIC_SWITCH_TIMEOUT_S:-}" "$_CD_TRAFFIC_SWITCH_TIMEOUT_S")"
    root="$(_cd_traffic_root)"
    rid="$(cd_state_get '.release.id // empty')" || return 2
    [[ -n "$rid" ]] || { _cd_traffic_err "cd_traffic_switch: there is no release in the state"; return 2; }
    rcol="$(cd_state_get '.release.colour // empty')" || return 2
    [[ "$rcol" == "$colour" ]] && forward=1
    log="$(_cd_traffic_logfile "switch-${colour}")" || return 2

    # THE LINE: from this write on, whatever the call does, the edge may route to COLOUR. The
    # write also needs the cd lock, so a caller without it stops here, before the call.
    cd_state_set '.release.switch_started = true' || return 2
    cd_hist switch_started colour="$colour" || true

    # No stdin, and neither lock descriptor: a grandchild that outlives a timeout must not keep
    # the cd lock or the host lock after this process lets go.
    GREMION_ROOT="$root" GREMION_EDGE_TEMPLATE="$tmpl" TRAEFIK_API="$api" \
        timeout -k 5 "$t" "$prog" "$colour" --no-evict >"$log" 2>&1 </dev/null 8>&- 9>&- || rc=$?

    if [[ "$rc" -eq 0 ]]; then
        # the post-condition, not the exit code: the program writes the file last
        act="$(_cd_traffic_active_file 2>/dev/null)" || act=''
        if [[ "$act" != "$colour" ]]; then
            why="answered 0 but runtime/active-colour does not name the ${colour} colour"
            rc=1
        fi
    elif [[ "$rc" -eq 124 || "$rc" -eq 137 ]]; then
        why="ran out of time"
    else
        why="failed"
    fi

    if [[ "$rc" -ne 0 ]]; then
        _cd_traffic_err "gremion-switch ${why} (exit ${rc}); its output is in logs/$(basename -- "$log")"
        cd_hist switch_failed colour="$colour" exit="$rc" forward="$forward" || true
        if [[ "$forward" -eq 1 ]]; then
            cd_stage_fail switch commit switch_failed || true
        fi
        CD_TRAFFIC_REASON=switch_failed
        return 1
    fi
    cd_hist switch_done colour="$colour" || true
    return 0
}

# -- the truth -------------------------------------------------------------------

cd_traffic_truth() {
    local act app pub
    act="$(_cd_traffic_active_file)" || return 2
    _cd_traffic_inspect app@file gremion-ui || { _cd_traffic_err "the Traefik API did not answer for app@file"; return 4; }
    app="$_CT_COLOUR"
    _cd_traffic_inspect public@file gremion-public || { _cd_traffic_err "the Traefik API did not answer for public@file"; return 4; }
    pub="$_CT_COLOUR"
    if [[ "$app" == "$act" && "$pub" == "$act" ]]; then
        printf '%s\n' "$act"
        return 0
    fi
    printf 'file=%s app=%s public=%s\n' "$act" "$app" "$pub"
    _cd_traffic_err "the active-colour file and the edge disagree (file ${act}, app ${app}, public ${pub})"
    return 1
}

# -- the confirm -----------------------------------------------------------------

# _cd_traffic_panel_opted_in - 0 when state.env sets CONTROL_PANEL_ORIGIN to something, 1 when it
# does not declare it or declares it empty, 2 when it cannot be told (no file, a declaration that
# is not one plain line, or two of them): a malformed opt-in must not silently skip the check.
_cd_traffic_panel_opted_in() {
    local f n v
    f="$(cd_envfile state)" || return 2
    [[ -f "$f" && -r "$f" ]] || { _cd_traffic_err "no readable state.env"; return 2; }
    n="$(grep -cE -- '^[[:space:]]*(export[[:space:]]+)?CONTROL_PANEL_ORIGIN[[:space:]]*[=:]' "$f")" || true
    case "${n:-0}" in
        0) return 1 ;;
        1) ;;
        *) _cd_traffic_err "state.env declares CONTROL_PANEL_ORIGIN more than once"; return 2 ;;
    esac
    v="$(cd_kv_get "$f" CONTROL_PANEL_ORIGIN 2>/dev/null)" || {
        _cd_traffic_err "the CONTROL_PANEL_ORIGIN of state.env is not a plain KEY=value line"
        return 2
    }
    [[ -n "${v//[[:space:]]/}" ]]
}

# _cd_traffic_routers - the router graph is clean. Port of gremion-verify check_routers: the
# list is read with a page size and a truncated one is refused; zero routers fail (nothing was
# checked); a router of provider @internal (Traefik's own) is not judged; every other router must
# be enabled and must not have an empty rule or an empty Host(). Failure names a check, never a
# router.
_cd_traffic_routers() {
    local api t hdr out len next verdict pp="$_CD_TRAFFIC_PER_PAGE"
    api="$(cd_traefik_api 2>/dev/null)" || return 2
    t="$(_cd_traffic_timeout)"
    hdr="$(mktemp 2>/dev/null)" || { _cd_traffic_err "cannot create a temporary file"; return 2; }
    if ! out="$(curl -fsS --max-time "$t" -D "$hdr" "${api}/api/http/routers?per_page=${pp}&page=1" </dev/null 2>/dev/null)"; then
        rm -f -- "$hdr"
        _cd_traffic_fail traefik_unreachable 4 "the Traefik API did not answer for the router list"
        return 4
    fi
    next="$(tr -d '\r' <"$hdr" | sed -n 's/^[Xx]-[Nn]ext-[Pp]age: *//p' | head -n 1)"
    rm -f -- "$hdr"
    len="$(printf '%s' "$out" | jq -r 'if type == "array" then length else "none" end' 2>/dev/null)" || len=none
    if ! [[ "$len" =~ ^[0-9]+$ ]]; then
        _cd_traffic_fail traefik_unreachable 4 "the router list is not a JSON list"
        return 4
    fi
    if ((len >= pp)) || [[ "$next" =~ ^[0-9]+$ && "$next" -gt 1 ]]; then
        _cd_traffic_fail routers_truncated 2 "the router list is truncated (raise the page size)"
        return 2
    fi
    verdict="$(printf '%s' "$out" | jq -r '
        [ .[] | select((.name // "") | endswith("@internal") | not) ] as $r
        | if ($r | length) == 0 then "no_routers"
          elif any($r[]; (.status // "missing") != "enabled") then "router_not_enabled"
          elif any($r[]; ((.rule // "") | test("^[[:space:]]*$"))
                      or ((.rule // "") | test("Host\\([[:space:]]*(`[[:space:]]*`|\"[[:space:]]*\")?[[:space:]]*\\)"))) then "router_empty_host"
          else "ok" end' 2>/dev/null)" || verdict=''
    case "$verdict" in
        ok) return 0 ;;
        no_routers) _cd_traffic_fail no_routers 1 "the router list is empty: nothing was checked"; return 1 ;;
        router_not_enabled) _cd_traffic_fail router_not_enabled 1 "a router of the edge is not enabled"; return 1 ;;
        router_empty_host) _cd_traffic_fail router_empty_host 1 "a router of the edge has an empty Host() rule"; return 1 ;;
        *) _cd_traffic_fail traefik_unreachable 4 "the router list could not be read"; return 4 ;;
    esac
}

cd_traffic_confirm() {
    local colour="${1:-}" act pair name svc want opt rc
    CD_TRAFFIC_REASON=''
    _cd_traffic_check_colour "$colour" cd_traffic_confirm || return 2
    act="$(_cd_traffic_active_file)" || { CD_TRAFFIC_REASON=active_colour_file; return 2; }
    if [[ "$act" != "$colour" ]]; then
        _cd_traffic_fail active_colour_file 1 "runtime/active-colour does not name the ${colour} colour"
        return 1
    fi
    for pair in app@file:gremion-ui:app public@file:gremion-public:public; do
        name="${pair%%:*}"
        svc="${pair#*:}"
        want="${svc#*:}"
        svc="${svc%%:*}"
        if ! _cd_traffic_inspect "$name" "$svc"; then
            _cd_traffic_fail traefik_unreachable 4 "the Traefik API did not answer for ${name}"
            return 4
        fi
        if [[ "$_CT_COLOUR" != "$colour" ]]; then
            _cd_traffic_fail "${want}_not_on_colour" 1 "${name} does not point at the ${colour} colour"
            return 1
        fi
    done
    rc=0
    _cd_traffic_panel_opted_in || rc=$?
    case "$rc" in
        0) opt=1 ;;
        1) opt=0 ;;
        *) CD_TRAFFIC_REASON=panel_opt_in; return 2 ;;
    esac
    if [[ "$opt" -eq 1 ]]; then
        if ! _cd_traffic_inspect panel@file control-panel; then
            _cd_traffic_fail traefik_unreachable 4 "the Traefik API did not answer for panel@file"
            return 4
        fi
        if [[ "$_CT_COLOUR" != "$colour" ]]; then
            _cd_traffic_fail panel_not_on_colour 1 "panel@file does not point at the ${colour} colour"
            return 1
        fi
        if [[ "$_CT_UP" -ne 1 ]]; then
            _cd_traffic_fail panel_down 1 "the panel server of the ${colour} colour is not UP"
            return 1
        fi
    fi
    rc=0
    _cd_traffic_routers || rc=$?
    return "$rc"
}
