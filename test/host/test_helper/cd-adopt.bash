#!/usr/bin/env bash
# test/host/test_helper/cd-adopt.bash -- the fake host root of cd-adopt.bats.
#
#     load 'test_helper/host'
#     load 'test_helper/cd'
#     load 'test_helper/cd-notify'
#     load 'test_helper/cd-adopt'
#
# ad_setup            notify_setup (cd_setup, the mail shim, the curl shim) plus a running
#                     host: two release trees (A live on blue, B on green), env files, the
#                     `current` link, runtime/active-colour, containers and images behind a
#                     docker shim, a sudo shim, a systemctl shim, the dump directory
# adlib 'snippet'    a fresh bash (errexit ON, like a verb under the dispatcher) with the real
#                     libraries core, cmd-state, docker, classify, colour, prepare, data,
#                     notify and adopt, then the stubs. AD_OVERRIDE="fn ..." turns a real
#                     function back into a recording stub (it answers what cd_stub_set says)
# ad_make_tree MARK   a git work tree under releases/<sha12>; prints the full SHA
# ad_set_live COLOUR SHA   make COLOUR the serving colour at that release (env tag, current
#                     link, active-colour, running containers with the right image id)
# ad_set_other COLOUR SHA|none   the other colour's env tag
#
# Every name is a reserved example name; the "customers" are never named: the one psql the
# program runs answers a count from a file.

# the six units of the cd program: the only unit files the host backup holds
AD_CD_UNITS=(gremion-cd.service gremion-cd.timer gremion-cd-watchdog.service gremion-cd-watchdog.timer
    gremion-cd-resume.service 'gremion-cd-apply@.service')

ad_git() {
    env GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.org GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.org \
        git "$@"
}

# ad_image_id TAG -- a stable fake image id for a tag.
ad_image_id() { printf 'sha256:%s\n' "$(printf '%s' "$1" | sha256sum | cut -c1-64)"; }

ad_make_tree() {
    local mark="$1" w="${GREMION_ROOT}/.work-${1}" sha
    rm -rf "$w"
    mkdir -p "$w/infra/host/bin" "$w/infra/host/lib/cd" "$w/infra/host/templates/systemd" \
        "$w/infra/host/templates/nftables" "$w/infra/host/templates/env"
    printf '#!/bin/sh\necho prog %s\n' "$mark" > "$w/infra/host/bin/gremion-x"
    chmod +x "$w/infra/host/bin/gremion-x"
    printf '#!/bin/sh\necho tenant %s\n' "$mark" > "$w/infra/host/bin/gremion-tenant"
    chmod +x "$w/infra/host/bin/gremion-tenant"
    printf '# common %s\n' "$mark" > "$w/infra/host/lib/common.sh"
    printf '# core %s\n' "$mark" > "$w/infra/host/lib/cd/core.sh"
    printf '#!/bin/sh\necho boot %s\n' "$mark" > "$w/infra/host/bootstrap.sh"
    printf '[Unit]\nDescription=x %s\n' "$mark" > "$w/infra/host/templates/systemd/gremion-x.service"
    printf 'nft %s\n' "$mark" > "$w/infra/host/templates/nftables/gremion.nft.tmpl"
    printf 'K=%s\n' "$mark" > "$w/infra/host/templates/env/x.env.tmpl"
    printf 'readme %s\n' "$mark" > "$w/README.md"
    ad_git -C "$w" init -q -b main
    ad_git -C "$w" add -A
    ad_git -C "$w" commit -q -m "tree $mark"
    sha="$(ad_git -C "$w" rev-parse HEAD)"
    mv "$w" "${GREMION_ROOT}/releases/${sha:0:12}"
    printf '%s\n' "$sha"
}

# ad_container COLOUR SHA -- one running first-party container of the colour, at the image its
# own tag resolves to.
ad_container() {
    local colour="$1" tag="pilot-${2:0:12}" cid="cid${1}"
    printf '%s\n' "$cid" > "${DK}/cids.teststack-app-${colour}"
    printf 'gremion-ui:%s %s\n' "$tag" "$(ad_image_id "$tag")" > "${DK}/imgline.${cid}"
    ad_image_ref "gremion-ui:${tag}" "$(ad_image_id "$tag")"
}

ad_image_ref() { printf '%s\n' "$2" > "${DK}/image.$(printf '%s' "$1" | tr '/:' '__')"; }

ad_set_env_tag() { # COLOUR TAG
    sed "s#@TAG@#${2}#" "${HOST_TEST_DIR}/fixtures/cd/adopt/app-${1}.env" > "${GREMION_ROOT}/etc/env/app-${1}.env"
}

ad_set_live() { # COLOUR SHA
    local colour="$1" sha="$2"
    ad_set_env_tag "$colour" "pilot-${sha:0:12}"
    ln -sfn "${GREMION_ROOT}/releases/${sha:0:12}" "${GREMION_ROOT}/current"
    printf '%s\n' "$colour" > "${GREMION_ROOT}/runtime/active-colour"
    ad_container "$colour" "$sha"
}

