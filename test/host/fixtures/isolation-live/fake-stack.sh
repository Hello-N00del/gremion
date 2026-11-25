#!/usr/bin/env bash
# fake-stack.sh <docker|curl> <args...> -- plays the running two-customer stack for
# test/host/isolation-live.bats. The bats shims for `docker` and `curl` hand every call to this file.
#
# It answers from the URL, the Bearer token and the switch files under $FAKE_DIR/sw/ (a test touches a
# file to change one behaviour). Example hosts only. The two customers are alpha-rat (host alpha.example.org)
# and beta-fox (host beta.example.org) on the platform host plat.example.org.
#
# Every `curl -K -` config (where the program puts tokens, passwords and bodies) is appended to
# $FAKE_DIR/stdin.log, so a test can prove a secret travelled on stdin and not on the argv.
set -u
D="${FAKE_DIR:?FAKE_DIR is not set}"
UNIT="${FAKE_UNIT:-isoprobe}"
USERN="${FAKE_USER:-isoprobe}"
PLAT="plat.example.org"
A="${FAKE_A:-alpha-rat}"
B="${FAKE_B:-beta-fox}"
HA="${FAKE_HOST_A:-alpha.example.org}"
HB="${FAKE_HOST_B:-beta.example.org}"

sw() { [[ -f "$D/sw/$1" ]]; }
other() { if [[ "$1" == "$A" ]]; then printf '%s' "$B"; else printf '%s' "$A"; fi; }
realm_of_host() {
    case "$1" in
        "$HA") printf '%s' "$A" ;;
        "$HB") printf '%s' "$B" ;;
        *) printf '' ;;
    esac
}
host_of_realm() { if [[ "$1" == "$A" ]]; then printf '%s' "$HA"; else printf '%s' "$HB"; fi; }
b64u() { base64 -w0 | tr '+/' '-_' | tr -d '='; }
mkjwt() { printf '%s.%s.TOKMARK' "$(printf '{"alg":"RS256"}' | b64u)" "$(printf '%s' "$1" | b64u)"; }
jwt_claim() { # <token> <jq filter>
    local p
    p="$(printf '%s' "$1" | cut -d. -f2 | tr '_-' '/+')"
    while (( ${#p} % 4 )); do p+="="; done
    printf '%s' "$p" | base64 -d 2>/dev/null | jq -r "$2" 2>/dev/null
}
poll_id() { if [[ "$1" == "$A" ]]; then printf '101'; else printf '202'; fi; }

CODE=000
BODY=""
OUT=""
WCODE=0
reply() { CODE="$1"; BODY="${2:-}"; }
emit() {
    if [[ -n "$OUT" ]]; then printf '%s' "$BODY" > "$OUT"; fi
    if [[ "$WCODE" == 1 ]]; then printf '%s\n%s' "$BODY" "$CODE"; else printf '%s' "$BODY"; fi
}

unescape() { local s="$1"; s="${s//\\\"/\"}"; s="${s//\\\\/\\}"; printf '%s' "$s"; }

form_get() { # <form> <key>
    local kv p
    IFS='&' read -ra kv <<< "$1"
    for p in "${kv[@]}"; do
        if [[ "${p%%=*}" == "$2" ]]; then printf '%s' "${p#*=}"; return 0; fi
    done
    return 1
}

route_keycloak() { # method path bearer data
    local method="$1" path="$2" bearer="$3" data="$4" s id sub ra
    if [[ "$path" =~ ^/auth/realms/([a-z-]+)/protocol/openid-connect/token$ ]]; then
        s="${BASH_REMATCH[1]}"
        if [[ "$(form_get "$data" client_secret)" == "SECRET-${s}" && "$(form_get "$data" client_id)" == gremion-admin ]]; then
            reply 200 "{\"access_token\":\"ADMTOK.${s}.TOKMARK\"}"
        else
            reply 401 '{"error":"unauthorized_client"}'
        fi
        return 0
    fi
    [[ "$path" =~ ^/auth/admin/realms/([a-z-]+)/(.*)$ ]] || return 0
    s="${BASH_REMATCH[1]}"; sub="${BASH_REMATCH[2]}"
    if [[ "$bearer" != "ADMTOK.${s}.TOKMARK" ]]; then reply 401 '{}'; return 0; fi
    case "${method} ${sub}" in
        "GET users?username="*)
            if sw no-user; then reply 200 '[]'; return 0; fi
            ra='[]'
            if sw required-actions; then ra='["UPDATE_PASSWORD"]'; fi
            reply 200 "[{\"id\":\"uid-${s}\",\"username\":\"${FAKE_RET_USER:-$USERN}\",\"enabled\":true,\"requiredActions\":${ra}}]" ;;
        "PUT users/uid-${s}/reset-password")
            printf '%s' "$data" > "$D/cap-reset-${s}"
            if sw reset-forbidden; then reply 403 '{"error":"HTTP 403 Forbidden"}'
            elif sw reset-policy; then reply 400 '{"error":"invalidPasswordMinSpecialCharsMessage"}'
            else reply 204 ''; fi ;;
        "POST clients")
            printf '%s' "$data" > "$D/cap-client-${s}"
            id="$(jq -r '.clientId' <<< "$data")"
            mkdir -p "$D/clients/${s}"; : > "$D/clients/${s}/${id}"
            reply 201 '' ;;
        "GET clients?clientId="*)
            id="${sub#clients?clientId=}"
            if [[ -f "$D/clients/${s}/${id}" ]]; then reply 200 "[{\"id\":\"cid-${id}\",\"clientId\":\"${id}\"}]"; else reply 200 '[]'; fi ;;
        "DELETE clients/cid-"*)
            id="${sub#clients/cid-}"
            rm -f "$D/clients/${s}/${id}"
            printf '%s %s\n' "$s" "$id" >> "$D/deleted.log"
            reply 204 '' ;;
    esac
    return 0
}

