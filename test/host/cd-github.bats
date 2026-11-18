#!/usr/bin/env bats
# Unit tests for infra/host/lib/cd/github.sh (continuous deployment, pick-up): the tip, the
# mirror, the budgeted API, the cache, the verdict walk, the proof that every commit of the
# range came from a merged pull request, the rules check and the proof-mode source.
#
# git runs against REAL temporary repositories (the URL https://github.com/org/repo is
# redirected to a bare repo by git's url.<path>.insteadOf); curl is a shim that serves the
# recorded answers of fixtures/cd/github/ and records the url, the config it was fed on stdin
# and its environment. Nothing here reaches a network.

bats_require_minimum_version 1.5.0
load 'test_helper/host'
load 'test_helper/cd'
load 'test_helper/cd-github'

setup() { gh_setup; }
teardown() { gh_teardown; }

# gh_expect VERDICT [REASON] -- the last gh_verdict said that, and never "green" unless asked.
gh_expect() {
    if [[ "$V" != "$1" ]]; then
        echo "expected verdict $1, got $V (reason $R); json: $output; stderr: ${stderr:-}" >&2
        return 1
    fi
    if [[ -n "${2:-}" && "$R" != "$2" ]]; then
        echo "expected reason $2, got $R; json: $output" >&2
        return 1
    fi
}

# gh_refused_run RUN_FILTER -- the tip B has a run the filter spoils; its parent has no run:
# the walk ends with nothing to release.
gh_refused_run() {
    gh_scn_green
    gh_route_ci "$C_B" "$1"
    gh_no_run "$C_A"
    gh_verdict
    gh_expect none no_green_commit
}

# -- the tip and the mirror ----------------------------------------------------

@test "tip: cd_gh_tip prints the tip of refs/heads/main by the git protocol and makes no API call" {
    gh_scn_green
    run --separate-stderr gh_lib 'cd_gh_tip'
    [ "$status" -eq 0 ]
    [ "$output" = "$C_B" ]
    [ "$(gh_calls)" -eq 0 ]
    grep -Eq '^git -C [^ ]+ ls-remote https://github.com/org/repo refs/heads/main$' "$SHIM_LOG"
}

@test "tip: a remote that does not answer is no tip (1), never an empty success" {
    gh_scn_green
    rm -rf "$GH_REMOTE"
    run --separate-stderr gh_lib 'cd_gh_tip'
    [ "$status" -eq 1 ]
    [ -z "$output" ]
}

@test "tip: the verdict of an unreachable remote is unknown" {
    gh_scn_green
    rm -rf "$GH_REMOTE"
    gh_verdict
    gh_expect unknown tip_unreachable
    [ "$(gh_calls)" -eq 0 ]
}

@test "tip unchanged: a tip equal to the live commit makes no API call and says up_to_date" {
    gh_hist_init
    gh_commit A
    gh_publish
    gh_seed_live "$C_A"
    gh_verdict
    gh_expect none up_to_date
    [ "$(gh_calls)" -eq 0 ]
}

@test "tip unchanged: the tip of a FINAL last verdict (red or none) makes no API call" {
    local v
    for v in red none; do
        gh_scn_green
        gh_seed_live "$C_L0" ".poll.tip12 = \"${C_B:0:12}\" | .poll.verdict = \"${v}\" | .poll.last_at = \"$(gh_iso -9000)\""
        gh_verdict
        gh_expect none tip_unchanged
        [ "$(gh_calls)" -eq 0 ]
    done
}

@test "tip unchanged: a green last verdict is NOT final, the candidate is asked again (from the cache)" {
    gh_scn_green
    gh_seed_live "$C_L0" ".poll.tip12 = \"${C_B:0:12}\" | .poll.verdict = \"green\" | .poll.last_at = \"$(gh_iso -9000)\""
    gh_verdict
    gh_expect green
    [ "$S" = "$C_B" ]
}

@test "tip unchanged: a pending or unknown verdict is asked again at most once per five minutes" {
    local v
    for v in pending unknown; do
        gh_scn_green
        gh_seed_live "$C_L0" ".poll.tip12 = \"${C_B:0:12}\" | .poll.verdict = \"${v}\" | .poll.last_at = \"$(gh_iso -120)\""
        gh_verdict
        gh_expect "$v" recheck_wait
        [ "$(gh_calls)" -eq 0 ]
        gh_seed_live "$C_L0" ".poll.tip12 = \"${C_B:0:12}\" | .poll.verdict = \"${v}\" | .poll.last_at = \"$(gh_iso -400)\""
        gh_verdict
        gh_expect green
    done
}

@test "mirror: the fetch names refs/heads/main and no bare 40-hex argument" {
    gh_scn_green
    run --separate-stderr gh_lib 'cd_gh_mirror_fetch'
    [ "$status" -eq 0 ]
    [ "$output" = "$C_B" ]
    run grep -E '^git .*fetch' "$SHIM_LOG"
    [ "$status" -eq 0 ]
    [[ "$output" == *"refs/heads/main"* ]]
    ! grep -E '^git .*fetch.*(^| )[0-9a-f]{40}( |$)' "$SHIM_LOG"
    [ -d "${GREMION_ROOT}/data/cd/mirror.git" ]
}

@test "mirror: a fetch that fails is 1 with no tip" {
    gh_scn_green
    rm -rf "$GH_REMOTE"
    run --separate-stderr gh_lib 'cd_gh_mirror_fetch'
    [ "$status" -eq 1 ]
    [ -z "$output" ]
}

# -- the green path ------------------------------------------------------------

@test "green: a success push run on ci.yml, one Verify gate job and a PR for every commit is green (4 calls)" {
    gh_scn_green
    gh_verdict
    gh_expect green ""
    [ "$S" = "$C_B" ]
    [ "$(jq -r '.tip' <<< "$output")" = "$C_B" ]
    [ "$(gh_calls)" -eq 4 ]
    # the job list asks for a page of 100: the default page of 30 can miss the gate
    grep -q '/jobs?per_page=100' "${GH}/urls.log"
    # the pull request listing is closed, base main
    grep -q 'pulls?state=closed&base=main' "${GH}/urls.log"
}

