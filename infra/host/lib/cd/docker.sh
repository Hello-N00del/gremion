#!/usr/bin/env bash
# infra/host/lib/cd/docker.sh - the compose and docker plumbing of the continuous
# deployment program.
#
# SOURCED, NEVER EXECUTED. Like common.sh it does not set shell options: the
# program that sources it owns them. It depends on NOTHING else of the cd
# family (not core.sh, not common.sh): it reads GREMION_ROOT (default
# /opt/gremion) and the env files under it (the compose project name comes from
# there; STACK, when set, is only cross-checked against it), and calls docker,
# curl, jq and coreutils. The one
# optional hook is `cd_now`: when core.sh has defined it, the wait loop reads
# time through it (a fake clock for tests); otherwise it uses date.
#
# Every function RETURNS, none exits and none prints a secret: an error is one
# line on stderr naming the function and the reason. Return codes: 0 ok, 1 the
# thing asked for is not there or is not as expected, 2 usage or a missing
# precondition (a file, a key, a tool), 3 timed out waiting, 124 (or 137, see
# cd_dc) a compose call that hit CD_DC_TIMEOUT. Unknown is never success: a missing key, an unparseable
# answer or a docker that will not answer is a non-zero return, never a default.
#
# Exported for callers: CD_WAIT_BAD (set by cd_wait_healthy).

CD_WAIT_BAD=''

_cd_docker_err() { printf 'cd-docker: %s\n' "$*" >&2; }

_cd_docker_root() { printf '%s' "${GREMION_ROOT:-/opt/gremion}"; }

# Epoch seconds. cd_now when core.sh provides one that answers an integer.
_cd_docker_epoch() {
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

# The compose project name of a project: the COMPOSE_PROJECT_NAME its env file
# declares (<stack>-<project>), because that is the name compose itself acts
# on. A name rebuilt from the shell's STACK could differ and then every lookup
# would answer "no container" for a project that is running, which a caller
# reads as safe. So the env file is the one source; it must declare the name
# exactly once, as a valid project name that ends in -<project>; and when STACK
# is set it must agree (a disagreement is a refusal, 2, never a guess).
_cd_docker_proj() {
    local proj="$1" f name
    f="$(cd_envfile "$proj")" || return 2
    name="$(cd_kv_get "$f" COMPOSE_PROJECT_NAME 2>/dev/null)" || {
        _cd_docker_err "the env file of ${proj} does not declare exactly one COMPOSE_PROJECT_NAME"
        return 2
    }
    [[ "$name" =~ ^[a-z0-9][a-z0-9_-]*$ && "$name" == *-"${proj}" ]] || {
        _cd_docker_err "the COMPOSE_PROJECT_NAME of ${proj} is not <stack>-${proj}"
        return 2
    }
    if [[ -n "${STACK:-}" && "$name" != "${STACK}-${proj}" ]]; then
        _cd_docker_err "STACK and the COMPOSE_PROJECT_NAME of ${proj} disagree; refusing to look under either"
        return 2
    fi
    printf '%s' "$name"
}

# cd_envfile PROJECT - the env file of a compose project: state, app-blue or
# app-green. Prints the path; it does not say the file exists.
cd_envfile() {
    local proj="${1:-}"
    case "$proj" in
        state | app-blue | app-green) ;;
        *) _cd_docker_err "cd_envfile: unknown project '${proj}' (state, app-blue, app-green)"; return 2 ;;
    esac
    printf '%s/etc/env/%s.env\n' "$(_cd_docker_root)" "$proj"
}