route_nextcloud() { # method path bearer
    local method="$1" path="$2" bearer="$3" psub sub
    [[ "$path" =~ ^/remote\.php/dav/files/([^/]+)/(.*)$ ]] || return 0
    psub="${BASH_REMATCH[1]}"
    sub="$(jwt_claim "$bearer" .sub)"
    if [[ "$method" != PROPFIND ]]; then reply 405 '{}'; return 0; fi
    if [[ "$sub" == "$psub" ]] || sw dav-open; then reply 207 '<d:multistatus xmlns:d="DAV:"/>'; else reply 404 '<d:error/>'; fi
    return 0
}

route_platform() { # method path bearer data
    local path="$2" bearer="$3" s room
    case "$path" in
        /_matrix/client/v3/user/*/openid/request_token)
            s="${bearer#MXTOK.}"
            reply 200 "{\"access_token\":\"OID.${s}\",\"token_type\":\"Bearer\",\"matrix_server_name\":\"${PLAT}\",\"expires_in\":3600}" ;;
        /_matrix/client/v3/rooms/*/messages*|/_matrix/client/v3/rooms/*/send/*)
            [[ "$bearer" == MXTOK.* ]] || { reply 401 '{"errcode":"M_UNKNOWN_TOKEN"}'; return 0; }
            s="${bearer#MXTOK.}"
            room="${path#/_matrix/client/v3/rooms/}"; room="${room%%/*}"
            room="${room//%21/!}"; room="${room//%3A/:}"; room="${room//%3a/:}"
            if [[ "$room" == "!room-${s}:${PLAT}" ]] || sw matrix-open; then
                if [[ "$path" == */send/* ]]; then : > "$D/sent-${s}"; reply 200 '{"event_id":"ev"}'; else reply 200 '{"chunk":[]}'; fi
            else
                reply 403 '{"errcode":"M_FORBIDDEN","error":"not in room"}'
            fi ;;
    esac
    return 0
}

route_livekit() { # hostrealm data
    local oid room rr roomrealm prefix jwt
    prefix="t.${1}."
    oid="$(jq -r '.openid_token.access_token' <<< "$2")"
    room="$(jq -r '.room' <<< "$2")"
    rr="${oid#OID.}"
    roomrealm="${room#!room-}"; roomrealm="${roomrealm%%:*}"
    if sw livekit-open || [[ "$roomrealm" == "$rr" ]]; then
        if sw livekit-badprefix; then prefix="x."; fi
        jwt="$(mkjwt "{\"sub\":\"@u:${PLAT}\",\"video\":{\"room\":\"${prefix}stura-room-${roomrealm}\",\"roomJoin\":true}}")"
        reply 200 "{\"access_token\":\"${jwt}\",\"token_type\":\"Bearer\",\"expires_in\":3600}"
    else
        reply 403 '{"error":"caller is not a member of the requested room"}'
    fi
    return 0
}

route_customer() { # host method path bearer data
    local host="$1" method="$2" path="$3" bearer="$4" data="$5" hr s o iss word
    hr="$(realm_of_host "$host")"
    [[ -n "$hr" ]] || { reply 000 ''; return 0; }
    # the token endpoint of the host's own realm (the password grant)
    if [[ "$path" == "/auth/realms/${hr}/protocol/openid-connect/token" ]]; then
        local cid pw expect tok roles='["member"]' aud='["gremion-ui","nextcloud"]'
        cid="$(form_get "$data" client_id)"
        pw="$(form_get "$data" password)"
        if sw "grant-fail-${hr}" || [[ ! -f "$D/clients/${hr}/${cid}" ]]; then
            reply 400 '{"error":"invalid_grant","error_description":"Account is not fully set up"}'; return 0
        fi
        expect="$(jq -r '.value' < "$D/cap-reset-${hr}" 2>/dev/null)"
        if [[ "$pw" != "$expect" ]]; then reply 401 '{"error":"invalid_grant"}'; return 0; fi
        if sw no-member; then roles='[]'; fi
        if sw aud-missing; then aud='["gremion-ui"]'; fi
        tok="$(mkjwt "{\"iss\":\"https://${host}/auth/realms/${hr}\",\"sub\":\"sub-${hr}\",\"aud\":${aud},\"azp\":\"${cid}\",\"preferred_username\":\"${USERN}\",\"realm_access\":{\"roles\":${roles}},\"exp\":4102444800}")"
        reply 200 "{\"access_token\":\"${tok}\",\"token_type\":\"Bearer\"}"
        return 0
    fi
    if [[ "$path" == /livekit/jwt/get_token ]]; then route_livekit "$hr" "$data"; return 0; fi
    [[ "$path" == /api/* ]] || return 0
    if sw all401; then reply 401 '{"success":false,"error":"Unauthenticated"}'; return 0; fi
    [[ -n "$bearer" ]] || { reply 401 '{}'; return 0; }
    iss="$(jwt_claim "$bearer" .iss)"
    s="${iss##*/}"
    if [[ "$s" != "$hr" ]] && ! sw crosshost-open; then
        reply 401 '{"success":false,"error":"Unauthenticated"}'; return 0
    fi
    # a switch "moddis-<module>" turns that module off: the gate answers 403 'Module disabled'
    word=""
    case "$path" in
        /api/polls*) word=polls ;;
        /api/calendar/*) word=calendar ;;
        /api/files/*) word=files ;;
        /api/messages/*) word=messages ;;
    esac
    if [[ -n "$word" ]] && sw "moddis-${word}"; then reply 403 'Module disabled'; return 0; fi
    o="$(other "$s")"
    local id evs fl fn ef eh mx room pid pl
    case "$method ${path%%\?*}" in
        "GET /api/calendar/events")
            if sw no-event; then reply 200 '{"success":true,"data":[]}'; return 0; fi
            evs="{\"id\":\"ev-${s}\",\"title\":\"isoprobe-${s}\"}"
            if sw calendar-listing-leak; then evs+=",{\"id\":\"ev-${o}\",\"title\":\"isoprobe-${o}\"}"; fi
            reply 200 "{\"success\":true,\"data\":[${evs}]}" ;;
        "GET /api/calendar/events/"*)
            id="${path#/api/calendar/events/}"; id="${id%%\?*}"
            if [[ "$id" == "ev-${s}" ]]; then
                if sw calendar-own-500; then reply 500 '{}'; else reply 200 "{\"success\":true,\"data\":{\"id\":\"${id}\"}}"; fi
            elif sw calendar-open; then reply 200 "{\"success\":true,\"data\":{\"id\":\"${id}\"}}"
            else reply 404 '{"success":false,"error":"Not found"}'; fi ;;
        "GET /api/polls")
            if sw no-poll; then reply 200 '{"success":true,"data":[]}'; return 0; fi
            # the shape of GET /api/polls: raw NcPoll objects (modules/votes polls-client), the title under configuration
            pl="{\"id\":$(poll_id "$s"),\"type\":\"textPoll\",\"configuration\":{\"title\":\"isoprobe-${s}\",\"description\":\"\",\"allowComment\":false,\"anonymous\":false,\"expire\":0},\"status\":{\"expired\":false,\"countOptions\":2},\"currentUserStatus\":{\"userRole\":\"owner\",\"isLocked\":false,\"countVotes\":0}}"
            if sw polls-listing-leak; then pl+=",{\"id\":$(poll_id "$o"),\"type\":\"textPoll\",\"configuration\":{\"title\":\"isoprobe-${o}\"}}"; fi
            reply 200 "{\"success\":true,\"data\":[${pl}]}" ;;
        "GET /api/polls/"*)
            pid="${path#/api/polls/}"
            if [[ "$pid" == "$(poll_id "$s")" ]]; then
                if sw polls-own-404; then reply 404 '{}'; else reply 200 '{"success":true,"data":{}}'; fi
            elif sw polls-open; then reply 200 '{"success":true,"data":{}}'
            elif sw polls-500; then reply 500 '{}'
            else reply 404 '{"success":false,"error":"Poll unavailable"}'; fi ;;
        "GET /api/files/${UNIT}")
            fl="{\"path\":\"${UNIT}/isoprobe-${s}.odt\",\"name\":\"isoprobe-${s}.odt\",\"is_dir\":false}"
            if sw shared-folder; then fl+=",{\"path\":\"${UNIT}/isoprobe-${o}.odt\",\"name\":\"isoprobe-${o}.odt\",\"is_dir\":false}"; fi
            if sw no-file; then fl=""; fi
            reply 200 "{\"success\":true,\"files\":[${fl}]}" ;;
        "GET /api/files/${UNIT}/"*)
            fn="${path#"/api/files/${UNIT}/"}"
            if [[ "$fn" == "isoprobe-${s}.odt" ]] || sw shared-folder || sw files-open; then reply 200 'odt'; else reply 404 '{}'; fi ;;
        "GET /api/files/edit-token/${UNIT}/"*)
            ef="${path#"/api/files/edit-token/${UNIT}/"}"; eh="$host"
            if sw editor-origin-wrong; then eh="$(host_of_realm "$o")"; fi
            if [[ "$ef" == "isoprobe-${s}.odt" ]] || sw editor-open; then
                reply 200 "{\"token\":\"t\",\"tokenTtl\":1,\"editorUrl\":\"https://${eh}/office/browser/x/cool.html?WOPISrc=x\"}"
            elif sw editor-502; then reply 502 '{}'
            else reply 404 '{}'; fi ;;
        "GET /api/auth/matrix-token")
            mx="@u-${s}:${PLAT}"
            if sw same-mxid; then mx="@u-shared:${PLAT}"; fi
            reply 200 "{\"success\":true,\"data\":{\"matrixToken\":\"MXTOK.${s}\",\"matrixUserId\":\"${mx}\",\"matrixDeviceId\":\"D\"}}" ;;
        "GET /api/messages/rooms")
            room="!room-${s}:${PLAT}"
            if sw same-room; then room="!room-shared:${PLAT}"; fi
            if sw no-room; then reply 200 '{"success":true,"data":[]}'; return 0; fi
            reply 200 "{\"success\":true,\"data\":[{\"roomId\":\"${room}\",\"name\":\"${UNIT}\"}]}" ;;
        *) reply 404 '{}' ;;
    esac
    return 0
}

fake_curl() {
    local method=GET url="" cfg="" bearer data="" line
    OUT=""; WCODE=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -X) method="$2"; shift 2 ;;
            -K) cfg="$(cat)"; shift 2 ;;
            -w) WCODE=1; shift 2 ;;
            -o) OUT="$2"; shift 2 ;;
            --max-time|--resolve|-H|--cacert|--connect-timeout) shift 2 ;;
            -*) shift ;;
            *) url="$1"; shift ;;
        esac
    done
    if [[ -n "$cfg" ]]; then printf '%s\n---\n' "$cfg" >> "$D/stdin.log"; fi
    bearer="$(sed -n 's/^header = "Authorization: Bearer \(.*\)"$/\1/p' <<< "$cfg" | head -n1)"
    while IFS= read -r line; do
        case "$line" in
            'data = "'*) line="${line#data = \"}"; line="${line%\"}"; data+="${data:+&}$(unescape "$line")" ;;
            'data-urlencode = "'*) line="${line#data-urlencode = \"}"; data+="${data:+&}${line%\"}" ;;
        esac
    done <<< "$cfg"

    local rest hostport host path
    rest="${url#*://}"; hostport="${rest%%/*}"; path="/${rest#*/}"; host="${hostport%%:*}"
    reply 404 '{}'
    case "$host" in
        keycloak) route_keycloak "$method" "$path" "$bearer" "$data" ;;
        nextcloud) route_nextcloud "$method" "$path" "$bearer" ;;
        "$PLAT") route_platform "$method" "$path" "$bearer" "$data" ;;
        *) route_customer "$host" "$method" "$path" "$bearer" "$data" ;;
    esac
    # a shim that kills the program mid-run (the trap test): armed by a switch, fired once a section runs
    if [[ -f "$D/sw/kill-at-polls" && "$path" == /api/polls* && -f "$D/prog.pid" ]]; then
        kill -TERM "$(cat "$D/prog.pid")" 2>/dev/null
        sleep 1
    fi
    emit
}