@test "green: the gate job missing from a page of 30 is only found because per_page=100 is asked" {
    gh_scn_green
    gh_route_ci "$C_B"
    local id="$GH_LAST_ID" filler
    filler="$(jq -cn --arg s "$C_B" '[range(0; 48) | {id: (3000 + .), name: ("Job " + tostring), head_sha: $s, status: "completed", conclusion: "success"}]')"
    jq -n --argjson f "$filler" --arg s "$C_B" \
        '{total_count: 49, jobs: ($f + [{id: 2999, name: "Verify gate", head_sha: $s, status: "completed", conclusion: "success"}])}' \
        > "${GH}/full49.json"
    jq '.jobs |= .[0:30]' "${GH}/full49.json" > "${GH}/page30.json"
    gh_route "*/actions/runs/${id}/jobs*" 200 "${GH}/page30.json"
    gh_route "*/actions/runs/${id}/jobs?per_page=100*" 200 "${GH}/full49.json"
    gh_verdict
    gh_expect green
    # the same list served as a page of 30 is a truncated list: no verdict, never green
    gh_route "*/actions/runs/${id}/jobs?per_page=100*" 200 "${GH}/page30.json"
    rm -rf "${GREMION_ROOT}/data/cd/cache"
    gh_verdict
    gh_expect unknown gate_truncated
}

# -- one test per refusal of the run -------------------------------------------

@test "refusal: a pull_request run is not green" {
    gh_refused_run '.workflow_runs[0].event = "pull_request"'
}

@test "refusal: a run whose head_branch is not main is not green" {
    gh_refused_run '.workflow_runs[0].head_branch = "feature"'
}

@test "refusal: a run of another head repository (a fork) is not green" {
    gh_refused_run '.workflow_runs[0].head_repository.full_name = "fork/repo"'
}

@test "refusal: a run of another workflow path is not green" {
    gh_refused_run '.workflow_runs[0].path = ".github/workflows/other.yml"'
}

@test "refusal: a workflow_dispatch run is not green" {
    gh_refused_run '.workflow_runs[0].event = "workflow_dispatch"'
}

@test "refusal: a run for another head_sha is not green" {
    gh_refused_run '.workflow_runs[0].head_sha = "0000000000000000000000000000000000000000"'
}

@test "refusal: a cancelled run is not green" {
    gh_refused_run '.workflow_runs[0].conclusion = "cancelled"'
}

@test "refusal: a failed run is not green" {
    gh_refused_run '.workflow_runs[0].conclusion = "failure"'
}

@test "refusal: a run with no conclusion (null) is not green" {
    gh_refused_run '.workflow_runs[0].conclusion = null'
}

@test "refusal: a commit with no run at all is not green" {
    gh_scn_green
    gh_no_run "$C_B"
    gh_no_run "$C_A"
    gh_verdict
    gh_expect none no_green_commit
}

@test "refusal: an in-progress run is pending, and the walk does not go back before CD_PENDING_MAX_MIN" {
    gh_scn_green
    gh_route_ci "$C_B" ".workflow_runs[0].status = \"in_progress\" | .workflow_runs[0].conclusion = null | .workflow_runs[0].created_at = \"$(gh_iso -600)\""
    gh_verdict
    gh_expect pending
    [ "$S" = "$C_B" ]
    [ "$(gh_calls)" -eq 1 ]
}

@test "refusal: a queued run older than CD_PENDING_MAX_MIN is walked back from (the parent is green)" {
    gh_scn_green
    gh_route_ci "$C_B" ".workflow_runs[0].status = \"queued\" | .workflow_runs[0].conclusion = null | .workflow_runs[0].created_at = \"$(gh_iso -$((91 * 60)))\""
    gh_verdict
    gh_expect green
    [ "$S" = "$C_A" ]
}

@test "refusal: the job Verify gate absent from a complete list is not green" {
    gh_scn_green
    gh_route_ci "$C_B" . '.jobs |= map(select(.name != "Verify gate")) | .total_count = 3'
    gh_no_run "$C_A"
    gh_verdict
    gh_expect none no_green_commit
}

@test "refusal: two jobs named Verify gate are no verdict" {
    gh_scn_green
    gh_route_ci "$C_B" . '.jobs += [.jobs[3]] | .total_count = 5'
    gh_verdict
    gh_expect unknown gate_duplicate
}

@test "refusal: a gate job of another head_sha is no verdict" {
    gh_scn_green
    gh_route_ci "$C_B" . '(.jobs[] | select(.name == "Verify gate") | .head_sha) = "1111111111111111111111111111111111111111"'
    gh_verdict
    gh_expect unknown gate_sha
}

@test "refusal: a failed gate job is not green" {
    gh_scn_green
    gh_route_ci "$C_B" . '(.jobs[] | select(.name == "Verify gate") | .conclusion) = "failure"'
    gh_no_run "$C_A"
    gh_verdict
    gh_expect none no_green_commit
}

@test "refusal: a list of jobs shorter than total_count is truncated, so no verdict" {
    gh_scn_green
    gh_route_ci "$C_B" . '.total_count = 101'
    gh_verdict
    gh_expect unknown gate_truncated
}

@test "refusal: a pull request merged into another base does not prove the commit (range_unverified)" {
    gh_scn_green
    gh_route "*/pulls?state=closed*" 200 "$(gh_prs '.[1].base.ref = "develop"' "$C_A" "$C_B")"
    gh_route "*/commits/${C_B}/pulls" 200 "$(gh_prs '.[0].base.ref = "develop"' "$C_B")"
    gh_verdict
    gh_expect hold range_unverified
    [ "$(jq -r '.uncovered | join(" ")' <<< "$output")" = "${C_B:0:12}" ]
}

@test "refusal: a closed but unmerged pull request does not prove the commit" {
    gh_scn_green
    gh_route "*/pulls?state=closed*" 200 "$(gh_prs '.[1].merged_at = null' "$C_A" "$C_B")"
    gh_route "*/commits/${C_B}/pulls" 200 "$(gh_prs '.[0].merged_at = null' "$C_B")"
    gh_verdict
    gh_expect hold range_unverified
}

