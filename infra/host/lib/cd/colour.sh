#!/usr/bin/env bash
# infra/host/lib/cd/colour.sh - one app colour of the continuous deployment program:
# start it, prove what runs is the release, gate its readiness, probe it, gate its
# background workers, run the isolation evidence and verify, and take it down.
#
# SOURCED, NEVER EXECUTED. Like docker.sh it does not set shell options: the program
# that sources it owns them (the dispatcher loads every library of lib/cd/ in sorted
# order, so this file is read before docker.sh; nothing here runs at source time).
# It calls the functions of docker.sh (cd_dc, cd_wait_healthy, cd_svc_cid,
# cd_project_cids, cd_image_id, cd_kv_get, cd_envfile, cd_traefik_api,
# cd_traefik_service, cd_colour_other) and of core.sh (cd_now, cd_sleep, cd_cfg,
# cd_state_get, cd_hist) when they exist, and docker, curl, jq, timeout and coreutils.
#
# RETURN CODES of every public function (they return, none exits):
#   0 ok - 1 an assertion about the colour failed (attributable to the release) -
#   2 a usage error or a missing precondition (an env file or key, a tool, the
#   baseline, a tree) - 4 an infrastructure answer is missing (docker or the Traefik
#   API did not answer, so nothing can be said about the colour).
# Unknown is never success. A failed readiness layer leaves one short code in
# CD_COLOUR_REASON (names of checks only, never an id, a host or a slug) and says it
# once on stderr; call the function directly, not in $(...), to keep the variable.
#
# NO SECRET IS EVER READ HERE. The one secret a probe needs (INTERNAL_PUSH_SECRET)
# is read by node INSIDE the container; it reaches no argv and no environment of a
# command of this library. The output of the child programs (gremion-verify,
# gremion-isolation) names hosts and tables and goes to a 0600 file under logs/;
# only the file name is printed.
#
# The worker gate file (section 4 of the plan): runtime/workers/<colour>, the host
# side of the read-only bind mount that gremion-ui reads at every background tick.
# `off` stops the colour's jobs; absent, unreadable or any other content means on.

CD_COLOUR_REASON=''

_cd_colour_err() { printf 'cd-colour: %s\n' "$*" >&2; }

_cd_colour_root() { printf '%s' "${GREMION_ROOT:-/opt/gremion}"; }

# _cd_colour_fail REASON RC [MESSAGE] - record the reason, say it once, return RC.
_cd_colour_fail() {
    CD_COLOUR_REASON="${1:-failed}"
    _cd_colour_err "${3:-${1:-failed}}"
    return "${2:-1}"
}

_cd_colour_now() {
    local t=''
    if declare -F cd_now >/dev/null 2>&1; then
        t="$(cd_now 2>/dev/null)" || t=''
    fi
    if [[ "$t" =~ ^[0-9]+$ ]]; then
        printf '%s' "$t"
    else
        date +%s
    fi
}

_cd_colour_sleep() {
    if declare -F cd_sleep >/dev/null 2>&1; then
        cd_sleep "$1"
    else
        sleep "$1"
    fi
}

# _cd_colour_int VALUE DEFAULT - VALUE when it is a whole number, else DEFAULT.
_cd_colour_int() {
    if [[ "${1:-}" =~ ^[0-9]{1,6}$ ]]; then
        printf '%s' "$((10#$1))"
    else
        printf '%s' "$2"
    fi
}

_cd_colour_check_colour() {
    case "${1:-}" in
        blue | green) return 0 ;;
        *) _cd_colour_err "${2:-cd_colour}: the colour is blue or green"; return 2 ;;
    esac
}

# The tag of a release is pilot-<sha12> (the prefix is a constant of the program).
_cd_colour_check_tag() {
    [[ "${1:-}" =~ ^pilot-[0-9a-f]{12}$ ]] || {
        _cd_colour_err "${2:-cd_colour}: the tag is pilot-<12 hex>"
        return 2
    }
}

# _cd_colour_check_env COLOUR WHO - the env file of the colour exists and is readable.
_cd_colour_check_env() {
    local f
    f="$(cd_envfile "app-${1}")" || return 2
    [[ -f "$f" && -r "$f" ]] || {
        _cd_colour_err "${2:-cd_colour}: no readable env file for app-${1}"
        return 2
    }
    return 0
}

# _cd_colour_project COLOUR - the compose project name <stack>-app-<colour> from the
# env file (docker.sh's one resolver). Prints it; 2 when it cannot be resolved.
_cd_colour_project() {
    declare -F _cd_docker_proj >/dev/null 2>&1 || {
        _cd_colour_err "cd_colour: docker.sh is not loaded"
        return 2
    }
    _cd_docker_proj "app-${1}" cd_colour
}

# _cd_colour_logfile NAME - a new 0600 file under logs/ for the output of a child
# program; prints its path. The journal and stdout get the file NAME only.
_cd_colour_logfile() {
    local dir f
    dir="$(_cd_colour_root)/logs"
    mkdir -p -- "$dir" 2>/dev/null || true
    f="${dir}/cd-${1}-$(_cd_colour_now).log"
    ( umask 077; : >"$f" ) 2>/dev/null || { _cd_colour_err "cd_colour: cannot create a log file under logs/"; return 2; }
    printf '%s' "$f"
}

# -- the worker gate ----------------------------------------------------------

# The host directory of the gate files: the same source the compose mount reads.
_cd_colour_workers_dir() {
    printf '%s' "${GREMION_WORKERS_DIR:-$(_cd_colour_root)/runtime/workers}"
}

