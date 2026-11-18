#!/usr/bin/env bash
# test/host/test_helper/cd-github.bash -- the test helper of cd-github.bats.
#
# Load it AFTER test_helper/host and test_helper/cd:
#     load 'test_helper/host'
#     load 'test_helper/cd'
#     load 'test_helper/cd-github'
#
# WHAT IT GIVES A TEST
#   gh_setup / gh_teardown   a throwaway root (cd_setup), the repo URL
#                            https://github.com/org/repo redirected to a temporary bare repo
#                            by git's url.<path>.insteadOf (GIT_CONFIG_COUNT env), a
#                            recording git shim that runs the real git, and a curl shim that
#                            serves trimmed answers
#   gh_lib 'snippet' args    a fresh bash with common.sh, core.sh, cmd-state.sh, github.sh
#                            and then the stubs, with the config loaded (use with `run`)
#   gh_commit NAME / gh_merge NAME / gh_publish   build the history of the "remote"
#   gh_route PATTERN STATUS BODY [HEADERS]        what the curl shim answers (newest wins)
#   gh_calls                 the number of curl calls so far
#
# THE CURL SHIM never reaches a network. It reads the curl config from stdin (`-K -`), records
# the url, the whole config and the environment of every call in $GH, and answers from
# $GH/routes: one line per route, "<glob of the url> TAB <status> TAB <body file> TAB
# <header lines joined by ;>". Status TIMEOUT exits 28 as curl does after --max-time; status
# 401A answers 401 when the request carried an Authorization header and 200 otherwise.

GH_FIX="${HOST_TEST_DIR}/fixtures/cd/github"

# gh_rg ARGS -- the REAL git binary (the shim on PATH only records what the program under
# test runs).
gh_rg() {
    "$GH_REAL_GIT" "$@"
}

gh_setup() {
    cd_setup
    GH="${GREMION_ROOT}/.gh"
    mkdir -p "${GH}/b"
    : > "${GH}/urls.log"
    : > "${GH}/routes"
    printf '{}\n' > "${GH}/empty-object.json"
    export GH
    GH_REAL_GIT="$(command -v git)"
    export GH_REAL_GIT
    GH_WORK="${GREMION_ROOT}/.work"
    GH_REMOTE="${GREMION_ROOT}/remote.git"
    GH_PROOF="${GREMION_ROOT}/proof.git"
    export GIT_CONFIG_COUNT=2
    export GIT_CONFIG_KEY_0="url.${GH_REMOTE}.insteadOf" GIT_CONFIG_VALUE_0="https://github.com/org/repo"
    export GIT_CONFIG_KEY_1="url.${GH_PROOF}.insteadOf" GIT_CONFIG_VALUE_1="https://example.org/proof/repo"
    export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.org GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.org
    GH_ID=1000
    cd_write_cfg CD_REPO_URL=https://github.com/org/repo
    gh_shim_git
    gh_shim_curl
}

gh_teardown() {
    cd_teardown
}

gh_shim_git() {
    shim git 'exec "$GH_REAL_GIT" "$@"'
}

gh_shim_curl() {
    shim curl "$(cat <<'EOF'
cfg="$(cat)"
n=$(( $(wc -l < "$GH/urls.log") + 1 ))
url="$(printf '%s\n' "$cfg" | sed -n 's/^url = "\(.*\)"$/\1/p')"
out="$(printf '%s\n' "$cfg" | sed -n 's/^output = "\(.*\)"$/\1/p')"
hdr="$(printf '%s\n' "$cfg" | sed -n 's/^dump-header = "\(.*\)"$/\1/p')"
printf '%s\n' "$url" >> "$GH/urls.log"
printf '%s\n' "$cfg" > "$GH/stdin.$n"
env > "$GH/env.$n"
status=404
body="$GH/empty-object.json"
extra=""
while IFS=$'\t' read -r pat st bf ex; do
    [ -n "$pat" ] || continue
    case "$url" in
        $pat) status="$st"; body="$bf"; extra="$ex"; break ;;
    esac
done < "$GH/routes"
case "$status" in
    TIMEOUT) exit 28 ;;
    401A)
        if printf '%s' "$cfg" | grep -q '^header = "Authorization:'; then status=401; else status=200; fi
        ;;
esac
{
    printf 'HTTP/2 %s\r\n' "$status"
    if [ -n "$extra" ]; then printf '%s' "$extra" | tr ';' '\n' | sed 's/$/\r/'; fi
} > "$hdr"
if [ "$body" = EMPTY ]; then : > "$out"; else cat "$body" > "$out"; fi
printf '%s' "$status"
EOF
)"
}