# cd_kv_get FILE KEY - one non-secret value of an env file: the text after
# KEY=, one pair of matching quotes and a trailing CR removed. Returns 1 (and
# prints nothing) when the key is absent or declared more than once: a reader
# that could pick a different line than compose does must not answer.
cd_kv_get() {
    local f="${1:-}" k="${2:-}" n v
    [[ "$k" =~ ^[A-Z][A-Z0-9_]*$ ]] || { _cd_docker_err "cd_kv_get: bad key name"; return 2; }
    [[ -f "$f" && -r "$f" ]] || { _cd_docker_err "cd_kv_get: no readable file $(basename -- "$f")"; return 2; }
    n="$(grep -c -- "^${k}=" "$f")" || true
    if [[ "$n" -ne 1 ]]; then
        _cd_docker_err "cd_kv_get: ${k} is declared ${n} times in $(basename -- "$f")"
        return 1
    fi
    v="$(sed -n "s/^${k}=//p" "$f" | head -n 1)"
    v="${v%$'\r'}"
    if [[ "${#v}" -ge 2 && ( "$v" == \"*\" || "$v" == \'*\' ) ]]; then
        v="${v:1:${#v}-2}"
    fi
    printf '%s\n' "$v"
}

# cd_set_env_key FILE KEY VALUE - replace or append one KEY=VALUE, keeping
# owner and mode, leaving exactly one declaration. A bad key name, a value with
# a newline or a carriage return, a missing file, a file that already declares
# the key more than once and a copy that does not read back exactly are all
# refused (the check of the duplicate runs BEFORE the edit, so that file is
# left untouched; a copy that does not read back is detected AFTER the swap,
# reported with 1, and the file then holds what the swap put there). The value reaches awk through the environment, so no value touches a
# command line or an escape sequence.
cd_set_env_key() {
    local f="${1:-}" k="${2:-}" v="${3-}" tmp n owner_ref owner_new
    [[ "$#" -eq 3 ]] || { _cd_docker_err "cd_set_env_key: usage: FILE KEY VALUE"; return 2; }
    [[ "$k" =~ ^[A-Z][A-Z0-9_]*$ ]] || { _cd_docker_err "cd_set_env_key: bad key name"; return 2; }
    case "$v" in
        *$'\n'* | *$'\r'*) _cd_docker_err "cd_set_env_key: ${k}: the value holds a line break"; return 2 ;;
    esac
    [[ -f "$f" && -r "$f" && ! -L "$f" ]] || { _cd_docker_err "cd_set_env_key: no regular file $(basename -- "$f")"; return 2; }
    n="$(grep -c -- "^${k}=" "$f")" || true
    if [[ "$n" -gt 1 ]]; then
        _cd_docker_err "cd_set_env_key: ${k} is declared ${n} times in $(basename -- "$f"); refusing to guess"
        return 1
    fi
    tmp="$(mktemp "${f}.XXXXXX")" || { _cd_docker_err "cd_set_env_key: cannot create a temporary copy"; return 1; }
    if ! K="$k" V="$v" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; n = 0 }
            index($0, k "=") == 1 { print k "=" v; n++; next }
            { print }
            END { if (n == 0) print k "=" v }' "$f" >"$tmp"; then
        rm -f -- "$tmp"
        _cd_docker_err "cd_set_env_key: cannot write a temporary copy of $(basename -- "$f")"
        return 1
    fi
    # Mode first (mktemp made the copy 0600, so nothing is ever more open than
    # the original), then owner. A chown that is not allowed is tolerated only
    # when the owner already matches.
    chmod --reference="$f" "$tmp" || {
        rm -f -- "$tmp"
        _cd_docker_err "cd_set_env_key: cannot keep the mode of $(basename -- "$f")"
        return 1
    }
    chown --reference="$f" "$tmp" 2>/dev/null || true
    owner_ref="$(stat -c '%u:%g' "$f")"
    owner_new="$(stat -c '%u:%g' "$tmp")"
    if [[ "$owner_ref" != "$owner_new" ]]; then
        rm -f -- "$tmp"
        _cd_docker_err "cd_set_env_key: cannot keep the owner of $(basename -- "$f")"
        return 1
    fi
    mv -f -T -- "$tmp" "$f" || {
        rm -f -- "$tmp"
        _cd_docker_err "cd_set_env_key: cannot replace $(basename -- "$f")"
        return 1
    }
    n="$(grep -c -- "^${k}=" "$f")" || true
    if [[ "$n" -ne 1 ]] || ! grep -Fxq -- "${k}=${v}" "$f"; then
        _cd_docker_err "cd_set_env_key: ${k} does not read back as written in $(basename -- "$f")"
        return 1
    fi
    return 0
}

# cd_dc TREE PROJECT VERB [ARGS...] - THE one compose shape:
#   cd <TREE> && docker compose --env-file <env of PROJECT> [--profile '*'] VERB ARGS
# never -f, never -p, stdin from /dev/null. The star is passed for exactly
# `build`, `pull --ignore-buildable` and `config` (the one-shot images are
# profile-gated and the env file sets only COMPOSE_PROFILES=production) and
# for nothing else: `up`, `run`, `down`, `ps`, `exec` and a plain `pull` get
# none. One exception inside `config`: `config --services` lists the services
# of the profile set the env file declares, the set that is expected to run;
# with the star it would list the one-shots too, and a wait for them could
# never end. VERB must be the first word and must not start with a dash, and
# no argument may be a global option of compose, and the env file must declare
# exactly one COMPOSE_PROJECT_NAME (resolved as the lookups of this library
# resolve it, STACK cross-check included) and exactly one non-empty
# COMPOSE_FILE: without them compose would fall back to the name of the tree
# directory and to docker-compose.yml and could start a third stack beside the
# live colours, so a missing key is a stop (2), never a default. The
# COMPOSE_PROJECT_NAME,
# COMPOSE_PROFILES, COMPOSE_FILE, COMPOSE_PATH_SEPARATOR and COMPOSE_ENV_FILES
# of the caller's environment are dropped before compose starts, so the shape
# cannot be changed from outside. CD_DC_TIMEOUT (whole seconds, 0 or unset = none) bounds
# the call; a call that hits it returns 124, or 137 when compose ignored the
# TERM and was killed ten seconds later: both mean "timed out" (and one line
# on stderr says so). Any other non-zero status is compose's own, passed on
# unchanged; compose has already said why on its own stderr.
cd_dc() {
    local tree="${1:-}" proj="${2:-}" envf verb a tmo root cf rc
    local -a star=() t=()
    [[ "$#" -ge 3 ]] || { _cd_docker_err "cd_dc: usage: TREE PROJECT VERB [ARGS...]"; return 2; }
    shift 2
    verb="$1"
    [[ "$verb" =~ ^[a-z][a-z-]*$ ]] || { _cd_docker_err "cd_dc: the first argument must be a compose verb"; return 2; }
    for a in "$@"; do
        case "$a" in
            --profile | --profile=* | --project-name | --project-name=* | --file | --file=* \
                | --env-file | --env-file=* | --project-directory | --project-directory=*)
                _cd_docker_err "cd_dc: ${a%%=*} is not allowed; the compose shape is fixed"
                return 2
                ;;
        esac
    done
    [[ -d "$tree" && -x "$tree" ]] || { _cd_docker_err "cd_dc: no release tree directory that can be entered"; return 2; }
    envf="$(cd_envfile "$proj")" || return 2
    [[ -f "$envf" ]] || { _cd_docker_err "cd_dc: no env file for ${proj}"; return 2; }
    # the project name the lookups act on, and the files compose acts on: both
    # must come from this env file, or compose would pick its own defaults
    _cd_docker_proj "$proj" >/dev/null || return 2
    cf="$(cd_kv_get "$envf" COMPOSE_FILE 2>/dev/null)" || cf=''
    [[ -n "$cf" ]] || {
        _cd_docker_err "cd_dc: the env file of ${proj} does not declare exactly one non-empty COMPOSE_FILE"
        return 2
    }
    case "$verb" in
        build) star=(--profile '*') ;;
        pull)
            for a in "$@"; do
                [[ "$a" == --ignore-buildable ]] && star=(--profile '*')
            done
            ;;
        config)
            star=(--profile '*')
            for a in "$@"; do
                [[ "$a" == --services ]] && star=()
            done
            ;;
        *) ;;
    esac
    tmo="${CD_DC_TIMEOUT:-0}"
    [[ "$tmo" =~ ^[0-9]{1,9}$ ]] || { _cd_docker_err "cd_dc: CD_DC_TIMEOUT is not a whole number of seconds"; return 2; }
    # decimal, never octal: a leading zero (08, 010) is not a base prefix
    tmo="$((10#$tmo))"
    if [[ "$tmo" -gt 0 ]]; then
        t=(timeout -k 10 "$tmo")
    fi
    root="$(_cd_docker_root)"
    (
        cd "$tree" || exit 2
        # compose prefers these variables of the caller's environment to the
        # env file, so a stray export would make it act on another project
        # than the one the lookups of this library read.
        unset COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_FILE COMPOSE_PATH_SEPARATOR COMPOSE_ENV_FILES
        GREMION_ROOT="$root" exec ${t[@]+"${t[@]}"} docker compose --env-file "$envf" ${star[@]+"${star[@]}"} "$@"
    ) </dev/null && return 0
    rc=$?
    if [[ "$tmo" -gt 0 && ( "$rc" -eq 124 || "$rc" -eq 137 ) ]]; then
        _cd_docker_err "cd_dc: compose ${verb} timed out after ${tmo}s"
    fi
    return "$rc"
}