# cd_colour_workers COLOUR on|off|get - write or read runtime/workers/<colour>. A
# write is atomic (a temp file in the directory, then rename), mode 0644, and is
# read back; no docker call and no secret. `get` prints `off` only for a file whose
# content is exactly off (trailing whitespace ignored) and `on` for everything else:
# an absent file or directory, an unreadable file, any other content.
cd_colour_workers() {
    local colour="${1:-}" mode="${2:-}" dir f v tmp
    _cd_colour_check_colour "$colour" cd_colour_workers || return 2
    dir="$(_cd_colour_workers_dir)"
    f="${dir}/${colour}"
    case "$mode" in
        get)
            v=''
            if [[ -f "$f" && -r "$f" ]]; then
                v="$(head -c 16 -- "$f" 2>/dev/null)" || v=''
            fi
            v="${v%"${v##*[![:space:]]}"}"
            if [[ "$v" == off ]]; then
                printf 'off\n'
            else
                printf 'on\n'
            fi
            return 0
            ;;
        on | off) ;;
        *) _cd_colour_err "cd_colour_workers: usage: COLOUR on|off|get"; return 2 ;;
    esac
    if [[ ! -d "$dir" ]]; then
        if ! mkdir -p -- "$dir" 2>/dev/null || ! chmod 755 -- "$dir" 2>/dev/null; then
            _cd_colour_err "cd_colour_workers: cannot create the worker gate directory"
            return 2
        fi
    fi
    tmp="$(mktemp "${dir}/.${colour}.XXXXXX" 2>/dev/null)" || {
        _cd_colour_err "cd_colour_workers: cannot write in the worker gate directory"
        return 2
    }
    if ! printf '%s' "$mode" >"$tmp" || ! chmod 644 -- "$tmp" || ! mv -f -T -- "$tmp" "$f"; then
        rm -f -- "$tmp"
        _cd_colour_err "cd_colour_workers: cannot write the ${colour} gate file"
        return 2
    fi
    v="$(cd_colour_workers "$colour" get)" || v=''
    [[ "$v" == "$mode" ]] || {
        _cd_colour_err "cd_colour_workers: the ${colour} gate file does not read back as ${mode}"
        return 1
    }
    return 0
}

# -- what is serving ----------------------------------------------------------

# _cd_colour_serving COLOUR - 0 when the colour is the one that serves: it is the
# one runtime/active-colour names, or the Traefik API shows app@file or public@file
# on it. 1 when it is not named by either. 2 when active-colour cannot be read, 4
# when the Traefik API does not answer: unknown is not "free".
_cd_colour_serving() {
    local colour="$1" f act svc name url
    f="$(_cd_colour_root)/runtime/active-colour"
    if [[ ! -f "$f" || ! -r "$f" ]]; then
        _cd_colour_err "cd_colour: runtime/active-colour is not readable"
        return 2
    fi
    act="$(head -n 1 -- "$f" 2>/dev/null)" || act=''
    act="${act%$'\r'}"
    case "$act" in
        blue | green) ;;
        *) _cd_colour_err "cd_colour: runtime/active-colour names neither colour"; return 2 ;;
    esac
    [[ "$act" == "$colour" ]] && return 0
    for name in app@file:gremion-ui public@file:gremion-public; do
        svc="$(cd_traefik_service "${name%%:*}")" || {
            _cd_colour_err "cd_colour: the Traefik API did not answer for ${name%%:*}"
            return 4
        }
        while IFS= read -r url; do
            [[ "$url" == *"://${name##*:}-${colour}:"* ]] && return 0
        done < <(printf '%s' "$svc" | jq -r '.loadBalancer.servers[]?.url // empty' 2>/dev/null)
    done
    return 1
}

# _cd_colour_guard COLOUR WHO - 0 when the colour may be taken down; otherwise the
# refusal (one line, no compose call): 1 it serves, 2 or 4 it cannot be told.
_cd_colour_guard() {
    local rc=0
    _cd_colour_serving "$1" || rc=$?
    case "$rc" in
        0) _cd_colour_err "${2:-cd_colour}: refusing, the ${1} colour is the one that serves"; return 1 ;;
        1) return 0 ;;
        *) _cd_colour_err "${2:-cd_colour}: refusing, it cannot be told whether the ${1} colour serves"; return "$rc" ;;
    esac
}

# cd_colour_down TREE COLOUR - `compose down` of that colour's project alone, never
# the other one, never with -v. REFUSES (1, one line, no compose call) a colour that
# runtime/active-colour or the Traefik API names, and a colour for which that cannot
# be read (2, 4).
cd_colour_down() {
    local tree="${1:-}" colour="${2:-}" rc=0
    [[ "$#" -eq 2 ]] || { _cd_colour_err "cd_colour_down: usage: TREE COLOUR"; return 2; }
    _cd_colour_check_colour "$colour" cd_colour_down || return 2
    _cd_colour_guard "$colour" cd_colour_down || return $?
    cd_dc "$tree" "app-${colour}" down || rc=$?
    [[ "$rc" -eq 0 ]] || { _cd_colour_err "cd_colour_down: compose down of the ${colour} colour failed"; return 1; }
    return 0
}

# -- stack isolation (a port of gremion-deploy assert_stack_isolation) ---------