@test "refusal: the live commit not an ancestor of the tip is the hold not_ancestor (live unknown to the mirror)" {
    gh_scn_green
    gh_rg -C "$GH_WORK" checkout -q -b other "$C_L0"
    gh_rg -C "$GH_WORK" commit -q --allow-empty -m other
    gh_seed_live "$(gh_rg -C "$GH_WORK" rev-parse HEAD)"
    gh_verdict
    gh_expect hold not_ancestor
    [ "$(gh_calls)" -eq 0 ]
}

@test "refusal: the live commit not an ancestor of the tip is the hold not_ancestor (live known to the mirror)" {
    gh_scn_green
    gh_rg -C "$GH_WORK" checkout -q -b other "$C_L0"
    gh_rg -C "$GH_WORK" commit -q --allow-empty -m other
    local oth
    oth="$(gh_rg -C "$GH_WORK" rev-parse HEAD)"
    gh_publish other
    gh_rg init -q --bare "${GREMION_ROOT}/data/cd/mirror.git"
    gh_rg --git-dir="${GREMION_ROOT}/data/cd/mirror.git" fetch -q "$GH_REMOTE" other:refs/heads/other
    gh_seed_live "$oth"
    gh_verdict
    gh_expect hold not_ancestor
    [ "$(gh_calls)" -eq 0 ]
}

@test "refusal: a batch above CD_MAX_BATCH is the hold batch_too_large with no API call; --allow-batch takes it" {
    gh_scn_green
    cd_write_cfg CD_REPO_URL=https://github.com/org/repo CD_MAX_BATCH=1
    gh_verdict
    gh_expect hold batch_too_large
    [ "$(jq -r '.commits' <<< "$output")" = 2 ]
    [ "$(gh_calls)" -eq 0 ]
    gh_verdict --allow-batch
    gh_expect green
}

@test "refusal: a candidate containing an open block is the hold blocked with no API call; --allow-blocked takes it" {
    cd_need_flock
    gh_scn_green
    run --separate-stderr gh_lib 'cd_lock_take; cd_block_add "$1" build_failed test' "$C_A"
    [ "$status" -eq 0 ]
    gh_verdict
    gh_expect hold blocked
    [ "$(gh_calls)" -eq 0 ]
    gh_verdict --allow-blocked
    gh_expect green
}

@test "refusal: a ruleset without required_status_checks naming Verify gate is the hold ruleset_missing" {
    gh_scn_green
    gh_route_rules 'map(select(.type != "required_status_checks"))'
    gh_verdict
    gh_expect hold ruleset_missing
    gh_route_rules '(.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[0].context) = "Other"'
    gh_verdict
    gh_expect hold ruleset_missing
}

@test "refusal: a ruleset without pull_request is the hold ruleset_missing" {
    gh_scn_green
    gh_route_rules 'map(select(.type != "pull_request"))'
    gh_verdict
    gh_expect hold ruleset_missing
}

@test "refusal: a ruleset without non_fast_forward or deletion is the hold ruleset_missing" {
    gh_scn_green
    gh_route_rules 'map(select(.type != "non_fast_forward"))'
    gh_verdict
    gh_expect hold ruleset_missing
    gh_route_rules 'map(select(.type != "deletion"))'
    gh_verdict
    gh_expect hold ruleset_missing
}

@test "rules: cd_gh_rules_ok prints the missing rule types" {
    gh_scn_green
    gh_route_rules 'map(select(.type != "pull_request" and .type != "deletion"))'
    run --separate-stderr gh_lib 'cd_gh_rules_ok'
    [ "$status" -eq 1 ]
    [ "$output" = "pull_request,deletion" ]
}

# -- the range proof ------------------------------------------------------------

@test "range: a squash commit that is a merged PR's merge_commit_sha passes (the green path)" {
    gh_scn_green
    gh_verdict
    gh_expect green
}

@test "range: a merge commit that is a merged PR's merge_commit_sha PASSES (the merge-method shape)" {
    gh_hist_init
    gh_commit A
    gh_merge M
    gh_publish
    gh_seed_live "$C_L0"
    gh_route_ci "$C_M"
    gh_route_pulls "$C_A" "$C_M"
    gh_route_rules
    gh_verdict
    gh_expect green
    [ "$S" = "$C_M" ]
}

@test "range: a merge commit that no merged PR claims is range_unverified" {
    gh_hist_init
    gh_commit A
    gh_merge M
    gh_publish
    gh_seed_live "$C_L0"
    gh_route_ci "$C_M"
    gh_route_pulls "$C_A"
    gh_route "*/commits/${C_M}/pulls" 200 "$(gh_prs . )"
    gh_route_rules
    gh_verdict
    gh_expect hold range_unverified
    [ "$(jq -r '.uncovered | join(" ")' <<< "$output")" = "${C_M:0:12}" ]
}

@test "range: a direct push (no PR at all) is range_unverified" {
    gh_scn_green
    gh_route_pulls "$C_A"
    gh_route "*/commits/${C_B}/pulls" 200 "$(gh_prs .)"
    gh_verdict
    gh_expect hold range_unverified
    [ "$(jq -r '.uncovered | join(" ")' <<< "$output")" = "${C_B:0:12}" ]
}

# gh_rebase_scn -- L0 (live) - R1 - R2 - R3 (the tip): one rebase-merged PR of three commits,
# only R3 is its merge_commit_sha.
gh_rebase_scn() {
    gh_hist_init
    gh_commit R1
    gh_commit R2
    gh_commit R3
    gh_publish
    gh_seed_live "$C_L0"
    gh_route_ci "$C_R3"
    gh_route_pulls "$C_R3"
    gh_route_rules
}

@test "range: a rebase-merged PR of three commits: R3 through F20(c), R1 and R2 through F20(d)" {
    gh_rebase_scn
    gh_route "*/commits/${C_R1}/pulls" 200 "$(gh_prs . "$C_R3")"
    gh_route "*/commits/${C_R2}/pulls" 200 "$(gh_prs . "$C_R3")"
    gh_verdict
    gh_expect green
    [ "$S" = "$C_R3" ]
}

@test "range: the intermediate commits are range_unverified when F20(d) returns nothing" {
    gh_rebase_scn
    gh_route "*/commits/${C_R1}/pulls" 200 "$(gh_prs .)"
    gh_route "*/commits/${C_R2}/pulls" 200 "$(gh_prs .)"
    gh_verdict
    gh_expect hold range_unverified
    [ "$(jq -r '.uncovered | sort | join(" ")' <<< "$output")" = "$(printf '%s\n' "${C_R1:0:12}" "${C_R2:0:12}" | sort | tr '\n' ' ' | sed 's/ $//')" ]
}