ad_set_other() { # COLOUR SHA|none
    if [[ "$2" == none ]]; then
        ad_set_env_tag "$1" "latest"
    else
        ad_set_env_tag "$1" "pilot-${2:0:12}"
    fi
}

ad_shim_docker() {
    shim docker "$(cat <<'EOF'
(IFS='|'; printf '%s\n' "$*" >> "$DK/argv.log")
case "$1" in
  ps)
    proj=''; svc=''
    for a in "$@"; do
      case "$a" in
        label=com.docker.compose.project=*) proj="${a#label=com.docker.compose.project=}" ;;
        label=com.docker.compose.service=*) svc="${a#label=com.docker.compose.service=}" ;;
      esac
    done
    [ -f "$DK/ps.fail" ] && exit 1
    if [ -n "$svc" ]; then [ -f "$DK/cid.$proj.$svc" ] && cat "$DK/cid.$proj.$svc"
    else [ -f "$DK/cids.$proj" ] && cat "$DK/cids.$proj"; fi
    exit 0 ;;
  inspect)
    cid="${@: -1}"
    cat "$DK/imgline.$cid" 2>/dev/null || exit 1
    exit 0 ;;
  image)
    ref="${@: -1}"; key=$(printf '%s' "$ref" | tr '/:' '__')
    [ -f "$DK/image.$key" ] || { echo "Error: No such image: $ref" >&2; exit 1; }
    cat "$DK/image.$key"
    exit 0 ;;
  info)
    [ -f "$DK/docker.down" ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
    case "$*" in
      *DockerRootDir*) echo "$DK/droot" ;;
      *) echo 27.0.0 ;;
    esac
    exit 0 ;;
  exec)
    cat > "$DK/psql.stdin"
    (IFS='|'; printf '%s\n' "$*" > "$DK/psql.argv")
    [ -f "$DK/psql.fail" ] && exit 1
    cat "$DK/psql.count" 2>/dev/null || echo 1
    exit 0 ;;
  compose)
    case " $* " in
      *" pull "*) [ -f "$DK/pull.fail" ] && { cat "$DK/pull.fail" >&2; exit 1; } ;;
    esac
    case " $* " in
      *" build"*) [ -f "$DK/build.fail" ] && { cat "$DK/build.fail" >&2; exit 1; } ;;
      *" up "*) [ -f "$DK/up.fail" ] && exit 1 ;;
    esac
    exit 0 ;;
esac
exit 0
EOF
)"
}

ad_setup() {
    notify_setup
    export STACK=teststack
    DK="${SHIM_DIR}/dk"
    export DK
    mkdir -p "$DK" "${DK}/droot" "${GREMION_ROOT}/runtime/workers" "${GREMION_ROOT}/data/migration-dumps"
    chmod 700 "${GREMION_ROOT}/data/migration-dumps"
    sed "s#@ROOT@#${GREMION_ROOT}#" "${HOST_TEST_DIR}/fixtures/cd/adopt/state.env" > "${GREMION_ROOT}/etc/env/state.env"
    SHA_A="$(ad_make_tree A)"
    SHA_B="$(ad_make_tree B)"
    export SHA_A SHA_B
    A12="${SHA_A:0:12}"
    B12="${SHA_B:0:12}"
    export A12 B12
    ad_set_live blue "$SHA_A"
    ad_set_other green "$SHA_B"
    ad_image_ref "gremion-ui:pilot-${B12}" "$(ad_image_id "pilot-${B12}")"
    ad_shim_docker
    # sudo: record the call and the state of the host-backup place and of the manifest at that moment
    shim sudo "$(cat <<'EOF'
{
  if [ -L "$GREMION_ROOT/data/cd/host-backup/pending" ]; then echo "pending=$(readlink "$GREMION_ROOT/data/cd/host-backup/pending")"; else echo pending=none; fi
  if [ -f "$GREMION_ROOT/data/cd/host-manifest.json" ]; then echo "manifest=$(sha256sum < "$GREMION_ROOT/data/cd/host-manifest.json" | cut -c1-64)"; else echo manifest=none; fi
} >> "$DK/sudo.seen"
[ -f "$GREMION_ROOT/.sudo.rc" ] && exit "$(cat "$GREMION_ROOT/.sudo.rc")"
exit 0
EOF
)"
    shim systemctl 'cat "$DK/timers.json" 2>/dev/null || exit 1'
    ad_timers_json
    # the hosts' installed set and a systemd directory
    GREMION_CD_SYSTEMD_DIR="${GREMION_ROOT}/.systemd"
    export GREMION_CD_SYSTEMD_DIR
    mkdir -p "$GREMION_CD_SYSTEMD_DIR" "${GREMION_ROOT}/lib/cd"
    printf '#!/bin/sh\necho installed gremion-x\n' > "${GREMION_ROOT}/bin/gremion-x"
    chmod 755 "${GREMION_ROOT}/bin/gremion-x"
    printf '# installed common\n' > "${GREMION_ROOT}/lib/common.sh"
    printf '# installed core\n' > "${GREMION_ROOT}/lib/cd/core.sh"
    printf '#!/bin/sh\necho installed gremion-cd\n' > "${GREMION_ROOT}/bin/gremion-cd"
    chmod 755 "${GREMION_ROOT}/bin/gremion-cd"
    printf '#!/bin/sh\necho installed apply-root\n' > "${GREMION_ROOT}/lib/cd/apply-root.sh"
    chmod 755 "${GREMION_ROOT}/lib/cd/apply-root.sh"
    for u in "${AD_CD_UNITS[@]}"; do
        printf '[Unit]\nDescription=installed %s\n' "$u" > "${GREMION_CD_SYSTEMD_DIR}/${u}"
    done
    # files the set must NOT take: they lie outside what the root restore accepts
    printf '[Unit]\nDescription=other\n' > "${GREMION_CD_SYSTEMD_DIR}/unrelated.service"
    printf '[Unit]\nDescription=backup\n' > "${GREMION_CD_SYSTEMD_DIR}/gremion-backup.service"
    printf '# access log\n' > "${GREMION_ROOT}/lib/access-log.sh"
    printf 'notes\n' > "${GREMION_ROOT}/lib/cd/notes.txt"
    ad_write_prelude
    printf '1\n' > "${DK}/psql.count"
    cd_write_cfg CD_MIN_FREE_GB=0
}