# _cd_colour_stack_isolation COLOUR - every mount and every network of every running
# container of the colour belongs to its stack. An anonymous volume (a bare 64-hex
# name) belongs to no stack and is allowed; a bind mount has no name and produces no
# token at all (the worker gate directory is one). On the two shared networks every
# container carries the alias <service>-<colour>. No container at all is a failure.
_cd_colour_stack_isolation() {
    local colour="$1" proj stack project allowed cid mounts nets m n svc eps al t seen=0 cids
    proj="$(_cd_colour_project "$colour")" || return 2
    stack="${proj%-app-"$colour"}"
    project="$proj"
    allowed=" ${stack}_edge ${stack}_state ${project}_app "
    cids="$(cd_project_cids "app-${colour}")" || return 4
    while IFS= read -r cid; do
        [[ -n "$cid" ]] || continue
        seen=$((seen + 1))
        svc="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$cid" </dev/null 2>/dev/null)" || return 4
        mounts="$(docker inspect --format '{{range .Mounts}}{{.Name}} {{end}}' "$cid" </dev/null 2>/dev/null)" || return 4
        for m in $mounts; do
            case "$m" in
                "${stack}"_* | "${project}"_*) : ;;
                *)
                    [[ "$m" =~ ^[0-9a-f]{64}$ ]] && continue
                    _cd_colour_fail stack_isolation 1 "stack isolation: the ${svc} container mounts a volume of another stack"
                    return 1
                    ;;
            esac
        done
        nets="$(docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$cid" </dev/null 2>/dev/null)" || return 4
        for n in $nets; do
            case "$allowed" in
                *" $n "*) : ;;
                *)
                    _cd_colour_fail stack_isolation 1 "stack isolation: the ${svc} container is attached to a network of another stack"
                    return 1
                    ;;
            esac
        done
        eps="$(docker inspect --format '{{range $net, $ep := .NetworkSettings.Networks}}{{$net}}={{range $ep.Aliases}}{{.}},{{end}} {{end}}' "$cid" </dev/null 2>/dev/null)" || return 4
        for n in $nets; do
            [[ "$n" == "${stack}_edge" || "$n" == "${stack}_state" ]] || continue
            al=''
            for t in $eps; do
                [[ "$t" == "${n}="* ]] && al="${t#*=}"
            done
            case ",${al}" in
                *",${svc}-${colour},"*) : ;;
                *)
                    _cd_colour_fail stack_isolation 1 "stack isolation: the ${svc} container carries no ${svc}-${colour} alias on a shared network"
                    return 1
                    ;;
            esac
        done
    done <<<"$cids"
    [[ "$seen" -ge 1 ]] || { _cd_colour_fail stack_isolation 1 "stack isolation: the ${colour} colour has no running container"; return 1; }
    return 0
}

# -- start ----------------------------------------------------------------------

# cd_colour_start TREE COLOUR TAG - bring one colour up from one release tree.
#  1. the env file of the colour must carry IMAGE_TAG equal to TAG (a stale or
#     retagged env is refused, 2) and the colour must not be the serving one;
#  2. the worker gate file is written `off` BEFORE any container of the colour starts
#     (a stale `on` of an earlier release is overwritten);
#  3. leftovers of an earlier, interrupted start are taken down;
#  4. `up -d` from TREE with the colour's own env file (cd_dc: no profile, no -f, no -p);
#  5. the stack isolation assert; a violation takes the colour down again (1).
# The health wait belongs to cd_colour_ready. 4 when compose timed out.
cd_colour_start() {
    local tree="${1:-}" colour="${2:-}" tag="${3:-}" f cur rc=0
    [[ "$#" -eq 3 ]] || { _cd_colour_err "cd_colour_start: usage: TREE COLOUR TAG"; return 2; }
    _cd_colour_check_colour "$colour" cd_colour_start || return 2
    _cd_colour_check_tag "$tag" cd_colour_start || return 2
    [[ -d "$tree" && -x "$tree" ]] || { _cd_colour_err "cd_colour_start: no release tree directory"; return 2; }
    _cd_colour_check_env "$colour" cd_colour_start || return 2
    f="$(cd_envfile "app-${colour}")" || return 2
    cur="$(cd_kv_get "$f" IMAGE_TAG 2>/dev/null)" || {
        _cd_colour_fail env_tag 2 "cd_colour_start: the env file of the ${colour} colour does not carry exactly one IMAGE_TAG"
        return 2
    }
    [[ "$cur" == "$tag" ]] || {
        _cd_colour_fail env_tag 2 "cd_colour_start: the env file of the ${colour} colour names another tag than the one asked for; refusing to start it"
        return 2
    }
    _cd_colour_guard "$colour" cd_colour_start || return $?
    cd_colour_workers "$colour" off || { _cd_colour_err "cd_colour_start: the worker gate could not be set to off; nothing was started"; return 2; }
    cd_dc "$tree" "app-${colour}" down || { _cd_colour_err "cd_colour_start: the leftovers of the ${colour} colour could not be taken down"; return 1; }
    cd_dc "$tree" "app-${colour}" up -d || rc=$?
    if [[ "$rc" -ne 0 ]]; then
        if [[ "$rc" -eq 124 || "$rc" -eq 137 ]]; then
            _cd_colour_err "cd_colour_start: compose up of the ${colour} colour timed out"
            return 4
        fi
        _cd_colour_fail up_failed 1 "cd_colour_start: compose up of the ${colour} colour failed"
        return 1
    fi
    rc=0
    _cd_colour_stack_isolation "$colour" || rc=$?
    if [[ "$rc" -eq 1 ]]; then
        cd_dc "$tree" "app-${colour}" down || _cd_colour_err "cd_colour_start: the colour could not be taken down after the violation"
        _cd_colour_err "cd_colour_start: the ${colour} colour was stopped, nothing was routed to it"
        return 1
    fi
    [[ "$rc" -eq 0 ]] || return "$rc"
    return 0
}

# -- identity -----------------------------------------------------------------