@test "range: the intermediate commits are range_unverified when F20(d) returns a PR that is not merged" {
    gh_rebase_scn
    gh_route "*/commits/${C_R1}/pulls" 200 "$(gh_prs '.[0].merged_at = null' "$C_R3")"
    gh_route "*/commits/${C_R2}/pulls" 200 "$(gh_prs '.[0].merged_at = null' "$C_R3")"
    gh_verdict
    gh_expect hold range_unverified
}

@test "range: the intermediate commits are range_unverified when the PR's merge_commit_sha is outside the range" {
    gh_rebase_scn
    gh_route "*/commits/${C_R1}/pulls" 200 "$(gh_prs . "$C_L0")"
    gh_route "*/commits/${C_R2}/pulls" 200 "$(gh_prs . "$C_L0")"
    gh_verdict
    gh_expect hold range_unverified
}

@test "range: the hold mails once per candidate (a second tick sends nothing) with the short SHAs only" {
    cd_need_flock
    gh_scn_green
    gh_route_pulls "$C_A"
    gh_route "*/commits/${C_B}/pulls" 200 "$(gh_prs .)"
    run --separate-stderr gh_lib 'cd_lock_take; cd_gh_candidate; cd_gh_candidate'
    [ "$status" -eq 0 ]
    [ "$(grep -c '^stub cd_notify' "$SHIM_LOG")" -eq 1 ]
    grep -Eq "^stub cd_notify held reason=range_unverified sha12=${C_B:0:12} uncovered=${C_B:0:12}\$" "$SHIM_LOG"
    # a marker in the state keeps a later process from mailing it again
    run --separate-stderr gh_lib 'cd_lock_take; cd_gh_candidate'
    [ "$(grep -c '^stub cd_notify' "$SHIM_LOG")" -eq 1 ]
}

@test "range: a dry run (the poll verb) neither mails nor writes the state" {
    cd_need_flock
    gh_scn_green
    gh_route_pulls "$C_A"
    gh_route "*/commits/${C_B}/pulls" 200 "$(gh_prs .)"
    local before
    before="$(cat "${GREMION_ROOT}/data/cd/state.json")"
    run --separate-stderr gh_lib 'cd_lock_take; cd_gh_candidate --dry-run'
    gh_expect_json_hold
    [ "$(grep -c '^stub cd_notify' "$SHIM_LOG")" -eq 0 ]
    [ "$(cat "${GREMION_ROOT}/data/cd/state.json")" = "$before" ]
}

gh_expect_json_hold() {
    [ "$status" -eq 0 ]
    [ "$(jq -r '.verdict' <<< "$output")" = hold ]
}

@test "range: --accept-range REASON is the only override, keeps every other check, and is logged" {
    gh_scn_green
    gh_route_pulls "$C_A"
    gh_route "*/commits/${C_B}/pulls" 200 "$(gh_prs .)"
    gh_verdict --accept-range "reviewed by hand"
    gh_expect green
    [ "$S" = "$C_B" ]
    grep -q '"event":"range_accepted"' "${GREMION_ROOT}/data/cd/history.jsonl"
    jq -e 'select(.event == "range_accepted") | .count == 1 and .sha12 == "'"${C_B:0:12}"'"' "${GREMION_ROOT}/data/cd/history.jsonl"
    # the other checks still apply: a failed run is not green however the range is accepted
    gh_route_ci "$C_B" '.workflow_runs[0].conclusion = "failure"'
    gh_no_run "$C_A"
    gh_verdict --accept-range "reviewed by hand"
    gh_expect none
    # a reason is required
    run --separate-stderr gh_lib 'cd_gh_candidate --accept-range'
    [ "$status" -eq 2 ]
}

# -- the merge-method precondition ---------------------------------------------

@test "merge methods: squash only plus a linear-history rule passes" {
    gh_scn_green
    run --separate-stderr gh_lib 'cd_gh_merge_methods_ok'
    [ "$status" -eq 0 ]
}

@test "merge methods: squash AND merge allowed fails" {
    gh_scn_green
    gh_route_rules '(.[] | select(.type == "pull_request") | .parameters.allowed_merge_methods) = ["squash", "merge"]'
    run --separate-stderr gh_lib 'cd_gh_merge_methods_ok'
    [ "$status" -eq 1 ]
}

@test "merge methods: no linear-history rule fails" {
    gh_scn_green
    gh_route_rules 'map(select(.type != "required_linear_history"))'
    run --separate-stderr gh_lib 'cd_gh_merge_methods_ok'
    [ "$status" -eq 1 ]
}

@test "merge methods: a pull_request rule that does not list the methods fails (absent means all allowed)" {
    gh_scn_green
    gh_route_rules '(.[] | select(.type == "pull_request") | .parameters) |= del(.allowed_merge_methods)'
    run --separate-stderr gh_lib 'cd_gh_merge_methods_ok'
    [ "$status" -eq 1 ]
}

@test "merge methods: CD_ALLOW_ANY_MERGE_METHOD=1 warns and returns 0, and the walk never depends on the check" {
    gh_scn_green
    gh_route_rules '(.[] | select(.type == "pull_request") | .parameters.allowed_merge_methods) = ["squash", "merge", "rebase"]'
    cd_write_cfg CD_REPO_URL=https://github.com/org/repo CD_ALLOW_ANY_MERGE_METHOD=1
    run --separate-stderr gh_lib 'cd_gh_merge_methods_ok'
    [ "$status" -eq 0 ]
    [[ "$stderr" == *"warning"* ]]
    # the walk is green whatever the methods are (the check belongs to adopt and selftest)
    cd_write_cfg CD_REPO_URL=https://github.com/org/repo
    gh_verdict
    gh_expect green
}

@test "merge methods: an unreadable answer is not a pass" {
    gh_scn_green
    gh_route "*/rules/branches/main" 500
    run --separate-stderr gh_lib 'cd_gh_merge_methods_ok'
    [ "$status" -eq 3 ]
}

# -- run attempts ----------------------------------------------------------------