fake_occ() { # args after `php occ`
    local sub realm
    case "$1" in
        groupfolders:list)
            # shared-folder: the app leaks too; shared-folder-id: ONLY the folder list holds one folder for both
            if sw shared-folder || sw shared-folder-id; then
                printf '[{"id":11,"mount_point":"%s","groups":{"ou-%s":{"permissions":31},"ou-%s":{"permissions":31}},"quota":-3,"size":0,"acl":false}]' "$UNIT" "$A" "$B"
            else
                printf '[{"id":11,"mount_point":"%s","groups":{"ou-%s":{"permissions":31}},"quota":-3,"size":0,"acl":false},{"id":12,"mount_point":"%s","groups":{"ou-%s":{"permissions":31}},"quota":-3,"size":0,"acl":false}]' "$UNIT" "$A" "$UNIT" "$B"
            fi ;;
        user:info)
            sub="$2"; realm="${2#sub-}"
            if sw user-in-no-group; then printf '{"user_id":"%s","groups":[]}' "$sub"; else printf '{"user_id":"%s","groups":["ou-%s"]}' "$sub" "$realm"; fi ;;
        *) return 1 ;;
    esac
}

fake_docker() {
    case "${1:-}" in
        ps) printf 'c-nextcloud\n' ;;
        exec)
            shift
            while [[ "${1:-}" == -* ]]; do
                case "$1" in -u|-e|-w) shift 2 ;; *) shift ;; esac
            done
            shift   # the container
            case "${1:-}" in
                curl) shift; fake_curl "$@" ;;
                php) shift; shift; fake_occ "$@" ;;
                *) return 1 ;;
            esac ;;
        *) return 0 ;;
    esac
}

what="$1"; shift
case "$what" in
    docker) fake_docker "$@" ;;
    curl) fake_curl "$@" ;;
esac