# cd_colour_identity COLOUR TAG - every first-party container of the colour (an image
# whose tag is a release tag, pilot-<12 hex>) runs the image its own tag resolves to
# now. A first-party container on ANOTHER release tag fails too. A container whose
# image ID equals the other colour's is not a failure: an unchanged service builds to
# the same image. At least one first-party container must exist.
cd_colour_identity() {
    local colour="${1:-}" tag="${2:-}" cids cid line ref id t want first=0 rc
    CD_COLOUR_REASON=''
    _cd_colour_check_colour "$colour" cd_colour_identity || return 2
    _cd_colour_check_tag "$tag" cd_colour_identity || return 2
    cids="$(cd_project_cids "app-${colour}")" || return 4
    while IFS= read -r cid; do
        [[ -n "$cid" ]] || continue
        line="$(docker inspect --format '{{.Config.Image}} {{.Image}}' "$cid" </dev/null 2>/dev/null)" || return 4
        ref="${line%% *}"
        id="${line#* }"
        [[ "$ref" == *@* ]] && continue
        t="${ref##*/}"
        [[ "$t" == *:* ]] || continue
        t="${t##*:}"
        [[ "$t" =~ ^pilot-[0-9a-f]{12}$ ]] || continue
        first=$((first + 1))
        if [[ "$t" != "$tag" ]]; then
            _cd_colour_fail identity 1 "identity: a first-party container of the ${colour} colour runs another release tag"
            return 1
        fi
        rc=0
        want="$(cd_image_id "$ref")" || rc=$?
        if [[ "$rc" -ne 0 ]]; then
            [[ "$rc" -eq 1 ]] && { _cd_colour_fail identity 1 "identity: the image of a container no longer resolves"; return 1; }
            return 4
        fi
        [[ "$id" == "$want" ]] || {
            _cd_colour_fail identity 1 "identity: a container of the ${colour} colour does not run the image its own tag resolves to"
            return 1
        }
    done <<<"$cids"
    [[ "$first" -ge 1 ]] || { _cd_colour_fail identity 1 "identity: no first-party container in the ${colour} colour"; return 1; }
    return 0
}

# -- the probes ---------------------------------------------------------------

# The two requests run INSIDE the container with node. Neither script holds a secret:
# the first reads INTERNAL_PUSH_SECRET from its own environment and prints the status
# and the body (8 KiB at most); the second prints the status of the path it is given
# as its one argument.
# shellcheck disable=SC2016  # JavaScript, not shell
_CD_COLOUR_JS_READYZ='const h=require("http");const s=process.env.INTERNAL_PUSH_SECRET||"";if(!s)process.exit(3);const q=h.get({host:"127.0.0.1",port:3000,path:"/readyz",headers:{authorization:"Bearer "+s}},r=>{let b="";r.setEncoding("utf8");r.on("data",d=>{if(b.length<8192)b+=d});r.on("end",()=>{process.stdout.write(r.statusCode+"\n"+b.slice(0,8192)+"\n")})});q.setTimeout(5000,()=>{q.destroy();process.exit(4)});q.on("error",()=>process.exit(5));'
# shellcheck disable=SC2016
_CD_COLOUR_JS_PORTAL='const h=require("http");const q=h.get({host:"127.0.0.1",port:3000,path:process.argv[1]},r=>{r.resume();r.on("end",()=>{process.stdout.write(String(r.statusCode)+"\n")})});q.setTimeout(8000,()=>{q.destroy();process.exit(4)});q.on("error",()=>process.exit(5));'

# _cd_colour_exec CID SCRIPT [ARG...] - node -e SCRIPT inside the container, stdout
# only, bounded, stdin closed. No -i, no -t, no -e: nothing is handed to the container.
_cd_colour_exec() {
    local cid="$1" script="$2" t
    shift 2
    t="$(_cd_colour_int "${CD_COLOUR_EXEC_TIMEOUT_S:-}" 15)"
    timeout -k 2 "$t" docker exec "$cid" node -e "$script" "$@" </dev/null 2>/dev/null
}

# cd_colour_probe COLOUR - the full internal /readyz answer of the colour's gremion-ui,
# read by docker exec of node inside its container: the secret is read there, never on
# an argv. Prints the answer as one compact JSON line:
# {"ready","colour","release","tenants":{"total","notReady"},"reasons"}. Returns 0 when
# an answer of that shape came back (ready may be false), 1 for "no answer" (no
# container, a timeout, an unreachable server, the anonymous shape), 4 docker.
cd_colour_probe() {
    local colour="${1:-}" cid out status body
    _cd_colour_check_colour "$colour" cd_colour_probe || return 2
    _cd_colour_check_env "$colour" cd_colour_probe || return 2
    cid="$(cd_svc_cid "app-${colour}" gremion-ui)" || return 4
    [[ -n "$cid" ]] || { _cd_colour_err "cd_colour_probe: no answer, the ${colour} gremion-ui container is not running"; return 1; }
    out="$(_cd_colour_exec "$cid" "$_CD_COLOUR_JS_READYZ")" || { _cd_colour_err "cd_colour_probe: no answer from the ${colour} colour"; return 1; }
    status="${out%%$'\n'*}"
    body="${out#*$'\n'}"
    [[ "$status" == 200 || "$status" == 503 ]] || { _cd_colour_err "cd_colour_probe: no usable answer from the ${colour} colour"; return 1; }
    printf '%s' "$body" | jq -e '
        type == "object" and (.ready | type) == "boolean" and (.colour | type) == "string"
        and (.release | type) == "string" and (.tenants | type) == "object"
        and (.tenants.total | type) == "number" and (.tenants.notReady | type) == "number"
        and .tenants.total >= 0 and .tenants.notReady >= 0
        and (.tenants.total | floor) == .tenants.total and (.tenants.notReady | floor) == .tenants.notReady' \
        >/dev/null 2>&1 || { _cd_colour_err "cd_colour_probe: the answer of the ${colour} colour has not the internal shape"; return 1; }
    printf '%s' "$body" | jq -c .
}