@test "attempts: attempt 1 failed and attempt 2 succeeded, the latest attempt decides (green)" {
    gh_scn_green
    gh_route_ci "$C_B" '.workflow_runs = [(.workflow_runs[0] | .run_attempt = 1 | .conclusion = "failure"), (.workflow_runs[0] | .run_attempt = 2 | .conclusion = "success")]'
    gh_verdict
    gh_expect green
    [ "$S" = "$C_B" ]
}

@test "attempts: attempt 1 passed and attempt 2 failed, the verdict is not green" {
    gh_scn_green
    gh_route_ci "$C_B" '.workflow_runs = [(.workflow_runs[0] | .run_attempt = 2 | .conclusion = "failure"), (.workflow_runs[0] | .run_attempt = 1 | .conclusion = "success")]'
    gh_no_run "$C_A"
    gh_verdict
    gh_expect none
}

@test "attempts: a higher run_number decides over a lower one" {
    gh_scn_green
    gh_route_ci "$C_B" '.workflow_runs = [(.workflow_runs[0] | .run_number = 12 | .conclusion = "failure"), (.workflow_runs[0] | .run_number = 11 | .conclusion = "success")]'
    gh_no_run "$C_A"
    gh_verdict
    gh_expect none
}

# -- transport ---------------------------------------------------------------------

# gh_transport_unknown STATUS [BODY] [HEADERS] -- the run list answers that; no verdict.
gh_transport_unknown() {
    gh_scn_green
    gh_route "*/workflows/ci.yml/runs?*head_sha=${C_B}*" "$1" "${2:-}" "${3:-}"
    gh_verdict
    gh_expect unknown
    [ "$V" != green ]
    # the walk stopped at the first unknown: no guess from an older commit
    [ "$(gh_calls)" -eq 1 ]
}

@test "transport: HTTP 304 is unknown, never green" { gh_transport_unknown 304; }
@test "transport: HTTP 403 is unknown, never green" { gh_transport_unknown 403; }
@test "transport: HTTP 429 is unknown, never green" { gh_transport_unknown 429 "" "retry-after: 60"; }
@test "transport: HTTP 500 is unknown, never green" { gh_transport_unknown 500; }
@test "transport: a timeout is unknown, never green" { gh_transport_unknown TIMEOUT; }
@test "transport: an empty body is unknown, never green" { gh_transport_unknown 200 EMPTY; }

@test "transport: invalid JSON is unknown, never green" {
    printf 'not json at all\n' > "${GH}/junk.txt"
    gh_transport_unknown 200 "${GH}/junk.txt"
}

@test "transport: a JSON of the wrong shape is unknown, never green" {
    printf '{"workflow_runs": "nope"}\n' > "${GH}/shape1.json"
    printf '[]\n' > "${GH}/shape2.json"
    gh_transport_unknown 200 "${GH}/shape1.json"
    gh_transport_unknown 200 "${GH}/shape2.json"
}

@test "transport: a failing job list, pull request list or rules answer is unknown, never green" {
    gh_scn_green
    gh_route "*/actions/runs/*/jobs*" 500
    gh_verdict
    gh_expect unknown
    gh_scn_green
    gh_route "*/pulls?state=closed*" 403
    gh_verdict
    gh_expect unknown range_unavailable
    gh_scn_green
    gh_route "*/rules/branches/main" 500
    gh_verdict
    gh_expect unknown rules_unavailable
}

@test "transport: a malformed pull request list (not an array) is unknown" {
    gh_scn_green
    gh_route "*/pulls?state=closed*" 200 "${GH}/empty-object.json"
    gh_verdict
    gh_expect unknown range_unavailable
}

@test "transport: X-RateLimit-Remaining of 5 or less stops further calls (header matched in any case)" {
    gh_scn_green
    gh_route "*/workflows/ci.yml/runs?*head_sha=${C_B}*" 200 "$(gh_body run-push-success "$C_B")" "X-RateLimit-Remaining: 5;X-RateLimit-Reset: $(( $(cd_clock) + 1800 ))"
    gh_verdict
    gh_expect unknown budget
    [ "$(gh_calls)" -eq 1 ]
    # and once the reset time has passed the calls go on
    cd_advance 2000
    gh_route "*/workflows/ci.yml/runs?*head_sha=${C_B}*" 200 "$(gh_body run-push-success "$C_B")"
    gh_verdict
    [ "$(gh_calls)" -gt 1 ]
}

@test "transport: X-RateLimit-Remaining of 6 does not stop" {
    gh_scn_green
    gh_route "*/workflows/ci.yml/runs?*head_sha=${C_B}*" 200 "$(gh_body run-push-success "$C_B")" "x-ratelimit-remaining: 6;x-ratelimit-reset: $(( $(cd_clock) + 1800 ))"
    gh_verdict
    [ "$(gh_calls)" -gt 1 ]
}

@test "transport: a 403 pauses further calls (a rate-limit answer without the header too)" {
    gh_scn_green
    gh_route "*/workflows/ci.yml/runs?*" 403
    gh_verdict
    gh_expect unknown
    gh_verdict
    gh_expect unknown budget
    [ "$(gh_calls)" -eq 1 ]
}

@test "budget: the counter file refuses the 31st call in an hour and counts only the last hour" {
    gh_scn_green
    local now i
    now="$(cd_clock)"
    # 29 calls in the last hour and 100 older ones
    {
        for i in $(seq 1 100); do echo $((now - 4000)); done
        for i in $(seq 1 29); do echo $((now - 60)); done
    } > "${GREMION_ROOT}/data/cd/gh-calls"
    run --separate-stderr gh_lib 'cd_gh_calls_hour'
    [ "$output" = 29 ]
    run --separate-stderr gh_lib 'cd_gh_budget_left'
    [ "$status" -eq 0 ]
    [ "$output" = 1 ]
    gh_verdict
    gh_expect unknown budget
    # the 30th call was made, the 31st was refused
    [ "$(gh_calls)" -eq 1 ]
    run --separate-stderr gh_lib 'cd_gh_budget_left'
    [ "$status" -eq 1 ]
    [ "$output" = 0 ]
    [ "$(gh_calls)" -eq 1 ]
}