# gh_route PATTERN STATUS [BODYFILE] [HEADERS] -- the newest route wins.
gh_route() {
    local pat="$1" st="$2" bf="${3:-${GH}/empty-object.json}" ex="${4:-}"
    {
        printf '%s\t%s\t%s\t%s\n' "$pat" "$st" "$bf" "$ex"
        cat "${GH}/routes"
    } > "${GH}/routes.new"
    mv -f "${GH}/routes.new" "${GH}/routes"
}

gh_calls() { wc -l < "${GH}/urls.log" | tr -d ' '; }

# gh_body NAME SHA [JQ_FILTER] -- a trimmed answer with the placeholder SHA filled and the
# filter applied; prints the file.
gh_body() {
    local name="$1" sha="$2" filter="${3:-.}" out
    out="$(mktemp "${GH}/b/XXXXXX.json")"
    sed "s/__SHA__/${sha}/g" "${GH_FIX}/${name}.json" | jq "$filter" > "$out"
    printf '%s' "$out"
}

# gh_prs FILTER SHA... -- a json array of merged pull requests, one per merge commit sha.
gh_prs() {
    local filter="$1" out sha
    shift
    out="$(mktemp "${GH}/b/XXXXXX.json")"
    for sha in "$@"; do
        sed "s/__SHA__/${sha}/g" "${GH_FIX}/pull-merged.json"
    done | jq -s "$filter" > "$out"
    printf '%s' "$out"
}

# gh_iso OFFSET -- the fake clock plus OFFSET seconds, as the API writes it.
gh_iso() {
    date -u -d "@$(( $(cd_clock) + $1 ))" +%Y-%m-%dT%H:%M:%SZ
}

# -- the history of the remote -------------------------------------------------
gh_hist_init() {
    # a clean slate: a test may build several scenarios one after the other
    rm -rf "$GH_WORK" "$GH_REMOTE" "$GH_PROOF" "${GREMION_ROOT}/data/cd/mirror.git" "${GREMION_ROOT}/data/cd/cache" \
        "${GREMION_ROOT}/data/cd/gh-calls" "${GREMION_ROOT}/data/cd/gh-calls.lock" \
        "${GREMION_ROOT}/data/cd/gh-ratelimit" "${GREMION_ROOT}/data/cd/gh-token-bad" \
        "${GREMION_ROOT}/data/cd/history.jsonl" "${GREMION_ROOT}/data/cd/blocked.json"
    rm -f "${GH}"/stdin.* "${GH}"/env.* "${GH}"/b/*
    : > "${GH}/urls.log"
    : > "${GH}/routes"
    : > "$SHIM_LOG"
    GH_ID=1000
    gh_rg init -q -b main "$GH_WORK"
    gh_rg -C "$GH_WORK" commit -q --allow-empty -m L0
    C_L0="$(gh_rg -C "$GH_WORK" rev-parse HEAD)"
}

# gh_commit NAME -- an empty commit on main; its sha is in C_<NAME>.
gh_commit() {
    gh_rg -C "$GH_WORK" checkout -q main
    gh_rg -C "$GH_WORK" commit -q --allow-empty -m "$1"
    printf -v "C_$1" '%s' "$(gh_rg -C "$GH_WORK" rev-parse HEAD)"
}

# gh_merge NAME -- a merge commit on main (first parent = main) of a side commit; C_<NAME>
# is the merge commit and C_<NAME>_SIDE the side commit.
gh_merge() {
    local name="$1"
    gh_rg -C "$GH_WORK" checkout -q main
    gh_rg -C "$GH_WORK" checkout -q -b "side-${name}"
    gh_rg -C "$GH_WORK" commit -q --allow-empty -m "${name}-side"
    printf -v "C_${name}_SIDE" '%s' "$(gh_rg -C "$GH_WORK" rev-parse HEAD)"
    gh_rg -C "$GH_WORK" checkout -q main
    gh_rg -C "$GH_WORK" merge -q --no-ff -m "$name" "side-${name}"
    printf -v "C_${name}" '%s' "$(gh_rg -C "$GH_WORK" rev-parse HEAD)"
}

# gh_publish -- push main (and, with an argument, that extra branch) to the bare remote.
gh_publish() {
    [[ -d "$GH_REMOTE" ]] || gh_rg init -q --bare "$GH_REMOTE"
    gh_rg -C "$GH_WORK" push -q --force "$GH_REMOTE" main:main
    if [[ -n "${1:-}" ]]; then
        gh_rg -C "$GH_WORK" push -q --force "$GH_REMOTE" "${1}:${1}"
    fi
}

# gh_seed_live SHA [JQ_FILTER] -- the state: idle, live = SHA, then the optional filter.
gh_seed_live() {
    local live
    live="$(printf '%s' "$CD_LIVE_JSON" | jq -c --arg s "$1" '.sha = $s | .sha12 = $s[0:12] | .tag = ("pilot-" + .sha12)')"
    cd_seed_state ".live = ${live}${2:+ | $2}"
}

# gh_route_ci SHA [RUN_FILTER] [JOBS_FILTER] -- a successful run of SHA (with its own id)
# and its jobs. The filters edit the run list answer and the job list answer.
gh_route_ci() {
    local sha="$1" rf="${2:-.}" jf="${3:-.}" id run jobs
    GH_ID=$((GH_ID + 1))
    id="$GH_ID"
    run="$(gh_body run-push-success "$sha" ".workflow_runs[0].id = ${id} | ${rf}")"
    jobs="$(gh_body jobs-ci "$sha" "$jf")"
    gh_route "*/workflows/ci.yml/runs?*head_sha=${sha}*" 200 "$run"
    gh_route "*/actions/runs/${id}/attempts/*/jobs?*" 200 "$jobs"
    GH_LAST_ID="$id"
}