# _cd_colour_base_path - PUBLIC_BASE_PATH of state.env (the source the switch template
# reads): empty, or /segment[/segment...] without a trailing slash. An absent key is
# empty, as in gremion-switch; any other reading problem is 2.
_cd_colour_base_path() {
    local f v n
    f="$(cd_envfile state)" || return 2
    [[ -f "$f" && -r "$f" ]] || { _cd_colour_err "cd_colour: no readable state.env"; return 2; }
    n="$(grep -cE -- '^[[:space:]]*(export[[:space:]]+)?PUBLIC_BASE_PATH[[:space:]]*[=:]' "$f")" || true
    if [[ "${n:-0}" -eq 0 ]]; then
        printf ''
        return 0
    fi
    v="$(cd_kv_get "$f" PUBLIC_BASE_PATH 2>/dev/null)" || { _cd_colour_err "cd_colour: PUBLIC_BASE_PATH of state.env is not a single plain line"; return 2; }
    [[ -z "$v" || "$v" =~ ^(/[A-Za-z0-9._~-]+)+$ ]] || { _cd_colour_err "cd_colour: PUBLIC_BASE_PATH of state.env is not a base path"; return 2; }
    printf '%s' "$v"
}

# cd_colour_portal_probe COLOUR - the one unauthenticated request that reads migrated
# schema (the portal list page): docker exec of node inside the colour's gremion-public
# container, a request of ${PUBLIC_BASE_PATH}/protokolle on loopback port 3000. No host
# and no secret on any argv. Status below 500 passes (0); a 5xx, a timeout, an
# unreachable server and an absent container fail (1); 4 docker; 2 a bad base path.
cd_colour_portal_probe() {
    local colour="${1:-}" cid base out
    _cd_colour_check_colour "$colour" cd_colour_portal_probe || return 2
    _cd_colour_check_env "$colour" cd_colour_portal_probe || return 2
    base="$(_cd_colour_base_path)" || return 2
    cid="$(cd_svc_cid "app-${colour}" gremion-public)" || return 4
    [[ -n "$cid" ]] || { _cd_colour_err "cd_colour_portal_probe: the ${colour} gremion-public container is not running"; return 1; }
    out="$(_cd_colour_exec "$cid" "$_CD_COLOUR_JS_PORTAL" "${base}/protokolle")" || { _cd_colour_err "cd_colour_portal_probe: no answer from the ${colour} portal"; return 1; }
    out="${out%%$'\n'*}"
    [[ "$out" =~ ^[1-5][0-9][0-9]$ ]] || { _cd_colour_err "cd_colour_portal_probe: no usable answer from the ${colour} portal"; return 1; }
    [[ "$out" -lt 500 ]] || { _cd_colour_err "cd_colour_portal_probe: the ${colour} portal answered ${out}"; return 1; }
    return 0
}

# -- the readiness gate -------------------------------------------------------

# _cd_colour_tree_for COLOUR TAG TREE - the release tree whose compose files name the
# services of the colour: TREE when given, else the tree of the release, live or
# previous record of the state that names this colour and tag. Prints it; 2 when none.
_cd_colour_tree_for() {
    local colour="$1" tag="$2" tree="${3:-}"
    if [[ -z "$tree" ]]; then
        declare -F cd_state_get >/dev/null 2>&1 || return 2
        tree="$(cd_state_get "[.release, .live, .previous] | map(select(. != null and .colour == \"${colour}\" and .tag == \"${tag}\")) | .[0].tree // empty")" || return 2
    fi
    [[ -n "$tree" && -d "$tree" && -x "$tree" ]] || return 2
    printf '%s' "$tree"
}

# _cd_colour_baseline - the tenants.notReady of the LIVE colour taken at the start of
# the release (release.watch.baseline_not_ready). Anything but a whole number, or a
# state that cannot be read, is 2: a gate that cannot compare fails closed.
_cd_colour_baseline() {
    local v
    declare -F cd_state_get >/dev/null 2>&1 || return 2
    v="$(cd_state_get '.release.watch.baseline_not_ready')" || return 2
    [[ "$v" =~ ^[0-9]{1,9}$ ]] || return 2
    printf '%s' "$((10#$v))"
}

# Layer 1: containers.
_cd_colour_l1_healthy() { # COLOUR TREE
    local rc=0
    cd_wait_healthy "app-${1}" "$(_cd_colour_int "${CD_COLOUR_HEALTHY_S:-}" 180)" "$2" || rc=$?
    case "$rc" in
        0) return 0 ;;
        3) _cd_colour_fail unhealthy 1 "layer 1: the ${1} colour is not healthy:${CD_WAIT_BAD:-}"; return 1 ;;
        *) _cd_colour_fail unhealthy 2 "layer 1: the health of the ${1} colour could not be read"; return 2 ;;
    esac
}

_cd_colour_l1_oneshots() { # COLOUR
    local cp ids cid code
    cp="$(_cd_colour_project "$1")" || return 2
    ids="$(docker ps -a -q --filter "label=com.docker.compose.project=${cp}" --filter status=exited </dev/null 2>/dev/null)" || return 4
    while IFS= read -r cid; do
        [[ -n "$cid" ]] || continue
        code="$(docker inspect --format '{{.State.ExitCode}}' "$cid" </dev/null 2>/dev/null)" || return 4
        [[ "$code" =~ ^[0-9]+$ ]] || return 4
        [[ "$code" == 0 ]] || { _cd_colour_fail oneshot 1 "layer 1: a one-shot or service of the ${1} colour exited with a non-zero code"; return 1; }
    done <<<"$ids"
    return 0
}

# _cd_colour_restarts COLOUR - "<id> <restart count>" per running container, sorted.
_cd_colour_restarts() {
    local cids cid n
    cids="$(cd_project_cids "app-${1}")" || return 4
    while IFS= read -r cid; do
        [[ -n "$cid" ]] || continue
        n="$(docker inspect --format '{{.RestartCount}}' "$cid" </dev/null 2>/dev/null)" || return 4
        [[ "$n" =~ ^[0-9]+$ ]] || return 4
        printf '%s %s\n' "$cid" "$n"
    done <<<"$cids" | sort
}