@test "budget: CD_API_BUDGET_PER_HOUR is honoured" {
    gh_scn_green
    cd_write_cfg CD_REPO_URL=https://github.com/org/repo CD_API_BUDGET_PER_HOUR=2
    gh_verdict
    gh_expect unknown budget
    [ "$(gh_calls)" -eq 2 ]
}

@test "api: a path outside the allowed characters is refused before any call" {
    gh_scn_green
    run --separate-stderr gh_lib 'cd_gh_api "repos/org/repo/../../user"'
    [ "$status" -eq 2 ]
    run --separate-stderr gh_lib 'cd_gh_api "repos/org/repo/x y"'
    [ "$status" -eq 2 ]
    [ "$(gh_calls)" -eq 0 ]
}

@test "api: a repository URL that is not github.com is refused (2), no call" {
    gh_scn_green
    cd_write_cfg CD_REPO_URL=https://example.org/org/repo
    run --separate-stderr gh_lib 'cd_gh_api "repos/org/repo/rules/branches/main"'
    [ "$status" -eq 2 ]
    [ "$(gh_calls)" -eq 0 ]
}

# -- the cache ---------------------------------------------------------------------

@test "cache: a batch of 40 commits after a long hold asks the API once per distinct fact" {
    local i name
    local -a all=()
    gh_hist_init
    for i in $(seq 1 40); do
        gh_commit "N${i}"
        name="C_N${i}"
        all+=("${!name}")
    done
    gh_publish
    gh_seed_live "$C_L0"
    gh_route_ci "$C_N40"
    gh_route_pulls "${all[@]}"
    gh_route_rules
    gh_verdict
    gh_expect green
    [ "$S" = "$C_N40" ]
    # runs, jobs, ONE page of pull requests, rules: far under the budget of 30 an hour
    [ "$(gh_calls)" -le 5 ]
    # the second time the facts are cached: the run list and the rules are asked, nothing else
    local before
    before="$(gh_calls)"
    gh_verdict
    gh_expect green
    [ "$(( $(gh_calls) - before ))" -eq 2 ]
    [ "$(grep -c 'pulls?state=closed' "${GH}/urls.log")" -eq 1 ]
    [ "$(grep -c '/jobs' "${GH}/urls.log")" -eq 1 ]
}

@test "cache: a completed run is cached by run id and attempt; a new attempt is asked again" {
    gh_scn_green
    gh_route_ci "$C_B"
    local idb="$GH_LAST_ID"
    gh_verdict
    gh_expect green
    gh_verdict
    gh_expect green
    [ "$(grep -c "/runs/${idb}/jobs" "${GH}/urls.log")" -eq 1 ]
    gh_route "*/workflows/ci.yml/runs?*head_sha=${C_B}*" 200 \
        "$(gh_body run-push-success "$C_B" ".workflow_runs[0].id = ${idb} | .workflow_runs[0].run_attempt = 2")"
    gh_verdict
    gh_expect green
    [ "$(grep -c "/runs/${idb}/jobs" "${GH}/urls.log")" -eq 2 ]
}

@test "cache: pending, unknown and a 304 are never cached" {
    gh_scn_green
    gh_route_ci "$C_B" ".workflow_runs[0].status = \"in_progress\" | .workflow_runs[0].conclusion = null | .workflow_runs[0].created_at = \"$(gh_iso -60)\""
    gh_verdict
    gh_expect pending
    gh_route "*/workflows/ci.yml/runs?*head_sha=${C_B}*" 304
    gh_verdict
    gh_expect unknown
    gh_route "*/workflows/ci.yml/runs?*head_sha=${C_B}*" 500
    gh_verdict
    gh_expect unknown
    [ -z "$(ls "${GREMION_ROOT}/data/cd/cache" 2>/dev/null)" ]
    run --separate-stderr gh_lib 'cd_gh_cache_put k pending'
    [ "$status" -eq 2 ]
    run --separate-stderr gh_lib 'cd_gh_cache_put k unknown'
    [ "$status" -eq 2 ]
    run --separate-stderr gh_lib 'cd_gh_cache_put k ""'
    [ "$status" -eq 2 ]
    run --separate-stderr gh_lib 'cd_gh_cache_get k'
    [ "$status" -eq 1 ]
}

@test "cache: the directory is mode 0700 and an entry round-trips" {
    fs_carries_modes "$GREMION_ROOT" || skip "this filesystem does not persist modes"
    gh_scn_green
    gh_verdict
    gh_expect green
    [ "$(stat -c '%a' "${GREMION_ROOT}/data/cd/cache")" = 700 ]
    run --separate-stderr gh_lib 'cd_gh_cache_put fact-1 covered; cd_gh_cache_get fact-1'
    [ "$status" -eq 0 ]
    [ "$output" = covered ]
}

@test "cache: an unreadable or hostile entry is a miss, never a hit" {
    gh_scn_green
    mkdir -p "${GREMION_ROOT}/data/cd/cache"
    printf 'gate-ok; rm -rf /\n' > "${GREMION_ROOT}/data/cd/cache/hostile"
    run --separate-stderr gh_lib 'cd_gh_cache_get hostile'
    [ "$status" -eq 1 ]
    run --separate-stderr gh_lib 'cd_gh_cache_get "../hostile"'
    [ "$status" -eq 2 ]
}

# -- the token ----------------------------------------------------------------------

gh_token_file() {
    local f="${GREMION_ROOT}/etc/secrets/gh-token"
    printf '%s\n' "${1:-ghp_exampletoken0123456789ABCDEF}" > "$f"
    chmod 600 "$f"
    cd_write_cfg CD_REPO_URL=https://github.com/org/repo "CD_GITHUB_TOKEN_FILE=${f}"
}

@test "token: sent only on stdin (curl -K -), never in argv, the environment, the history or the state" {
    cd_need_flock
    gh_scn_green
    gh_token_file
    run --separate-stderr gh_lib 'cd_lock_take; cd_gh_candidate'
    [ "$status" -eq 0 ]
    [ "$(jq -r .verdict <<< "$output")" = green ]
    grep -q '^header = "Authorization: Bearer ghp_exampletoken0123456789ABCDEF"$' "${GH}/stdin.1"
    grep -q '^curl -K -$' "$SHIM_LOG"
    ! grep -rq 'ghp_example' "$SHIM_LOG"
    ! grep -q 'ghp_example' "${GH}"/env.*
    ! grep -rq 'ghp_example' "${GREMION_ROOT}/data" "${GREMION_ROOT}/runtime"
    # the argv of every curl call is exactly -K -
    [ "$(grep -c '^curl ' "$SHIM_LOG")" -eq "$(gh_calls)" ]
    [ "$(grep '^curl ' "$SHIM_LOG" | sort -u)" = "curl -K -" ]
}

