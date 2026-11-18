#!/usr/bin/env bash
# test/host/test_helper/cd-notify.bash -- shared by cd-notify.bats and cd-watchdog.bats.
#
#     load 'test_helper/host'
#     load 'test_helper/cd'
#     load 'test_helper/cd-notify'
#
# nlib 'snippet'      a fresh bash that sources core.sh, cmd-state.sh, notify.sh and
#                     watchdog.sh (then the stubs, which step aside for real functions),
#                     loads etc/cd.env, then runs the snippet (use with `run`)
# notify_setup        cd_setup plus: TZ=UTC, a `gremion-mail` at $GREMION_ROOT/bin (where the
#                     program looks for it) that answers `transport` and `relay-curl-config`
#                     (a curl config that carries a recognisable password), and a `curl`
#                     shim that records argv and environment and keeps what it read on stdin
# mail_files          the queued files, one per line
# curl_calls          how many times curl ran
#
# Every address is a reserved example name; the "relay password" is the constant
# RELAY_PW below, so a test can prove it never leaves curl's stdin.

RELAY_PW="SEKRET-relay-pw-4711"

nlib() {
    local snippet="$1"
    shift
    bash -c "set -euo pipefail
. \"\${HOST_SRC}/lib/common.sh\"
. \"\${HOST_SRC}/lib/cd/core.sh\"
. \"\${HOST_SRC}/lib/cd/cmd-state.sh\"
. \"\${HOST_SRC}/lib/cd/notify.sh\"
. \"\${HOST_SRC}/lib/cd/watchdog.sh\"
. \"\${GREMION_CD_STUBS_DIR}/cd-stubs.sh\"
cd_cfg_load
${snippet}" nlib "$@"
}

notify_setup() {
    cd_setup
    export TZ=UTC
    local mailbin="${GREMION_ROOT}/bin/gremion-mail"
    mkdir -p "${GREMION_ROOT}/bin"
    cat > "$mailbin" <<SH
#!/usr/bin/env bash
printf 'gremion-mail %s\n' "\$*" >> "\$SHIM_LOG"
case "\$1" in
    transport) cat "\${GREMION_ROOT}/.transport" 2>/dev/null || echo relay ;;
    relay-curl-config)
        msg=""
        while [ \$# -gt 0 ]; do [ "\$1" = --message ] && msg="\$2"; shift; done
        printf 'url = "smtp://relay.example.org:587"\nssl-reqd\nmail-from = "system@example.org"\nmail-rcpt = "ops@example.org"\nupload-file = "%s"\nuser = "u:${RELAY_PW}"\n' "\$msg" ;;
esac
exit 0
SH
    chmod +x "$mailbin"
    shim curl "$(cat <<'SH'
env > "$GREMION_ROOT/.curl-env.$$"
cat > "$GREMION_ROOT/.curl-stdin.$$"
cat "$GREMION_ROOT/.curl-stdin.$$" >> "$GREMION_ROOT/.curl-stdin.all"
[ -f "$GREMION_ROOT/.curl-fail" ] && exit 7
up="$(sed -n 's/^upload-file = "\(.*\)"$/\1/p' "$GREMION_ROOT/.curl-stdin.$$")"
[ -n "$up" ] && [ -f "$up" ] && cp "$up" "$GREMION_ROOT/.sent.$(date +%s%N)"
exit 0
SH
)"
}

sent_count() { find "${GREMION_ROOT}" -maxdepth 1 -name '.sent.*' | wc -l | tr -d ' '; }
# refute_in FILE STRING -- fails (with the file) when STRING occurs in FILE.
refute_in() {
    if grep -qF -- "$2" "$1"; then
        echo "FAIL: '$2' occurs in $1" >&2
        cat "$1" >&2
        return 1
    fi
    return 0
}
mail_files() { find "${GREMION_ROOT}/data/cd/outbox" -maxdepth 1 -name '[0-9]*.eml' 2>/dev/null | LC_ALL=C sort; }
mail_count() { mail_files | wc -l | tr -d ' '; }
curl_calls() { grep -c '^curl ' "$SHIM_LOG" || true; }