# ad_timers_json [MISSING_UNIT] -- both guard timers a day away, optionally without one.
ad_timers_json() {
    local now=1700000000
    jq -n --argjson b $(( (now + 86400) * 1000000 )) --argjson p $(( (now + 90000) * 1000000 )) --arg miss "${1:-}" '
        [{unit: "gremion-cd.timer", next: (($b + 5)), activates: "gremion-cd.service"},
         {unit: "gremion-backup.timer", next: $b, activates: "gremion-backup.service"},
         {unit: "gremion-purge.timer", next: $p, activates: "gremion-purge.service"}]
        | map(select(.unit != $miss))' > "${DK}/timers.json"
}

ad_write_prelude() {
    cat > "${GREMION_ROOT}/.adlib.sh" <<'EOF'
. "${HOST_SRC}/lib/common.sh"
for l in core cmd-state docker classify colour prepare data notify adopt; do
    . "${HOST_SRC}/lib/cd/${l}.sh"
done
if [ -n "${AD_REAL_GH:-}" ]; then
    . "${HOST_SRC}/lib/cd/github.sh"
fi
. "${GREMION_CD_STUBS_DIR}/cd-stubs.sh"
for f in ${AD_OVERRIDE:-}; do
    eval "${f}() { _cd_stub_call ${f} \"\$@\"; }"
done
cd_paths_init
cd_cfg_load
EOF
}

adlib() {
    local snippet="$1"
    shift
    bash -c "set -euo pipefail
. \"\${GREMION_ROOT}/.adlib.sh\"
${snippet}" adlib "$@"
}

# ad_real_github RULES_JSON -- the REAL github.sh (rules and merge-method checks) over a curl
# shim that answers the branch rules from RULES_JSON (and still takes the mail relay's calls).
# cd_gh_tip stays a stub: it would run git ls-remote against the network.
ad_real_github() {
    export AD_REAL_GH=1
    export AD_OVERRIDE="cd_gh_tip"
    cd_write_cfg CD_MIN_FREE_GB=0 CD_REPO_URL=https://github.com/example-org/example-repo
    cp "$1" "${GREMION_ROOT}/.gh-rules.json"
    shim curl "$(cat <<'EOF'
cfg="$(cat)"
printf '%s\n' "$cfg" >> "$GREMION_ROOT/.curl-stdin.all"
case "$cfg" in
  *'dump-header'*)
    body="$(printf '%s\n' "$cfg" | sed -n 's/^output = "\(.*\)"$/\1/p')"
    hdr="$(printf '%s\n' "$cfg" | sed -n 's/^dump-header = "\(.*\)"$/\1/p')"
    url="$(printf '%s\n' "$cfg" | sed -n 's/^url = "\(.*\)"$/\1/p')"
    printf 'HTTP/2 200\r\nx-ratelimit-remaining: 4000\r\n' > "$hdr"
    case "$url" in
      */rules/branches/main) cp "$GREMION_ROOT/.gh-rules.json" "$body"; printf 200 ;;
      *) printf 404 ;;
    esac
    exit 0 ;;
esac
[ -f "$GREMION_ROOT/.curl-fail" ] && exit 7
up="$(printf '%s\n' "$cfg" | sed -n 's/^upload-file = "\(.*\)"$/\1/p')"
[ -n "$up" ] && [ -f "$up" ] && cp "$up" "$GREMION_ROOT/.sent.$(date +%s%N)"
exit 0
EOF
)"
}

# ad_nothing_written -- a refused adopt leaves no state, no manifest and no mail.
ad_nothing_written() {
    [[ ! -e "${GREMION_ROOT}/data/cd/state.json" ]] || { echo "a state file was written" >&2; return 1; }
    [[ ! -e "${GREMION_ROOT}/data/cd/host-manifest.json" ]] || { echo "a manifest was written" >&2; return 1; }
    [[ "$(mail_count)" == 0 ]] || { echo "a mail was queued" >&2; return 1; }
    return 0
}