@test "token: no token file configured sends no Authorization header" {
    gh_scn_green
    gh_verdict
    gh_expect green
    ! grep -q 'Authorization' "${GH}"/stdin.*
}

@test "token: an absent token file is not an error" {
    gh_scn_green
    cd_write_cfg CD_REPO_URL=https://github.com/org/repo CD_GITHUB_TOKEN_FILE=/nonexistent/gh-token
    gh_verdict
    gh_expect green
    ! grep -q 'Authorization' "${GH}"/stdin.*
}

@test "token: a token file with a quote or a second line cannot add a curl directive" {
    gh_scn_green
    gh_token_file 'ghp_aaaaaaaaaaaaaaaaaaaaaaaa"
url = "https://example.invalid/'
    gh_verdict
    gh_expect green
    ! grep -q 'Authorization' "${GH}"/stdin.*
    ! grep -q 'example.invalid' "${GH}"/stdin.*
}

@test "token: a 401 retries unauthenticated once and queues one token-expired mail" {
    cd_need_flock
    gh_scn_green
    gh_token_file
    gh_route "*/workflows/ci.yml/runs?*head_sha=${C_B}*" 401A "$(gh_body run-push-success "$C_B" '.workflow_runs[0].id = 1002')"
    gh_route "*/actions/runs/1002/jobs?*" 200 "$(gh_body jobs-ci "$C_B")"
    run --separate-stderr gh_lib 'cd_lock_take; cd_gh_candidate'
    [ "$(jq -r .verdict <<< "$output")" = green ]
    # the run list was asked twice: with the token (401), then without it
    [ "$(grep -c "head_sha=${C_B}" "${GH}/urls.log")" -eq 2 ]
    grep -q 'Authorization' "${GH}/stdin.1"
    ! grep -q 'Authorization' "${GH}/stdin.2"
    [ "$(sed -n 1p "${GH}/urls.log")" = "$(sed -n 2p "${GH}/urls.log")" ]
    [ "$(grep -c '^stub cd_notify held reason=github_token_expired' "$SHIM_LOG")" -eq 1 ]
    # the expired token is remembered: the next evaluation does not send it again and the
    # mail is not queued twice
    local before
    before="$(gh_calls)"
    run --separate-stderr gh_lib 'cd_lock_take; cd_gh_candidate'
    [ "$(grep -c '^stub cd_notify held reason=github_token_expired' "$SHIM_LOG")" -eq 1 ]
    ! grep -q 'Authorization' "${GH}/stdin.$((before + 1))"
}

@test "token: a 401 without a token is plain unknown" {
    gh_scn_green
    gh_route "*/workflows/ci.yml/runs?*" 401
    gh_verdict
    gh_expect unknown
}

# -- the walk back ----------------------------------------------------------------

@test "walk-back: a red tip and a green parent select the parent" {
    gh_scn_green
    gh_route_ci "$C_B" '.workflow_runs[0].conclusion = "failure"'
    gh_verdict
    gh_expect green
    [ "$S" = "$C_A" ]
    [ "$(jq -r .tip <<< "$output")" = "$C_B" ]
    [ "$(jq -r .walked <<< "$output")" = 1 ]
}

@test "walk-back: the range of a walked-back commit is the range up to THAT commit" {
    gh_scn_green
    gh_route_ci "$C_B" '.workflow_runs[0].conclusion = "failure"'
    # B has no PR at all, A has one: only A is in the range that must be proven
    gh_route_pulls "$C_A"
    gh_verdict
    gh_expect green
    [ "$S" = "$C_A" ]
}

@test "walk-back: ten red commits give none, and no more than CD_WALKBACK commits are looked at" {
    local i
    gh_hist_init
    for i in $(seq 1 12); do
        gh_commit "R${i}"
    done
    gh_publish
    gh_seed_live "$C_L0"
    gh_route "*/workflows/ci.yml/runs?*" 200 "$(gh_body run-push-success none '.workflow_runs[0].conclusion = "failure"')"
    gh_verdict
    gh_expect none no_green_commit
    [ "$(gh_calls)" -eq 10 ]
}

@test "walk-back: CD_WALKBACK is honoured" {
    local i
    gh_hist_init
    for i in $(seq 1 6); do
        gh_commit "R${i}"
    done
    gh_publish
    gh_seed_live "$C_L0"
    cd_write_cfg CD_REPO_URL=https://github.com/org/repo CD_WALKBACK=3
    gh_route "*/workflows/ci.yml/runs?*" 200 "$(gh_body run-push-success none '.workflow_runs[0].conclusion = "failure"')"
    gh_verdict
    gh_expect none
    [ "$(gh_calls)" -eq 3 ]
}

# -- proof mode -----------------------------------------------------------------------

gh_proof_repo() {
    local sha
    gh_hist_init
    gh_rg -C "$GH_WORK" checkout -q -b proof-x
    gh_rg -C "$GH_WORK" commit -q --allow-empty -m proof
    sha="$(gh_rg -C "$GH_WORK" rev-parse HEAD)"
    gh_rg init -q --bare "$GH_PROOF"
    gh_rg -C "$GH_WORK" push -q "$GH_PROOF" "proof-x:proof/x"
    PROOF_SHA="$sha"
    cd_write_cfg CD_REPO_URL=https://github.com/org/repo CD_PROOF_MODE=1 CD_PROOF_REPO=https://example.org/proof/repo
}

@test "proof: cd_gh_proof_source returns 2 when CD_PROOF_MODE is 0 and touches nothing" {
    gh_hist_init
    run --separate-stderr gh_lib 'cd_gh_proof_source "$1" proof/x' "$C_L0"
    [ "$status" -eq 2 ]
    ! grep -q '^git ' "$SHIM_LOG"
    [ ! -e "${GREMION_ROOT}/data/cd/mirror.git" ]
}