# cd_svc_cid PROJECT SERVICE - the first RUNNING container of a compose
# service, printed (a `compose run` one-off container never counts); nothing
# printed and 0 when there is none; 2 when docker
# cannot be asked or the arguments are bad.
cd_svc_cid() {
    local proj="${1:-}" svc="${2:-}" cp out
    [[ "$svc" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || { _cd_docker_err "cd_svc_cid: bad service name"; return 2; }
    cd_envfile "$proj" >/dev/null || return 2
    cp="$(_cd_docker_proj "$proj")" || return 2
    out="$(docker ps -q --filter "label=com.docker.compose.project=${cp}" \
        --filter "label=com.docker.compose.service=${svc}" \
        --filter "label=com.docker.compose.oneoff=False" </dev/null)" || {
        _cd_docker_err "cd_svc_cid: docker did not answer"
        return 2
    }
    printf '%s\n' "$out" | head -n 1 | sed -e '/^[[:space:]]*$/d' || true
    return 0
}

# cd_project_cids PROJECT - the ids of every RUNNING container of a compose
# project, one per line, one-off containers (`compose run`) left out; nothing
# and 0 when there is none; 2 when docker
# cannot be asked.
cd_project_cids() {
    local proj="${1:-}" cp out
    cd_envfile "$proj" >/dev/null || return 2
    cp="$(_cd_docker_proj "$proj")" || return 2
    out="$(docker ps -q --filter "label=com.docker.compose.project=${cp}" \
        --filter "label=com.docker.compose.oneoff=False" </dev/null)" || {
        _cd_docker_err "cd_project_cids: docker did not answer"
        return 2
    }
    printf '%s\n' "$out" | sed -e '/^[[:space:]]*$/d' || true
    return 0
}

# cd_wait_healthy PROJECT SECONDS TREE - wait until EVERY service the env
# file declares has a running container whose healthcheck reads healthy (a
# running service whose image declares no healthcheck, livekit, counts as
# healthy). TREE is the release tree whose compose files name the services;
# it is required, there is no default: the current link moves only at the
# commit point, so a default would read the services of the OLD release.
# The services listed are those of the profile set the env file declares (the
# set that is expected to run), not the profile-gated one-shots.
# Returns 0 healthy, 3 when the window ends first, 2 for a usage error (a
# missing tree included, or a project name that cannot be resolved) or a compose that renders no service.
# Sets CD_WAIT_BAD to the services that were not: " name(absent)
# name(running starting)". Only service names and states appear there and in
# the message on stderr, never a container id or name. Call it directly, not
# in $(...), or CD_WAIT_BAD is lost with the subshell. CD_WAIT_POLL_S (default
# 5) is the pause between two looks.
cd_wait_healthy() {
    local proj="${1:-}" secs="${2:-}" tree="${3:-}" poll="${CD_WAIT_POLL_S:-5}"
    local deadline s c st
    local -a svcs=()
    CD_WAIT_BAD=''
    [[ "$secs" =~ ^[0-9]+$ ]] || { _cd_docker_err "cd_wait_healthy: SECONDS must be a whole number"; return 2; }
    [[ "$poll" =~ ^[0-9]+(\.[0-9]+)?$ ]] || { _cd_docker_err "cd_wait_healthy: CD_WAIT_POLL_S is not a number"; return 2; }
    [[ -n "$tree" ]] || { _cd_docker_err "cd_wait_healthy: usage: PROJECT SECONDS TREE (the tree is required)"; return 2; }
    cd_envfile "$proj" >/dev/null || return 2
    # A project name that cannot be resolved is a precondition, not a colour
    # that is slow to get healthy: say so now, once, with its own message.
    _cd_docker_proj "$proj" >/dev/null || return 2
    local listing
    listing="$(cd_dc "$tree" "$proj" config --services)" || {
        _cd_docker_err "cd_wait_healthy: the ${proj} project did not render"
        return 2
    }
    mapfile -t svcs < <(printf '%s\n' "$listing" | sed -e '/^[[:space:]]*$/d')
    [[ ${#svcs[@]} -gt 0 ]] || { _cd_docker_err "cd_wait_healthy: the ${proj} project renders no service"; return 2; }
    deadline=$(( $(_cd_docker_epoch) + secs ))
    while :; do
        CD_WAIT_BAD=''
        for s in "${svcs[@]}"; do
            if ! c="$(cd_svc_cid "$proj" "$s" 2>/dev/null)"; then
                CD_WAIT_BAD+=" ${s}(docker_error)"
                continue
            fi
            if [[ -z "$c" ]]; then
                CD_WAIT_BAD+=" ${s}(absent)"
                continue
            fi
            if ! st="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}nohealthcheck{{end}}' "$c" 2>/dev/null </dev/null)"; then
                CD_WAIT_BAD+=" ${s}(inspect_failed)"
                continue
            fi
            [[ "$st" == 'running healthy' || "$st" == 'running nohealthcheck' ]] || CD_WAIT_BAD+=" ${s}(${st})"
        done
        [[ -z "$CD_WAIT_BAD" ]] && return 0
        if [[ "$(_cd_docker_epoch)" -ge "$deadline" ]]; then
            _cd_docker_err "cd_wait_healthy: ${proj} not healthy after ${secs}s:${CD_WAIT_BAD}"
            return 3
        fi
        sleep "$poll"
    done
}

# cd_image_id REF - the image id (sha256:<64 hex>) the reference names right
# now. Returns 1 with nothing printed when docker answers that there is no such
# image or the answer is not an image id, and 2 (reason on stderr, the first
# line of docker's own error) when docker fails for any other reason, a daemon
# that does not answer first among them: "not there" and "cannot tell" are
# different answers and a caller must be able to tell them apart.
cd_image_id() {
    local ref="${1:-}" id errf rc=0 why all
    [[ -n "$ref" && "$ref" != -* ]] || { _cd_docker_err "cd_image_id: usage: REF"; return 2; }
    errf="$(mktemp)" || { _cd_docker_err "cd_image_id: cannot create a temporary file"; return 2; }
    id="$(docker image inspect -f '{{.Id}}' "$ref" 2>"$errf" </dev/null)" || rc=$?
    # the whole answer is searched for the phrase (a warning line may come
    # first); only its first line is ever reported
    all="$(tr -cd '[:print:]\n' <"$errf" 2>/dev/null)" || all=''
    why="$(printf '%s\n' "$all" | head -n 1 | cut -c 1-200)"
    rm -f -- "$errf"
    if [[ "$rc" -ne 0 ]]; then
        if [[ "${all,,}" == *'no such image'* ]]; then
            _cd_docker_err "cd_image_id: no such image"
            return 1
        fi
        _cd_docker_err "cd_image_id: docker did not answer${why:+: ${why}}"
        return 2
    fi
    [[ "$id" =~ ^sha256:[0-9a-f]{64}$ ]] || {
        _cd_docker_err "cd_image_id: docker's answer is not an image id"
        return 1
    }
    printf '%s\n' "$id"
}

# cd_colour_other COLOUR - blue prints green, green prints blue.
cd_colour_other() {
    case "${1:-}" in
        blue) printf 'green\n' ;;
        green) printf 'blue\n' ;;
        *) _cd_docker_err "cd_colour_other: the colour is blue or green"; return 2 ;;
    esac
}

# cd_traefik_api - the base URL of the Traefik API of this host:
# http://127.0.0.1:<TRAEFIK_API_PORT of state.env>. A state.env without the
# key, with a value that is not a port, or no state.env fails closed (2); there
# is no default port.
cd_traefik_api() {
    local f port
    f="$(cd_envfile state)" || return 2
    [[ -f "$f" ]] || { _cd_docker_err "cd_traefik_api: no state.env"; return 2; }
    port="$(cd_kv_get "$f" TRAEFIK_API_PORT 2>/dev/null)" || { _cd_docker_err "cd_traefik_api: state.env has no single TRAEFIK_API_PORT"; return 2; }
    if ! [[ "$port" =~ ^[0-9]{1,5}$ ]] || [[ "$((10#$port))" -lt 1 || "$((10#$port))" -gt 65535 ]]; then
        _cd_docker_err "cd_traefik_api: TRAEFIK_API_PORT is not a port"
        return 2
    fi
    printf 'http://127.0.0.1:%s\n' "$((10#$port))"
}

# cd_traefik_service NAME - the JSON object Traefik reports for one service
# (for example app@file). Returns 1 with nothing printed when the call fails or
# the answer is not a JSON object.
cd_traefik_service() {
    local name="${1:-}" api body
    [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._@-]*$ ]] || { _cd_docker_err "cd_traefik_service: bad service name"; return 2; }
    api="$(cd_traefik_api)" || return 2
    body="$(curl -fsS --max-time 10 "${api}/api/http/services/${name}" 2>/dev/null </dev/null)" || {
        _cd_docker_err "cd_traefik_service: the Traefik API did not answer for ${name}"
        return 1
    }
    printf '%s' "$body" | jq -e 'type == "object"' >/dev/null 2>&1 || {
        _cd_docker_err "cd_traefik_service: the answer for ${name} is not a JSON object"
        return 1
    }
    printf '%s\n' "$body"
}