# The containers keep their restart counts, and stay healthy, for the whole window.
_cd_colour_l1_stable() { # COLOUR TREE
    local before after rc=0
    before="$(_cd_colour_restarts "$1")" || return 4
    _cd_colour_sleep "$(_cd_colour_int "${CD_COLOUR_STABLE_S:-}" 60)"
    after="$(_cd_colour_restarts "$1")" || return 4
    [[ "$before" == "$after" ]] || { _cd_colour_fail restart 1 "layer 1: a container of the ${1} colour restarted during the stable window"; return 1; }
    cd_wait_healthy "app-${1}" 0 "$2" || rc=$?
    [[ "$rc" -eq 0 ]] || { _cd_colour_fail restart 1 "layer 1: the ${1} colour is not healthy at the end of the stable window"; return 1; }
    return 0
}

# Layer 2: the edge's next route (app-next@file and public-next@file name the target).
_cd_colour_l2_route_once() { # COLOUR
    local pair name svc url st urls
    for pair in app-next@file:gremion-ui public-next@file:gremion-public; do
        name="${pair%%:*}"
        svc="$(cd_traefik_service "$name" 2>/dev/null)" || {
            _cd_colour_fail next_route_down 1 "layer 2: ${name} is not reported by the Traefik API"
            return 1
        }
        urls="$(printf '%s' "$svc" | jq -r '.loadBalancer.servers[]?.url // empty' 2>/dev/null)" || urls=''
        [[ -n "$urls" ]] || { _cd_colour_fail next_route_colour 1 "layer 2: ${name} has no server"; return 1; }
        while IFS= read -r url; do
            [[ "$url" == "http://${pair##*:}-${1}:3000" ]] || {
                _cd_colour_fail next_route_colour 1 "layer 2: ${name} does not point at the ${1} colour"
                return 1
            }
        done <<<"$urls"
        while IFS= read -r url; do
            st="$(printf '%s' "$svc" | jq -r --arg u "$url" '.serverStatus[$u] // "none"' 2>/dev/null)" || st=none
            [[ "$st" == UP ]] || { _cd_colour_fail next_route_down 1 "layer 2: ${name} is not UP for the ${1} colour"; return 1; }
        done <<<"$urls"
    done
    return 0
}

# The Traefik health check runs every ten seconds, so a fresh server is first not UP:
# the wait is for the status only; a wrong colour fails at once; an API that does not
# answer is 4.
_cd_colour_l2_route() { # COLOUR
    local api deadline rc
    api="$(cd_traefik_api)" || return 2
    curl -fsS --max-time 5 "${api}/api/version" >/dev/null 2>&1 </dev/null || {
        _cd_colour_err "layer 2: the Traefik API does not answer"
        return 4
    }
    deadline=$(($(_cd_colour_now) + $(_cd_colour_int "${CD_COLOUR_ROUTE_WAIT_S:-}" 40)))
    while :; do
        rc=0
        _cd_colour_l2_route_once "$1" || rc=$?
        [[ "$rc" -eq 0 ]] && return 0
        [[ "$CD_COLOUR_REASON" == next_route_down && "$(_cd_colour_now)" -lt "$deadline" ]] || return "$rc"
        _cd_colour_sleep 2
    done
}

# _cd_colour_internaltest_port - INTERNALTEST_PORT of state.env; no default.
_cd_colour_internaltest_port() {
    local f p
    f="$(cd_envfile state)" || return 2
    p="$(cd_kv_get "$f" INTERNALTEST_PORT 2>/dev/null)" || { _cd_colour_err "cd_colour: state.env has no single INTERNALTEST_PORT"; return 2; }
    [[ "$p" =~ ^[0-9]{1,5}$ && "$((10#$p))" -ge 1 && "$((10#$p))" -le 65535 ]] || { _cd_colour_err "cd_colour: INTERNALTEST_PORT is not a port"; return 2; }
    printf '%s' "$((10#$p))"
}

# The public, ready-only answer through the loopback test router (any non-empty Host
# header takes it): HTTP 200 and exactly {"ready":true}.
_cd_colour_l2_public() { # PORT
    local out code body
    out="$(curl -sS --max-time "$(_cd_colour_int "${CD_COLOUR_HTTP_TIMEOUT_S:-}" 10)" -H 'Host: cd-readiness.invalid' \
        -w $'\n%{http_code}' "http://127.0.0.1:${1}/readyz" </dev/null 2>/dev/null)" || out=''
    code="${out##*$'\n'}"
    body="${out%$'\n'*}"
    [[ "$code" == 200 ]] || { _cd_colour_fail public_ready 1 "layer 2: the public readiness answer is HTTP ${code:-none}"; return 1; }
    printf '%s' "$body" | jq -e '. == {"ready": true}' >/dev/null 2>&1 || {
        _cd_colour_fail public_ready 1 "layer 2: the public readiness answer is not {\"ready\":true}"
        return 1
    }
    return 0
}

_cd_colour_l2_portal() { # COLOUR
    local rc=0
    cd_colour_portal_probe "$1" || rc=$?
    [[ "$rc" -eq 0 ]] && return 0
    [[ "$rc" -eq 1 ]] && { _cd_colour_fail portal 1 "layer 2: the portal list page of the ${1} colour does not answer below 500"; return 1; }
    return "$rc"
}