@test "proof: the commit is fetched from CD_PROOF_REPO under refs/proof/<ref>, with no API call" {
    gh_proof_repo
    run --separate-stderr gh_lib 'cd_gh_proof_source "$1" proof/x' "$PROOF_SHA"
    [ "$status" -eq 0 ]
    [ "$(gh_rg --git-dir="${GREMION_ROOT}/data/cd/mirror.git" rev-parse refs/proof/proof/x)" = "$PROOF_SHA" ]
    [ "$(gh_calls)" -eq 0 ]
    ! grep -q '^curl' "$SHIM_LOG"
    grep -q 'fetch.*https://example.org/proof/repo' "$SHIM_LOG"
}

@test "proof: a branch tip that differs from the SHA is refused and the ref is removed" {
    gh_proof_repo
    run --separate-stderr gh_lib 'cd_gh_proof_source "$1" proof/x' "$C_L0"
    [ "$status" -eq 1 ]
    run gh_rg --git-dir="${GREMION_ROOT}/data/cd/mirror.git" rev-parse --verify --quiet refs/proof/proof/x
    [ "$status" -ne 0 ]
}

@test "proof: a bad SHA or a bad branch name is refused (2) before any fetch" {
    gh_proof_repo
    run --separate-stderr gh_lib 'cd_gh_proof_source abc proof/x'
    [ "$status" -eq 2 ]
    run --separate-stderr gh_lib 'cd_gh_proof_source "$1" "../x"' "$PROOF_SHA"
    [ "$status" -eq 2 ]
    run --separate-stderr gh_lib 'cd_gh_proof_source "$1" "-x"' "$PROOF_SHA"
    [ "$status" -eq 2 ]
    ! grep -q ' fetch ' "$SHIM_LOG"
}

@test "proof: proof mode without CD_PROOF_REPO is refused (2)" {
    gh_hist_init
    cd_write_cfg CD_REPO_URL=https://github.com/org/repo CD_PROOF_MODE=1
    run --separate-stderr gh_lib 'cd_gh_proof_source "$1" proof/x' "$C_L0"
    [ "$status" -eq 2 ]
}

# -- the poll verb ---------------------------------------------------------------------

@test "poll: the verb prints the verdict of the newest candidate through the dispatcher (a dry run)" {
    gh_scn_green
    run --separate-stderr cd_prog poll
    [ "$status" -eq 0 ]
    [ "$(jq -r .verdict <<< "$output")" = green ]
    [ "$(jq -r .sha <<< "$output")" = "$C_B" ]
    [ "$(grep -c '^stub ' "$SHIM_LOG" || true)" -eq 0 ]
}

@test "poll: a candidate named on the command line is judged instead of the tip" {
    gh_scn_green
    run --separate-stderr cd_prog poll "${C_A:0:12}"
    [ "$status" -eq 0 ]
    [ "$(jq -r .sha <<< "$output")" = "$C_A" ]
    [ "$(jq -r .verdict <<< "$output")" = green ]
}

@test "poll: a named commit that is not on main is none (not_on_main)" {
    gh_scn_green
    gh_rg -C "$GH_WORK" checkout -q -b elsewhere "$C_L0"
    gh_rg -C "$GH_WORK" commit -q --allow-empty -m elsewhere
    gh_publish elsewhere
    local el
    el="$(gh_rg -C "$GH_WORK" rev-parse HEAD)"
    gh_rg init -q --bare "${GREMION_ROOT}/data/cd/mirror.git"
    gh_rg --git-dir="${GREMION_ROOT}/data/cd/mirror.git" fetch -q "$GH_REMOTE" elsewhere:refs/heads/elsewhere
    run --separate-stderr cd_prog poll "${el:0:12}"
    [ "$(jq -r .verdict <<< "$output")" = none ]
    [ "$(jq -r .reason <<< "$output")" = not_on_main ]
}

@test "poll: no live release in the state is a precondition failure (2), never a verdict" {
    gh_scn_green
    cd_seed_state
    run --separate-stderr cd_prog poll
    [ "$status" -eq 2 ]
    [ -z "$output" ]
}

# -- hygiene ----------------------------------------------------------------------------

@test "hygiene: github.sh sources quietly, sets no options and never exits at the top level" {
    local f="${HOST_SRC}/lib/cd/github.sh"
    ! grep -Eq '^set [-+][A-Za-z]' "$f"
    ! grep -Eq '^(exit|return)([[:space:]]+[0-9$"]|[[:space:]]*$)' "$f"
    run bash -c 'set -euo pipefail; . "$1"; . "$2"; . "$3"; echo sourced' _ "${HOST_SRC}/lib/common.sh" "${HOST_SRC}/lib/cd/core.sh" "$f"
    [ "$status" -eq 0 ]
    [ "$output" = sourced ]
}

@test "hygiene: github.sh never passes the token or any URL of the API on a command line" {
    local f="${HOST_SRC}/lib/cd/github.sh"
    # curl is only ever run as `curl -K -` with the config on stdin
    run grep -En '(^|[^A-Za-z_])curl ' "$f"
    local line
    while IFS= read -r line; do
        [[ "$line" == *"curl -K -"* || "$line" == *"command -v curl"* || "$line" == *"#"* || "$line" == *"is not installed"* ]] || {
            echo "curl outside -K -: $line"
            return 1
        }
    done <<< "$output"
}

@test "hygiene: github.sh carries no real host, address or person (reserved names only)" {
    local f="${HOST_SRC}/lib/cd/github.sh" g
    for g in "$f" "${HOST_TEST_DIR}/cd-github.bats" "${HOST_TEST_DIR}/test_helper/cd-github.bash"; do
        ! grep -Eo '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$g" \
            | grep -Ev '@(example\.org|example\.com)$|@[A-Za-z0-9.-]+\.(invalid|test)$' | grep -q . \
            || { echo "address in $g"; return 1; }
        ! grep -Eo '(^|[^0-9.])([0-9]{1,3}\.){3}[0-9]{1,3}([^0-9.]|$)' "$g" \
            | grep -Ev '203\.0\.113\.|127\.0\.0\.1|0\.0\.0\.0' | grep -q . \
            || { echo "IPv4 in $g"; return 1; }
    done
    ! grep -rEq '[A-Za-z0-9._-]+@' "${HOST_TEST_DIR}/fixtures/cd/github"
}
