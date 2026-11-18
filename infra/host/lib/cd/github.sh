#!/usr/bin/env bash
# infra/host/lib/cd/github.sh -- pick-up of the continuous deployment program: the tip of
# main, the mirror, the budgeted GitHub reads, the verdict walk, the proof that every commit
# of the range came from a merged pull request, the rules check and the proof-mode source.
#
# SOURCED, NEVER EXECUTED. Like common.sh and core.sh it sets no shell options and runs
# nothing at the top level except plain assignments. It needs core.sh (config, clock, state,
# history, hold) and the dispatcher's order (core first).
#
# FAIL CLOSED. Anything other than a parsed HTTP 200 of the expected shape is "no verdict":
# a 304, a 403, a 429, a 5xx, a timeout, an empty body, invalid JSON, a JSON of the wrong
# shape, a truncated page, an exhausted budget. "No verdict" never becomes "green".
#
# FUNCTIONS (return codes: 0 ok, 1 not as expected or no verdict, 2 usage or a missing
# precondition, 3 out of budget or rate limited, retry later)
#   cd_gh_tip                    the tip of refs/heads/main by the git protocol (no API call)
#   cd_gh_mirror_fetch           fetch refs/heads/main (a named ref) into data/cd/mirror.git;
#                                prints the fetched tip
#   cd_gh_api PATH [SHAPE_JQ]    one budgeted GET of the REST API; prints the body only for a
#                                parsed 200 that passes SHAPE_JQ
#   cd_gh_budget_left            prints the calls left this hour; 0 when there are some
#   cd_gh_calls_hour             prints the calls made in the last hour
#   cd_gh_rules_ok               the four rules of the protected branch (prints the missing
#                                rule types on 1)
#   cd_gh_merge_methods_ok       allowed merge methods exactly `squash` plus linear history
#   cd_gh_candidate [FLAGS] [SHA]  the verdict (see below)
#   cd_gh_cache_get KEY / cd_gh_cache_put KEY VALUE   immutable facts only
#   cd_gh_proof_source SHA REF   proof mode only: fetch the branch of CD_PROOF_REPO
#   cd_cmd_poll [SHA]            verb: the dry run of cd_gh_candidate
#
# cd_gh_candidate prints ONE json line {"verdict","sha","reason", ...} and returns 0 for
# every verdict (2 when it cannot run at all). verdict is
#   green     a commit that may be released (sha), proven by a successful push run of ci.yml
#             on main, one successful "Verify gate" job and a merged pull request for every
#             first-parent commit of live..sha, with the branch rules still in force
#   pending   the run of that commit has not finished (younger than CD_PENDING_MAX_MIN)
#   none      nothing to release: reason up_to_date, tip_unchanged, recheck_wait or
#             no_green_commit (CD_WALKBACK commits looked at, none green)
#   unknown   no verdict (reason names the transport or shape problem; never cached)
#   hold      a named hold: not_ancestor, batch_too_large, blocked, range_unverified (with
#             "uncovered": the short SHAs) or ruleset_missing
# Flags: --dry-run (no mail, no state write), --accept-range REASON (the operator override
# of range_unverified; logged), --allow-blocked and --allow-batch (release-now of a
# candidate that contains a block, or a batch above CD_MAX_BATCH). One positional argument
# names the commit to judge instead of the tip (release-now; 12 to 40 hex).
#
# THE STATE THIS FILE READS (the driver writes it, this file never writes poll): poll.tip12,
# poll.verdict and poll.last_at. A tip that equals the live commit, or equals the tip of a
# FINAL last verdict (poll.verdict red or none), makes no API call; the driver stores `red`
# for a hold verdict so that a standing hold does not burn the budget on every tick. A
# pending or unknown verdict is asked again at most once per five minutes.
#
# THE REAL-DATA BOUNDARY. A mail carries a reason code and short commit SHAs only.

CD_GH_API_BASE="https://api.github.com"
_CD_GH_WORKFLOW_PATH=".github/workflows/ci.yml"
_CD_GH_JOB_NAME="Verify gate"
_CD_GH_GIT_TIMEOUT_S=300
_CD_GH_RECHECK_S=300
_CD_GH_RATE_FLOOR=5
_CD_GH_PR_PAGES=3

_cd_gh_err() { printf 'cd-github: %s\n' "$*" >&2; }