# The internal answer: ready, the colour, the release and the tenants that are not
# ready against the baseline of the live colour (equal passes, above fails).
_cd_colour_l2_internal() { # COLOUR TAG BASELINE
    local ans rc=0 v
    ans="$(cd_colour_probe "$1")" || rc=$?
    if [[ "$rc" -ne 0 ]]; then
        [[ "$rc" -eq 1 ]] && { _cd_colour_fail internal_none 1 "layer 2: the internal readiness probe of the ${1} colour has no answer"; return 1; }
        return "$rc"
    fi
    printf '%s' "$ans" | jq -e '.ready == true' >/dev/null 2>&1 || { _cd_colour_fail internal_ready 1 "layer 2: the ${1} colour says it is not ready"; return 1; }
    v="$(printf '%s' "$ans" | jq -r '.colour' 2>/dev/null)" || v=''
    [[ "$v" == "$1" ]] || { _cd_colour_fail internal_colour 1 "layer 2: the answer comes from another colour than ${1}"; return 1; }
    v="$(printf '%s' "$ans" | jq -r '.release' 2>/dev/null)" || v=''
    [[ "$v" == "$2" ]] || { _cd_colour_fail internal_release 1 "layer 2: the answer comes from another release than the one asked for"; return 1; }
    v="$(printf '%s' "$ans" | jq -r '.tenants.notReady' 2>/dev/null)" || v=''
    [[ "$v" =~ ^[0-9]{1,9}$ && "$((10#$v))" -le "$3" ]] || {
        _cd_colour_fail tenants_not_ready 1 "layer 2: more tenants are not ready on the ${1} colour than on the live colour"
        return 1
    }
    return 0
}

# cd_colour_ready COLOUR TAG [TREE] - the readiness gate, layers 1 to 3 of section 6.
#  Layer 1, containers: every service healthy; no one-shot or service exited non-zero;
#   every first-party container runs the image of its tag (cd_colour_identity); the
#   stack isolation holds; no container restarts over CD_COLOUR_STABLE_S (60) seconds.
#  Layer 2, the next route: app-next@file and public-next@file are UP and name the
#   colour; then CD_COLOUR_ROUNDS (3) rounds, CD_COLOUR_ROUND_S (5) seconds apart, of:
#   the public ready-only answer through the loopback test router, the portal list
#   page, and the internal answer (ready, colour, release, tenants not ready at or
#   below the baseline of the live colour). Every round must pass.
#  Layer 3 is the /readyz the probes read (app contract U12a).
# TREE (the release tree whose compose files name the services) is optional: it falls
# back to the state's release, live or previous record of that colour and tag, and 2
# is returned when none can be found. The baseline is release.watch.baseline_not_ready;
# a baseline that cannot be read is 2. CD_COLOUR_REASON names the layer that failed.
cd_colour_ready() {
    local colour="${1:-}" tag="${2:-}" tree="${3:-}" baseline port round rounds gap
    CD_COLOUR_REASON=''
    _cd_colour_check_colour "$colour" cd_colour_ready || return 2
    _cd_colour_check_tag "$tag" cd_colour_ready || return 2
    _cd_colour_check_env "$colour" cd_colour_ready || return 2
    tree="$(_cd_colour_tree_for "$colour" "$tag" "$tree")" || {
        _cd_colour_fail no_tree 2 "cd_colour_ready: the release tree of the ${colour} colour is not known"
        return 2
    }
    baseline="$(_cd_colour_baseline)" || {
        _cd_colour_fail baseline_unreadable 2 "cd_colour_ready: the baseline of tenants not ready cannot be read"
        return 2
    }
    port="$(_cd_colour_internaltest_port)" || return 2
    _cd_colour_l1_healthy "$colour" "$tree" || return $?
    _cd_colour_l1_oneshots "$colour" || return $?
    cd_colour_identity "$colour" "$tag" || return $?
    _cd_colour_stack_isolation "$colour" || return $?
    _cd_colour_l1_stable "$colour" "$tree" || return $?
    _cd_colour_l2_route "$colour" || return $?
    rounds="$(_cd_colour_int "${CD_COLOUR_ROUNDS:-}" 3)"
    gap="$(_cd_colour_int "${CD_COLOUR_ROUND_S:-}" 5)"
    for ((round = 1; round <= rounds; round++)); do
        [[ "$round" -eq 1 ]] || _cd_colour_sleep "$gap"
        _cd_colour_l2_public "$port" || return $?
        _cd_colour_l2_portal "$colour" || return $?
        _cd_colour_l2_internal "$colour" "$tag" "$baseline" || return $?
    done
    return 0
}

# -- isolation evidence and verify -----------------------------------------------

# _cd_colour_tip TREE - the full commit of the release tree; 2 when it has none.
_cd_colour_tip() {
    local sha=''
    if [[ -e "${1}/.git" ]] && command -v git >/dev/null 2>&1; then
        sha="$(git -C "$1" rev-parse --verify 'HEAD^{commit}' </dev/null 2>/dev/null)" || sha=''
    fi
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || return 2
    printf '%s' "$sha"
}

_cd_colour_evidence_dir() { printf '%s' "$(_cd_colour_root)/data/isolation-evidence"; }