# gh_route_pulls SHA... -- the closed pull request list (one page) with those merge commits.
gh_route_pulls() {
    gh_route "*/pulls?state=closed*" 200 "$(gh_prs . "$@")"
}

gh_route_rules() {
    gh_route "*/rules/branches/main" 200 "$(gh_body rules-main none "${1:-.}")"
}

# gh_no_run SHA -- the run list of SHA is empty.
gh_no_run() {
    local f
    f="$(mktemp "${GH}/b/XXXXXX.json")"
    printf '{"total_count":0,"workflow_runs":[]}\n' > "$f"
    gh_route "*/workflows/ci.yml/runs?*head_sha=${1}*" 200 "$f"
}

# gh_scn_green -- L0 (live) - A - B (the tip): everything green, two squash pull requests,
# the rules in force. C_L0 C_A C_B are set; the state is seeded; four calls make a verdict.
gh_scn_green() {
    gh_hist_init
    gh_commit A
    gh_commit B
    gh_publish
    gh_seed_live "$C_L0"
    gh_route_ci "$C_B"
    gh_route_ci "$C_A"
    gh_route_pulls "$C_A" "$C_B"
    gh_route_rules
}

# gh_lib 'snippet' args... -- run a snippet with the libraries and the config loaded.
gh_lib() {
    local snippet="$1"
    shift
    bash -c "set -euo pipefail
. \"\${HOST_SRC}/lib/common.sh\"
. \"\${HOST_SRC}/lib/cd/core.sh\"
. \"\${HOST_SRC}/lib/cd/cmd-state.sh\"
. \"\${HOST_SRC}/lib/cd/github.sh\"
. \"\${GREMION_CD_STUBS_DIR}/cd-stubs.sh\"
cd_cfg_load
${snippet}" gh-lib "$@"
}

# gh_lib_notify 'snippet' args -- gh_lib with the REAL notifier loaded before the stubs (the
# stubs step aside for real functions), so what github.sh hands to cd_notify meets the
# notifier's own allow-list and shape checks.
gh_lib_notify() {
    local snippet="$1"
    shift
    bash -c "set -euo pipefail
. \"\${HOST_SRC}/lib/common.sh\"
. \"\${HOST_SRC}/lib/cd/core.sh\"
. \"\${HOST_SRC}/lib/cd/cmd-state.sh\"
. \"\${HOST_SRC}/lib/cd/notify.sh\"
. \"\${HOST_SRC}/lib/cd/github.sh\"
. \"\${GREMION_CD_STUBS_DIR}/cd-stubs.sh\"
cd_cfg_load
${snippet}" gh-lib-notify "$@"
}

# gh_verdict [ARGS] -- run cd_gh_candidate; sets V (verdict), R (reason), S (sha), and
# leaves the json in $output.
gh_verdict() {
    run --separate-stderr gh_lib 'cd_gh_candidate "$@"' "$@"
    V="$(printf '%s' "$output" | jq -r '.verdict // "NOJSON"' 2>/dev/null)" || V=NOJSON
    R="$(printf '%s' "$output" | jq -r '.reason // ""' 2>/dev/null)" || R=""
    S="$(printf '%s' "$output" | jq -r '.sha // ""' 2>/dev/null)" || S=""
}