# -- the repository -----------------------------------------------------------
# _cd_gh_repo -- prints owner/repo from CD_REPO_URL. Only a github.com URL names a
# repository this file can read the API of; anything else is a refusal (2).
_cd_gh_repo() {
    local url owner repo
    url="$(cd_cfg CD_REPO_URL)" || return 2
    if [[ "$url" =~ ^https://github\.com/([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9._-]+)/?$ ]]; then
        owner="${BASH_REMATCH[1]}"
        repo="${BASH_REMATCH[2]%.git}"
        if [[ -n "$repo" && "$repo" != . && "$repo" != .. ]]; then
            printf '%s/%s\n' "$owner" "$repo"
            return 0
        fi
    fi
    _cd_gh_err "CD_REPO_URL is not a github.com repository URL"
    return 2
}

# _cd_gh_git ARGS... -- the git binary under a timeout, no prompt, no stdin, run from the
# data directory so that the repository of the caller's working directory (a broken or an
# unrelated one) is never looked at.
_cd_gh_git() {
    GIT_TERMINAL_PROMPT=0 timeout "$_CD_GH_GIT_TIMEOUT_S" git -C "$CD_DATA" "$@" </dev/null
}

_cd_gh_mirror() {
    cd_mkdir "$CD_DATA" || return 2
    if [[ ! -d "$CD_MIRROR_DIR" ]]; then
        mkdir -p "$CD_MIRROR_DIR" && chmod 700 "$CD_MIRROR_DIR" || return 2
        _cd_gh_git init --bare --quiet "$CD_MIRROR_DIR" >/dev/null 2>&1 || {
            _cd_gh_err "the mirror could not be created"
            return 2
        }
    fi
    return 0
}

# mg ARGS -- git against the mirror.
_cd_gh_mg() { git --git-dir="$CD_MIRROR_DIR" "$@" </dev/null; }

# cd_gh_tip -- the tip of main by `git ls-remote` of the named ref: the git protocol, so
# polling costs no API call. 1 when the remote does not answer one clean line.
cd_gh_tip() {
    local url out
    url="$(cd_cfg CD_REPO_URL)" || return 2
    cd_mkdir "$CD_DATA" || return 2
    out="$(_cd_gh_git ls-remote "$url" refs/heads/main 2>/dev/null)" || {
        _cd_gh_err "tip: the remote did not answer"
        return 1
    }
    if [[ "$out" =~ ^([0-9a-f]{40})[[:space:]]+refs/heads/main$ ]]; then
        printf '%s\n' "${BASH_REMATCH[1]}"
        return 0
    fi
    _cd_gh_err "tip: the answer is not one line for refs/heads/main"
    return 1
}

# cd_gh_mirror_fetch -- fetch the NAMED ref (never a bare SHA) into the bare full mirror and
# print the tip it now holds.
cd_gh_mirror_fetch() {
    local url sha
    url="$(cd_cfg CD_REPO_URL)" || return 2
    _cd_gh_mirror || return 2
    _cd_gh_git --git-dir="$CD_MIRROR_DIR" fetch --no-tags --quiet "$url" '+refs/heads/main:refs/heads/main' \
        >/dev/null 2>&1 || {
        _cd_gh_err "mirror: the fetch of refs/heads/main failed"
        return 1
    }
    sha="$(_cd_gh_mg rev-parse --verify --quiet 'refs/heads/main^{commit}')" || {
        _cd_gh_err "mirror: refs/heads/main is not there after the fetch"
        return 1
    }
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || return 1
    printf '%s\n' "$sha"
}

# cd_gh_proof_source SHA REF -- proof mode only. The proof commits come from the local bare
# repository CD_PROOF_REPO, never from the public repository, and no API call is made.
# 2 when proof mode is not on (before anything is touched), 1 when the branch tip is not
# SHA (the ref is removed again).
cd_gh_proof_source() {
    local sha="${1:-}" ref="${2:-}" repo got
    [[ "$(cd_cfg CD_PROOF_MODE)" == 1 ]] || return 2
    if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
        _cd_gh_err "proof: not a full sha"
        return 2
    fi
    if [[ ! "$ref" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$ || "$ref" == *..* || "$ref" == */ || "$ref" == *.lock ]]; then
        _cd_gh_err "proof: not a branch name"
        return 2
    fi
    repo="$(cd_cfg CD_PROOF_REPO)" || return 2
    if [[ -z "$repo" ]]; then
        _cd_gh_err "proof: CD_PROOF_REPO is not set"
        return 2
    fi
    _cd_gh_mirror || return 2
    _cd_gh_git --git-dir="$CD_MIRROR_DIR" fetch --no-tags --quiet "$repo" "+refs/heads/${ref}:refs/proof/${ref}" \
        >/dev/null 2>&1 || {
        _cd_gh_err "proof: the fetch of the branch failed"
        return 1
    }
    got="$(_cd_gh_mg rev-parse --verify --quiet "refs/proof/${ref}^{commit}")" || got=""
    if [[ "$got" != "$sha" ]]; then
        _cd_gh_mg update-ref -d "refs/proof/${ref}" >/dev/null 2>&1 || true
        _cd_gh_err "proof: the tip of the branch is not the commit asked for"
        return 1
    fi
    return 0
}

# -- the immutable cache ------------------------------------------------------
_cd_gh_cache_dir() { printf '%s\n' "${CD_DATA}/cache"; }

_cd_gh_cache_init() {
    local d
    d="$(_cd_gh_cache_dir)"
    cd_mkdir "$CD_DATA" || return 2
    [[ -d "$d" ]] || mkdir -p "$d" || return 2
    chmod 700 "$d" 2>/dev/null || true
}

# cd_gh_cache_get KEY -- prints the value, 0 on a hit, 1 on a miss or an unreadable entry.
cd_gh_cache_get() {
    local key="${1:-}" f v=""
    [[ "$key" =~ ^[A-Za-z0-9._-]{1,120}$ ]] || return 2
    f="$(_cd_gh_cache_dir)/${key}"
    [[ -f "$f" ]] || return 1
    IFS= read -r v < "$f" || [[ -n "$v" ]] || return 1
    [[ "$v" =~ ^[A-Za-z0-9._:-]{1,100}$ ]] || return 1
    printf '%s\n' "$v"
}

# cd_gh_cache_put KEY VALUE -- immutable facts only: a pending or unknown answer, or an
# empty value, is refused (2), so a transient state can never be remembered as a fact.
cd_gh_cache_put() {
    local key="${1:-}" val="${2:-}"
    [[ "$key" =~ ^[A-Za-z0-9._-]{1,120}$ ]] || { _cd_gh_err "cache: bad key"; return 2; }
    [[ "$val" =~ ^[A-Za-z0-9._:-]{1,100}$ ]] || { _cd_gh_err "cache: bad value"; return 2; }
    case "$val" in
        pending* | unknown* | 304*) _cd_gh_err "cache: a transient answer is never cached"; return 2 ;;
    esac
    _cd_gh_cache_init || return 2
    printf '%s\n' "$val" | cd_atomic_write "$(_cd_gh_cache_dir)/${key}" 600
}

# -- the budget ---------------------------------------------------------------
# data/cd/gh-calls: one epoch per call of the last hour. data/cd/gh-ratelimit: "<remaining>
# <reset epoch>" of the last answer that carried the header.
_cd_gh_calls_file() { printf '%s\n' "${CD_DATA}/gh-calls"; }
_cd_gh_rate_file() { printf '%s\n' "${CD_DATA}/gh-ratelimit"; }

cd_gh_calls_hour() {
    local f now cutoff n
    f="$(_cd_gh_calls_file)"
    now="$(cd_now)" || return 2
    cutoff=$((now - 3600))
    if [[ ! -f "$f" ]]; then
        echo 0
        return 0
    fi
    n="$(awk -v c="$cutoff" '$1 ~ /^[0-9]+$/ && $1 > c { n++ } END { print n + 0 }' "$f")" || return 1
    printf '%s\n' "$n"
}

# _cd_gh_ratelimited -- 0 while the last answer said five or fewer calls are left and its
# reset time has not come.
_cd_gh_ratelimited() {
    local f rem="" reset="" now
    f="$(_cd_gh_rate_file)"
    [[ -f "$f" ]] || return 1
    read -r rem reset < "$f" || true
    [[ "$rem" =~ ^[0-9]+$ && "$reset" =~ ^[0-9]+$ ]] || return 1
    now="$(cd_now)" || return 1
    (( rem <= _CD_GH_RATE_FLOOR && now < reset ))
}

# cd_gh_budget_left -- prints the calls left this hour; 0 when there are some and the
# server's own limit is not reached, 1 otherwise.
cd_gh_budget_left() {
    local budget used left
    budget="$(cd_cfg CD_API_BUDGET_PER_HOUR)" || return 2
    used="$(cd_gh_calls_hour)" || return 2
    left=$((budget - used))
    (( left < 0 )) && left=0
    printf '%s\n' "$left"
    if _cd_gh_ratelimited; then
        return 1
    fi
    (( left > 0 ))
}

# _cd_gh_budget_take -- count one call BEFORE it is made. 0 taken, 3 out of budget.
_cd_gh_budget_take() {
    local f budget now cutoff rc=0
    f="$(_cd_gh_calls_file)"
    budget="$(cd_cfg CD_API_BUDGET_PER_HOUR)" || return 2
    now="$(cd_now)" || return 2
    cutoff=$((now - 3600))
    cd_mkdir "$CD_DATA" || return 2
    (
        if command -v flock >/dev/null 2>&1; then
            exec 7>>"${f}.lock" || exit 2
            flock 7 || exit 2
        fi
        kept=""
        if [[ -f "$f" ]]; then
            kept="$(awk -v c="$cutoff" '$1 ~ /^[0-9]+$/ && $1 > c' "$f")" || exit 2
        fi
        n=0
        if [[ -n "$kept" ]]; then
            n="$(printf '%s\n' "$kept" | wc -l)"
        fi
        if (( n >= budget )); then
            exit 3
        fi
        { [[ -n "$kept" ]] && printf '%s\n' "$kept"; printf '%s\n' "$now"; } | cd_atomic_write "$f" 600 || exit 2
    ) || rc=$?
    return "$rc"
}

# _cd_gh_rate_note REMAINING RESET -- remember what the server said.
_cd_gh_rate_note() {
    local rem="$1" reset="$2" now
    now="$(cd_now)" || return 0
    [[ "$rem" =~ ^[0-9]+$ ]] || return 0
    if [[ ! "$reset" =~ ^[0-9]+$ || "$reset" -le "$now" || "$reset" -gt $((now + 3600)) ]]; then
        reset=$((now + 3600))
    fi
    cd_mkdir "$CD_DATA" || return 0
    printf '%s %s\n' "$rem" "$reset" | cd_atomic_write "$(_cd_gh_rate_file)" 600 || true
}

# -- mail and the once-only marker --------------------------------------------
# _cd_gh_once KEY -- 0 when KEY is not yet in state.notified AND this shell holds the cd
# lock (a dry run holds none, so it neither mails nor writes). The caller sends the mail
# and then calls _cd_gh_once_mark: a crash in between costs a duplicate mail, never a lost one.
_cd_gh_once() {
    local key="${1:-}" have
    [[ "$key" =~ ^[a-z_]+:[A-Za-z0-9]+$ ]] || return 1
    [[ "${CD_LOCK_PID:-}" == "$$" ]] || return 1
    have="$(cd_state_get ".notified[\"${key}\"] // empty")" || return 1
    [[ -z "$have" ]]
}
_cd_gh_once_mark() {
    local key="${1:-}" at
    [[ "$key" =~ ^[a-z_]+:[A-Za-z0-9]+$ ]] || return 1
    at="$(cd_iso)" || return 1
    cd_state_set '.notified[$k] = $t' --arg k "$key" --arg t "$at" || return 1
}

# _cd_gh_notify KIND [k=v ...] -- queue a mail; never fails and never blocks.
_cd_gh_notify() {
    declare -F cd_notify >/dev/null 2>&1 || return 0
    cd_notify "$@" || true
    return 0
}

# -- the token ----------------------------------------------------------------
# The optional read-only token. Its charset is checked before it goes anywhere near a curl
# config line: a quote or a newline in the file would otherwise add a config directive.
# Prints the token (and the first 12 hex of its hash on fd 3 is NOT used: see _cd_gh_token_id).
_cd_gh_token_read() {
    local file tok=""
    file="$(cd_cfg CD_GITHUB_TOKEN_FILE)" || return 1
    [[ -n "$file" && -f "$file" && -r "$file" ]] || return 1
    IFS= read -r tok < "$file" || [[ -n "$tok" ]] || return 1
    tok="${tok%$'\r'}"
    [[ "$tok" =~ ^[A-Za-z0-9_-]{20,255}$ ]] || return 1
    printf '%s' "$tok"
}

# _cd_gh_token_id TOKEN -- twelve hex of its hash: names a token in a marker, never the token.
_cd_gh_token_id() {
    printf '%s' "$1" | sha256sum | cut -c1-12
}

_cd_gh_token_bad_file() { printf '%s\n' "${CD_DATA}/gh-token-bad"; }

# _cd_gh_token_is_bad TOKEN -- 0 when this very token already got a 401.
_cd_gh_token_is_bad() {
    local f id have=""
    f="$(_cd_gh_token_bad_file)"
    [[ -f "$f" ]] || return 1
    id="$(_cd_gh_token_id "$1")"
    read -r have < "$f" || true
    [[ "$have" == "$id" ]]
}

# _cd_gh_token_mail TOKEN -- the "token expired" mail, once per distinct token.
_cd_gh_token_mail() {
    local key
    key="gh_token:$(_cd_gh_token_id "$1")"
    if _cd_gh_once "$key"; then
        _cd_gh_notify held reason=github_token_expired
        _cd_gh_once_mark "$key" || true
    fi
    return 0
}

# -- the API ------------------------------------------------------------------
_CD_GH_BODY=""

# _cd_gh_call URL USE_TOKEN TOKEN -- one curl call; sets _CD_GH_STATUS and _CD_GH_BODY.
# The config goes to curl on stdin (`-K -`) from the printf builtin: the token is in no
# argv and in no environment. 0 when curl answered a three-digit status, 1 otherwise.
_CD_GH_STATUS=""
_cd_gh_call() {
    local url="$1" use_tok="$2" tok="$3" dir cfg status rc=0 hdrs remaining reset
    _CD_GH_STATUS=""
    _CD_GH_BODY=""
    cd_mkdir "$CD_DATA" || return 1
    dir="$(umask 077; mktemp -d "${CD_DATA}/.gh.XXXXXX")" || return 1
    cfg="url = \"${url}\"
header = \"Accept: application/vnd.github+json\"
header = \"X-GitHub-Api-Version: 2022-11-28\"
user-agent = \"gremion-cd\"
proto = \"=https\"
silent
show-error
max-time = 30
connect-timeout = 10
output = \"${dir}/body\"
dump-header = \"${dir}/hdr\"
write-out = \"%{http_code}\""
    if [[ "$use_tok" == 1 ]]; then
        cfg+=$'\n'"header = \"Authorization: Bearer ${tok}\""
    fi
    status="$(printf '%s\n' "$cfg" | curl -K - 2>/dev/null)" || rc=$?
    cfg=""
    if [[ "$rc" != 0 || ! "$status" =~ ^[0-9]{3}$ ]]; then
        rm -rf "$dir"
        return 1
    fi
    _CD_GH_STATUS="$status"
    if [[ -f "${dir}/hdr" ]]; then
        hdrs="$(tr -d '\r' < "${dir}/hdr")"
        remaining="$(printf '%s\n' "$hdrs" | awk 'tolower($1) == "x-ratelimit-remaining:" {print $2; exit}')"
        reset="$(printf '%s\n' "$hdrs" | awk 'tolower($1) == "x-ratelimit-reset:" {print $2; exit}')"
        if [[ -n "$remaining" ]]; then
            _cd_gh_rate_note "$remaining" "$reset"
        elif [[ "$status" == 403 || "$status" == 429 ]]; then
            _cd_gh_rate_note 0 "$(( $(cd_now) + 300 ))"
        fi
    fi
    if [[ "$status" == 200 && -f "${dir}/body" ]]; then
        _CD_GH_BODY="$(cat "${dir}/body")"
    fi
    rm -rf "$dir"
    return 0
}

# cd_gh_api PATH [SHAPE_JQ] -- one budgeted GET. Prints the body and returns 0 only for a
# parsed HTTP 200 whose JSON passes SHAPE_JQ (jq -e). 1: no verdict (any other status, a
# timeout, an empty body, invalid JSON, the wrong shape). 2: a precondition (config,
# curl missing, a bad path). 3: out of budget, or the server's own limit is reached.
cd_gh_api() {
    local path="${1:-}" shape="${2:-.}" slug url tok="" use_tok=0 pass rc
    command -v curl >/dev/null 2>&1 || { _cd_gh_err "curl is not installed"; return 2; }
    if [[ ! "$path" =~ ^/?[A-Za-z0-9._/?\&=:,%-]+$ || "$path" == *..* ]]; then
        _cd_gh_err "api: a bad path"
        return 2
    fi
    slug="$(_cd_gh_repo)" || return 2
    : "$slug"
    url="${CD_GH_API_BASE}/${path#/}"
    if tok="$(_cd_gh_token_read)"; then
        if _cd_gh_token_is_bad "$tok"; then
            _cd_gh_token_mail "$tok"
            tok=""
        else
            use_tok=1
        fi
    else
        tok=""
    fi
    for pass in 1 2; do
        if _cd_gh_ratelimited; then
            _cd_gh_err "api: the server's rate limit is reached"
            return 3
        fi
        rc=0
        _cd_gh_budget_take || rc=$?
        if [[ "$rc" == 3 ]]; then
            _cd_gh_err "api: the hourly call budget is used"
            return 3
        fi
        [[ "$rc" == 0 ]] || return 2
        if ! _cd_gh_call "$url" "$use_tok" "$tok"; then
            _cd_gh_err "api: no answer"
            return 1
        fi
        if [[ "$_CD_GH_STATUS" == 401 && "$use_tok" == 1 && "$pass" == 1 ]]; then
            # an expired token: remember it, tell the operator once, ask again without it
            cd_mkdir "$CD_DATA" || true
            _cd_gh_token_id "$tok" | cd_atomic_write "$(_cd_gh_token_bad_file)" 600 || true
            _cd_gh_token_mail "$tok"
            tok=""
            use_tok=0
            continue
        fi
        break
    done
    if [[ "$_CD_GH_STATUS" != 200 ]]; then
        _cd_gh_err "api: HTTP ${_CD_GH_STATUS}"
        return 1
    fi
    if [[ -z "$_CD_GH_BODY" ]] || ! printf '%s' "$_CD_GH_BODY" | jq -e "$shape" >/dev/null 2>&1; then
        _cd_gh_err "api: the answer is empty, not JSON or not the expected shape"
        return 1
    fi
    printf '%s\n' "$_CD_GH_BODY"
}

# -- the branch rules ---------------------------------------------------------
_cd_gh_rules_body() {
    local slug
    slug="$(_cd_gh_repo)" || return 2
    cd_gh_api "repos/${slug}/rules/branches/main" 'type == "array" and all(.[]; type == "object" and (.type | type == "string"))'
}

# cd_gh_rules_ok -- the four rules of section 1: pull_request, required_status_checks naming
# "Verify gate", non_fast_forward and deletion. 0 in force; 1 a rule is missing (the missing
# types are printed); 3 no verdict (the answer could not be read).
cd_gh_rules_ok() {
    local body rc=0 missing
    body="$(_cd_gh_rules_body)" || rc=$?
    if [[ "$rc" != 0 ]]; then
        [[ "$rc" == 2 ]] && return 2
        return 3
    fi
    missing="$(printf '%s' "$body" | jq -r --arg job "$_CD_GH_JOB_NAME" '
        [ (if any(.[]; .type == "pull_request") then empty else "pull_request" end),
          (if any(.[]; .type == "required_status_checks"
                       and any((.parameters.required_status_checks // [])[]?; .context == $job))
           then empty else "required_status_checks" end),
          (if any(.[]; .type == "non_fast_forward") then empty else "non_fast_forward" end),
          (if any(.[]; .type == "deletion") then empty else "deletion" end) ]
        | join(",")')" || return 3
    if [[ -n "$missing" ]]; then
        printf '%s\n' "$missing"
        return 1
    fi
    return 0
}

# cd_gh_merge_methods_ok -- the allowed merge methods are exactly `squash` and a
# linear-history rule is present (decision 1). With CD_ALLOW_ANY_MERGE_METHOD=1 a failure is
# a warning and the return is 0; the walk itself never depends on this check.
cd_gh_merge_methods_ok() {
    local body rc=0 ok=""
    body="$(_cd_gh_rules_body)" || rc=$?
    if [[ "$rc" == 0 ]]; then
        ok="$(printf '%s' "$body" | jq -r '
            if (any(.[]; .type == "required_linear_history")
                and ([ .[] | select(.type == "pull_request") | .parameters.allowed_merge_methods ]
                     | length == 1 and (.[0] | type == "array" and (sort == ["squash"]))))
            then "yes" else "no" end')" || ok=""
    fi
    if [[ "$ok" == yes ]]; then
        return 0
    fi
    if [[ "$(cd_cfg CD_ALLOW_ANY_MERGE_METHOD)" == 1 ]]; then
        _cd_gh_err "warning: the merge-method rule is not squash plus linear history (CD_ALLOW_ANY_MERGE_METHOD=1)"
        cd_hist merge_methods_waived || true
        return 0
    fi
    _cd_gh_err "the merge-method rule is not squash plus linear history"
    [[ "$rc" == 0 ]] || return 3
    return 1
}

# -- the verdict walk ---------------------------------------------------------
_CD_GH_V=""
_CD_GH_WHY=""

# _cd_gh_commit_verdict SLUG C -- sets _CD_GH_V (green, pending, red, unknown) and _CD_GH_WHY
# for the commit C. Only a completed, successful push run of ci.yml on main of this very
# repository, with exactly one successful "Verify gate" job of the same SHA, is green.
_cd_gh_commit_verdict() {
    local slug="$1" c="$2" body rc run id attempt status concl created now age gate key hit
    local slug_lc="${slug,,}" pending_max
    _CD_GH_V=unknown
    _CD_GH_WHY=""
    pending_max="$(cd_cfg CD_PENDING_MAX_MIN)" || { _CD_GH_WHY=config; return 0; }
    rc=0
    body="$(cd_gh_api "repos/${slug}/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${c}&per_page=10" \
        '(.workflow_runs | type) == "array"')" || rc=$?
    if [[ "$rc" != 0 ]]; then
        _CD_GH_WHY="runs_unavailable"
        [[ "$rc" == 3 ]] && _CD_GH_WHY="budget"
        return 0
    fi
    # every filter is applied here whatever the query said: the server's filters are not
    # the check
    run="$(printf '%s' "$body" | jq -c --arg sha "$c" --arg repo "$slug_lc" --arg path "$_CD_GH_WORKFLOW_PATH" '
        [ .workflow_runs[]
          | select(type == "object"
                   and .path == $path and .event == "push" and .head_branch == "main"
                   and .head_sha == $sha
                   and ((.head_repository.full_name // "") | ascii_downcase) == $repo) ]
        | sort_by([(.run_number // 0), (.run_attempt // 0)]) | last // empty')" || {
        _CD_GH_WHY="runs_shape"
        return 0
    }
    if [[ -z "$run" ]]; then
        _CD_GH_V=red
        _CD_GH_WHY="no_run"
        return 0
    fi
    id="$(printf '%s' "$run" | jq -r 'if (.id | type) == "number" then .id | floor | tostring else "" end')"
    attempt="$(printf '%s' "$run" | jq -r '(.run_attempt // 1) | if type == "number" then floor | tostring else "" end')"
    status="$(printf '%s' "$run" | jq -r '.status // ""')"
    concl="$(printf '%s' "$run" | jq -r '.conclusion // ""')"
    if [[ ! "$id" =~ ^[0-9]+$ || ! "$attempt" =~ ^[0-9]+$ || -z "$status" ]]; then
        _CD_GH_WHY="run_shape"
        return 0
    fi
    if [[ "$status" != completed ]]; then
        created="$(printf '%s' "$run" | jq -r '(.created_at // "") | try fromdateiso8601 catch ""')"
        now="$(cd_now)" || return 0
        if [[ ! "$created" =~ ^[0-9]+$ ]]; then
            _CD_GH_WHY="run_time"
            return 0
        fi
        age=$((now - created))
        if (( age >= pending_max * 60 )); then
            _CD_GH_V=red
            _CD_GH_WHY="pending_too_long"
        else
            _CD_GH_V=pending
            _CD_GH_WHY="run_${status}"
            [[ "$_CD_GH_WHY" =~ ^run_[a-z_]{1,30}$ ]] || _CD_GH_WHY="run_pending"
        fi
        return 0
    fi
    if [[ "$concl" != success ]]; then
        _CD_GH_V=red
        _CD_GH_WHY="conclusion_${concl:-none}"
        [[ "$_CD_GH_WHY" =~ ^conclusion_[a-z_]{1,30}$ ]] || _CD_GH_WHY="conclusion_other"
        return 0
    fi
    # a completed run attempt is immutable: its gate result is cached by run id and attempt
    key="run-${id}-${attempt}-${c:0:12}"
    if hit="$(cd_gh_cache_get "$key")"; then
        case "$hit" in
            gate-ok) _CD_GH_V=green; return 0 ;;
            gate-red) _CD_GH_V=red; _CD_GH_WHY="gate_not_green"; return 0 ;;
        esac
    fi
    rc=0
    body="$(cd_gh_api "repos/${slug}/actions/runs/${id}/jobs?per_page=100" \
        '(.jobs | type) == "array" and (.total_count | type) == "number"')" || rc=$?
    if [[ "$rc" != 0 ]]; then
        _CD_GH_WHY="jobs_unavailable"
        [[ "$rc" == 3 ]] && _CD_GH_WHY="budget"
        return 0
    fi
    gate="$(printf '%s' "$body" | jq -r --arg name "$_CD_GH_JOB_NAME" --arg sha "$c" '
        if .total_count > (.jobs | length) then "truncated"
        else ([ .jobs[] | select(type == "object" and .name == $name) ]) as $g
          | if ($g | length) == 0 then "missing"
            elif ($g | length) > 1 then "duplicate"
            elif ($g[0].conclusion // "") != "success" then "red"
            elif ($g[0].head_sha // "") != $sha then "sha"
            else "ok" end
        end')" || gate=""
    case "$gate" in
        ok)
            cd_gh_cache_put "$key" gate-ok || true
            _CD_GH_V=green
            ;;
        missing | red)
            cd_gh_cache_put "$key" gate-red || true
            _CD_GH_V=red
            _CD_GH_WHY="gate_${gate}"
            ;;
        truncated | duplicate | sha)
            _CD_GH_WHY="gate_${gate}"
            ;;
        *)
            _CD_GH_WHY="jobs_shape"
            ;;
    esac
    return 0
}

_CD_GH_UNCOVERED=()

# _cd_gh_range_proof SLUG RANGE_ARRAY_NAME -- every commit of the range must be PR-proven:
# the merge_commit_sha of a closed, merged pull request into main (F20(c), up to three
# pages), or else, for a commit still uncovered, a merged pull request into main (F20(d),
# commits/<sha>/pulls) whose own merge_commit_sha lies in the same range. One rule, no
# parent-count check: a squash commit and a merge-method merge commit both pass it.
# Fills _CD_GH_UNCOVERED. 0 every commit proven, 1 at least one is not, 3 out of budget,
# 4 no verdict (the API did not give a usable answer).
_cd_gh_range_proof() {
    local slug="$1" arrname="$2" c p rc page n pages="$_CD_GH_PR_PAGES" shas
    local -n _range="$arrname"
    local -a remaining=() still=()
    local -A inrange=() covered=()
    _CD_GH_UNCOVERED=()
    for c in "${_range[@]}"; do
        inrange[$c]=1
        if cd_gh_cache_get "pr-${c}" >/dev/null 2>&1; then
            continue
        fi
        remaining+=("$c")
    done
    page=1
    while (( ${#remaining[@]} > 0 && page <= pages )); do
        local body
        rc=0
        body="$(cd_gh_api "repos/${slug}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=${page}" \
            'type == "array" and all(.[]; type == "object")')" || rc=$?
        if [[ "$rc" != 0 ]]; then
            [[ "$rc" == 3 ]] && return 3
            return 4
        fi
        shas="$(printf '%s' "$body" | jq -r '.[]
            | select(.merged_at != null and (.base.ref // "") == "main" and (.merge_commit_sha // "") != "")
            | .merge_commit_sha')" || return 4
        n="$(printf '%s' "$body" | jq -r 'length')" || return 4
        covered=()
        while IFS= read -r p; do
            [[ -n "$p" ]] && covered[$p]=1
        done <<< "$shas"
        still=()
        for c in "${remaining[@]}"; do
            if [[ -n "${covered[$c]:-}" ]]; then
                cd_gh_cache_put "pr-${c}" covered || true
            else
                still+=("$c")
            fi
        done
        remaining=("${still[@]}")
        # a short page is the last one
        (( n < 100 )) && break
        page=$((page + 1))
    done
    for c in "${remaining[@]}"; do
        local body2 hit
        rc=0
        body2="$(cd_gh_api "repos/${slug}/commits/${c}/pulls" 'type == "array" and all(.[]; type == "object")')" || rc=$?
        if [[ "$rc" != 0 ]]; then
            [[ "$rc" == 3 ]] && return 3
            return 4
        fi
        hit=no
        while IFS= read -r p; do
            [[ -n "$p" && -n "${inrange[$p]:-}" ]] && { hit=yes; break; }
        done < <(printf '%s' "$body2" | jq -r '.[]
            | select(.merged_at != null and (.base.ref // "") == "main" and (.merge_commit_sha // "") != "")
            | .merge_commit_sha')
        if [[ "$hit" == yes ]]; then
            cd_gh_cache_put "pr-${c}" covered || true
        else
            _CD_GH_UNCOVERED+=("$c")
        fi
    done
    (( ${#_CD_GH_UNCOVERED[@]} == 0 ))
}

# _cd_gh_out VERDICT SHA REASON [JQ_EXTRA_OBJECT] -- the one json line.
_cd_gh_out() {
    local extra="${4:-}"
    [[ -n "$extra" ]] || extra='{}'
    jq -cn --arg v "$1" --arg s "$2" --arg r "$3" --argjson x "$extra" \
        '{verdict: $v, sha: $s, reason: $r} + $x'
}

# cd_gh_candidate [FLAGS] [SHA] -- see the header.
cd_gh_candidate() {
    local dry=0 accept_range="" allow_blocked=0 allow_batch=0 want="" live="" poll_tip="" poll_verdict="" poll_at=""
    local tip="" tip12 slug max_batch walkback now line rc n limit i found="" found_i=0 c
    local -a range=() slice=()
    while (( $# > 0 )); do
        case "$1" in
            --dry-run) dry=1; shift ;;
            --allow-blocked) allow_blocked=1; shift ;;
            --allow-batch) allow_batch=1; shift ;;
            --accept-range)
                accept_range="${2:-}"
                if [[ -z "$accept_range" || "$accept_range" == *$'\n'* ]]; then
                    _cd_gh_err "--accept-range needs a one-line reason"
                    return 2
                fi
                shift 2
                ;;
            -*) _cd_gh_err "unknown flag"; return 2 ;;
            *)
                want="$1"
                [[ "$want" =~ ^[0-9a-f]{12,40}$ ]] || { _cd_gh_err "not a commit id"; return 2; }
                shift
                ;;
        esac
    done
    slug="$(_cd_gh_repo)" || return 2
    max_batch="$(cd_cfg CD_MAX_BATCH)" || return 2
    walkback="$(cd_cfg CD_WALKBACK)" || return 2
    line="$(cd_state_get '[(.live.sha // ""), .poll.tip12, .poll.verdict, .poll.last_at] | join("|")')" || return 2
    IFS='|' read -r live poll_tip poll_verdict poll_at <<< "$line"
    if [[ ! "$live" =~ ^[0-9a-f]{40}$ ]]; then
        _cd_gh_err "no live release in the state (gremion-cd adopt first)"
        return 2
    fi
    now="$(cd_now)" || return 2

    # the tip, and the answers that need no API call
    if [[ -z "$want" ]]; then
        tip="$(cd_gh_tip)" || { _cd_gh_out unknown "" tip_unreachable; return 0; }
        tip12="${tip:0:12}"
        if [[ "$tip" == "$live" ]]; then
            _cd_gh_out none "" up_to_date
            return 0
        fi
        if [[ "$poll_tip" == "$tip12" ]]; then
            case "$poll_verdict" in
                red | none)
                    _cd_gh_out none "" tip_unchanged
                    return 0
                    ;;
                pending | unknown)
                    if [[ -n "$poll_at" ]]; then
                        local at_epoch
                        at_epoch="$(jq -rn --arg t "$poll_at" '$t | try fromdateiso8601 catch ""')"
                        if [[ "$at_epoch" =~ ^[0-9]+$ ]] && (( now - at_epoch < _CD_GH_RECHECK_S )); then
                            _cd_gh_out "$poll_verdict" "" recheck_wait
                            return 0
                        fi
                    fi
                    ;;
            esac
        fi
    fi

    # the mirror
    c="$(cd_gh_mirror_fetch)" || { _cd_gh_out unknown "" mirror_unavailable; return 0; }
    if [[ -n "$want" ]]; then
        tip="$(_cd_gh_mg rev-parse --verify --quiet "${want}^{commit}")" || tip=""
        if [[ ! "$tip" =~ ^[0-9a-f]{40}$ ]]; then
            _cd_gh_out none "" unknown_commit
            return 0
        fi
        if ! _cd_gh_mg merge-base --is-ancestor "$tip" "$c" 2>/dev/null; then
            _cd_gh_out none "$tip" not_on_main
            return 0
        fi
    else
        tip="$c"
    fi

    # refusals before any API call
    if ! _cd_gh_mg merge-base --is-ancestor "$live" "$tip" 2>/dev/null; then
        _cd_gh_out hold "$tip" not_ancestor
        return 0
    fi
    line="$(_cd_gh_mg rev-list --first-parent "${live}..${tip}" 2>/dev/null)" || {
        _cd_gh_out unknown "$tip" mirror_error
        return 0
    }
    if [[ -n "$line" ]]; then
        mapfile -t range <<< "$line"
    fi
    n="${#range[@]}"
    if (( n == 0 )); then
        _cd_gh_out none "" up_to_date
        return 0
    fi
    if (( n > max_batch && allow_batch == 0 )); then
        _cd_gh_out hold "$tip" batch_too_large "$(jq -cn --argjson n "$n" '{commits: $n}')"
        return 0
    fi
    if (( allow_blocked == 0 )); then
        if cd_contains_open_block "$tip"; then
            _cd_gh_out hold "$tip" blocked
            return 0
        fi
    fi

    # the verdict, newest first, at most CD_WALKBACK commits back
    limit="$n"
    (( limit > walkback )) && limit="$walkback"
    for (( i = 0; i < limit; i++ )); do
        c="${range[i]}"
        _cd_gh_commit_verdict "$slug" "$c"
        case "$_CD_GH_V" in
            green) found="$c"; found_i="$i"; break ;;
            pending) _cd_gh_out pending "$c" "$_CD_GH_WHY" "$(jq -cn --arg t "$tip" '{tip: $t}')"; return 0 ;;
            red) continue ;;
            *) _cd_gh_out unknown "$c" "${_CD_GH_WHY:-unknown}" "$(jq -cn --arg t "$tip" '{tip: $t}')"; return 0 ;;
        esac
    done
    if [[ -z "$found" ]]; then
        _cd_gh_out none "" no_green_commit "$(jq -cn --arg t "$tip" '{tip: $t}')"
        return 0
    fi

    # every commit of live..found must come from a merged pull request
    slice=("${range[@]:found_i}")
    rc=0
    _cd_gh_range_proof "$slug" slice || rc=$?
    if [[ "$rc" == 3 || "$rc" == 4 ]]; then
        c=range_unavailable
        [[ "$rc" == 3 ]] && c=budget
        _cd_gh_out unknown "$found" "$c" "$(jq -cn --arg t "$tip" '{tip: $t}')"
        return 0
    fi
    if [[ "$rc" != 0 ]]; then
        local -a short=()
        for c in "${_CD_GH_UNCOVERED[@]}"; do short+=("${c:0:12}"); done
        if [[ -n "$accept_range" ]]; then
            if (( dry == 0 )); then
                cd_hist range_accepted sha12="${found:0:12}" count="${#short[@]}" reason="$accept_range" || true
            fi
        else
            if (( dry == 0 )) && _cd_gh_once "range_unverified:${found:0:12}"; then
                _cd_gh_notify held reason=range_unverified sha12="${found:0:12}" uncovered="${short[*]}"
                _cd_gh_once_mark "range_unverified:${found:0:12}" || true
            fi
            _cd_gh_out hold "$found" range_unverified \
                "$(jq -cn --arg t "$tip" --arg u "${short[*]}" '{tip: $t, uncovered: ($u | split(" "))}')"
            return 0
        fi
    fi

    # the rules, once per candidate
    rc=0
    cd_gh_rules_ok >/dev/null || rc=$?
    case "$rc" in
        0) ;;
        1)
            _cd_gh_out hold "$found" ruleset_missing "$(jq -cn --arg t "$tip" '{tip: $t}')"
            return 0
            ;;
        *)
            _cd_gh_out unknown "$found" rules_unavailable "$(jq -cn --arg t "$tip" '{tip: $t}')"
            return 0
            ;;
    esac
    _cd_gh_out green "$found" "" "$(jq -cn --arg t "$tip" --argjson w "$found_i" '{tip: $t, walked: $w}')"
}

# cd_cmd_poll [SHA] -- the dry run: the verdict of the newest candidate, printed, with no
# mail, no hold and no state write.
cd_cmd_poll() {
    local out rc=0
    out="$(cd_gh_candidate --dry-run "$@")" || rc=$?
    if [[ "$rc" != 0 ]]; then
        return "$rc"
    fi
    printf '%s\n' "$out"
}