# cd_colour_isolation_run TREE - produce the cross-customer isolation evidence for the
# tip of TREE (gremion-isolation run, GREMION_RELEASE_DIR = TREE) and require the
# evidence file for that tip. Prints the evidence path. 1 when the run fails or leaves
# no evidence for the tip; 2 when the program or the tip is missing. The program's
# output goes to a 0600 file under logs/.
cd_colour_isolation_run() {
    local tree="${1:-}" prog tip out log rc=0 ev
    [[ "$#" -eq 1 ]] || { _cd_colour_err "cd_colour_isolation_run: usage: TREE"; return 2; }
    [[ -d "$tree" ]] || { _cd_colour_err "cd_colour_isolation_run: no release tree directory"; return 2; }
    prog="$(_cd_colour_root)/bin/gremion-isolation"
    [[ -x "$prog" ]] || { _cd_colour_err "cd_colour_isolation_run: gremion-isolation is not installed"; return 2; }
    tip="$(_cd_colour_tip "$tree")" || { _cd_colour_err "cd_colour_isolation_run: the release tree has no release tip"; return 2; }
    out="$(_cd_colour_evidence_dir)"
    log="$(_cd_colour_logfile isolation)" || return 2
    GREMION_RELEASE_DIR="$tree" "$prog" run --out "$out" >"$log" 2>&1 </dev/null || rc=$?
    if [[ "$rc" -ne 0 ]]; then
        _cd_colour_fail isolation_run 1 "isolation run failed (exit ${rc}); output in logs/${log##*/}"
        return 1
    fi
    ev="${out}/${tip}.json"
    [[ -s "$ev" ]] || { _cd_colour_fail isolation_run 1 "isolation run left no evidence file for the tip; output in logs/${log##*/}"; return 1; }
    printf '%s\n' "$ev"
}

# cd_colour_isolation_record TREE - record the evidence of the tip of TREE
# (gremion-isolation record, GREMION_RELEASE_DIR = TREE). It is separate from the run:
# the commit point calls it (F13), the gates do not. 1 when the evidence file for the
# tip is absent or the record fails.
cd_colour_isolation_record() {
    local tree="${1:-}" prog tip ev log rc=0
    [[ "$#" -eq 1 ]] || { _cd_colour_err "cd_colour_isolation_record: usage: TREE"; return 2; }
    [[ -d "$tree" ]] || { _cd_colour_err "cd_colour_isolation_record: no release tree directory"; return 2; }
    prog="$(_cd_colour_root)/bin/gremion-isolation"
    [[ -x "$prog" ]] || { _cd_colour_err "cd_colour_isolation_record: gremion-isolation is not installed"; return 2; }
    tip="$(_cd_colour_tip "$tree")" || { _cd_colour_err "cd_colour_isolation_record: the release tree has no release tip"; return 2; }
    ev="$(_cd_colour_evidence_dir)/${tip}.json"
    [[ -s "$ev" ]] || { _cd_colour_fail isolation_record 1 "isolation record: no evidence file for the tip"; return 1; }
    log="$(_cd_colour_logfile isolation-record)" || return 2
    GREMION_RELEASE_DIR="$tree" "$prog" record "$ev" >"$log" 2>&1 </dev/null || rc=$?
    [[ "$rc" -eq 0 ]] || { _cd_colour_fail isolation_record 1 "isolation record failed (exit ${rc}); output in logs/${log##*/}"; return 1; }
    return 0
}

# cd_colour_verify COLOUR TREE - gremion-verify --colour COLOUR, with the waiver ledger
# of TREE. REPORT-ONLY until CD_VERIFY_ENFORCE=1: with 0 a failure is logged (history
# event verify_report, counts only) and 0 is returned; with 1 it is 1 (2 when verify
# could not run). The program's output goes to a 0600 file under logs/.
cd_colour_verify() {
    local colour="${1:-}" tree="${2:-}" prog log ledger enf rc=0
    [[ "$#" -eq 2 ]] || { _cd_colour_err "cd_colour_verify: usage: COLOUR TREE"; return 2; }
    _cd_colour_check_colour "$colour" cd_colour_verify || return 2
    [[ -d "$tree" ]] || { _cd_colour_err "cd_colour_verify: no release tree directory"; return 2; }
    prog="$(_cd_colour_root)/bin/gremion-verify"
    [[ -x "$prog" ]] || { _cd_colour_err "cd_colour_verify: gremion-verify is not installed"; return 2; }
    enf="$(cd_cfg CD_VERIFY_ENFORCE 2>/dev/null)" || enf=1
    ledger="${tree}/docs/ops/release-1-waivers.md"
    log="$(_cd_colour_logfile verify)" || return 2
    if [[ -f "$ledger" ]]; then
        GREMION_WAIVER_LEDGER="$ledger" timeout -k 10 "$(_cd_colour_int "${CD_COLOUR_VERIFY_TIMEOUT_S:-}" 600)" "$prog" --colour "$colour" >"$log" 2>&1 </dev/null || rc=$?
    else
        timeout -k 10 "$(_cd_colour_int "${CD_COLOUR_VERIFY_TIMEOUT_S:-}" 600)" "$prog" --colour "$colour" >"$log" 2>&1 </dev/null || rc=$?
    fi
    [[ "$rc" -eq 0 ]] && return 0
    if declare -F cd_hist >/dev/null 2>&1; then
        cd_hist verify_report "enforce=${enf}" "code=${rc}" "colour=${colour}" || true
    fi
    if [[ "$enf" == 1 ]]; then
        _cd_colour_fail verify 1 "gremion-verify failed (exit ${rc}); output in logs/${log##*/}"
        [[ "$rc" -eq 2 ]] && return 2
        return 1
    fi
    _cd_colour_err "gremion-verify failed (exit ${rc}), reported only (CD_VERIFY_ENFORCE=0); output in logs/${log##*/}"
    return 0
}

# cd_colour_gates TREE COLOUR TAG - what the target colour must pass before the switch:
# the readiness gate, the isolation evidence for the new tip, verify, and the readiness
# gate once more immediately before the switch (section 6). The first failure's code.
cd_colour_gates() {
    local tree="${1:-}" colour="${2:-}" tag="${3:-}"
    [[ "$#" -eq 3 ]] || { _cd_colour_err "cd_colour_gates: usage: TREE COLOUR TAG"; return 2; }
    cd_colour_ready "$colour" "$tag" "$tree" || return $?
    cd_colour_isolation_run "$tree" >/dev/null || return $?
    cd_colour_verify "$colour" "$tree" || return $?
    cd_colour_ready "$colour" "$tag" "$tree" || return $?
    return 0
}
