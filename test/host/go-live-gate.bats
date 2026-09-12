#!/usr/bin/env bats
# Drift guards for docs/ops/go-live-gate.md.
#
# A gate document cannot be "run", so nothing notices when it rots. These
# tests are what notices: every command it names must exist, every proof line
# it quotes must be printed by something under infra/host, every runtime
# artefact it cites must be written by something under infra/host, no compose
# invocation may carry a flag the host forbids (N20), and no real address may
# appear in a public document. One step in the gate is a check rather than a
# citation — N12's registry-credential read — and that one is extracted from
# the document and executed against real fixtures: it must give different
# answers in different states, and must not read as green over nothing.
#
# DEVIATION, on purpose: every other suite under test/host/ loads
# 'test_helper/host' for the docker/nft/ssh shims. This suite shims nothing —
# it reads two trees of text — so it loads the kernel helper
# test/test_helper/common.bash instead, for PROJECT_ROOT. The second test
# asserts PROJECT_ROOT is non-empty so this coupling fails loudly rather than
# silently rebasing every path onto "/".
#
# Every test that reads the document asserts [ -f "$GATE_DOC" ] first. Without
# that, four of these guards are vacuously green when the file is missing or
# mis-pathed — a grep over nothing matches nothing — which is the failure mode
# the positive control in test 7 exists to catch.
#
# Run: bats test/host/go-live-gate.bats

load '../test_helper/common'

GATE_DOC="${PROJECT_ROOT}/docs/ops/go-live-gate.md"
HOST_DIR="${PROJECT_ROOT}/infra/host"
BIN_DIR="${PROJECT_ROOT}/infra/host/bin"

# gremion-* names the gate may use that are services or units, not host bins.
NON_BIN_NAMES='^(gremion-ui|gremion-ui-oss|gremion-public|gremion-public-oss|gremion-control|gremion-module-sdk)$'

GATE_IDS=(G1-LEGAL G2-RESTORE G3-VERIFY G4-MAIL G5-TENANT G6-OFFBOX G7-ERASURE G8-GUARDS-RED)
GATE_FIELDS=('**Gate:**' '**Proof:**' '**Owner:**' '**Evidence:**')

# ---------------------------------------------------------------------------
# Dependencies the gate legitimately cites that have NOT landed on this branch
# yet. Task 10 (gremion-restore-into) is built in parallel with the task that
# wrote this file, so its program, its RTO-SECONDS= proof line and its
# runtime/last-restore.json artefact do not exist in this tree.
#
# This is not a waiver. The last test in this file fails the moment any listed
# entry DOES exist, so the merge that lands Task 10 must delete the entry or
# the suite goes RED. An allowlist that cannot outlive its reason is the only
# kind this file accepts.
PENDING_BINS=()                                  # Task 10 landed (gremion-restore-into)
PENDING_TOKENS=()                                # Task 10 landed (RTO-SECONDS=)
PENDING_ARTEFACTS=()                             # Task 10 landed (runtime/last-restore.json)

is_pending() {                                   # <needle> <candidate>...
    local needle="$1"; shift
    local item
    for item in "$@"; do
        [ "$item" = "$needle" ] && return 0
    done
    return 1
}

# A proof token is either the literal BLOCKED: or a SHOUT-CASE name with at
# least one hyphen, ending in ':' or '='. The hyphen requirement is what keeps
# PATH=, HOME= and other shell noise out of the set; BLOCKED: is named
# explicitly because it is the one hyphen-free token the gate depends on.
PROOF_TOKEN_RE='(BLOCKED:|[A-Z][A-Z0-9]*(-[A-Z0-9]+)+[:=])'

# Scans the WHOLE document, fenced blocks included: the load-bearing proof
# lines are quoted inside fenced code blocks, never in prose alone.
proof_tokens() {
    grep -oE "$PROOF_TOKEN_RE" "$GATE_TEXT" 2>/dev/null | sort -u | grep -vE '^G[1-8]-' || true
}

# A token counts as printed when the host tooling's source holds it verbatim,
# OR holds its bare name as a quoted string literal. The second arm is not a
# loophole; it is a fact about how one of these lines is built. gremion-fw-proof
# sets tag="FW-PROOF" and then prints "${tag}: egress25-app=...", so the literal
# FW-PROOF followed by a colon appears in no source file even though the program
# prints it on every run — test/host/fw-proof.bats asserts that exact line
# against the program's real output. The search stays inside infra/host so this
# guard can never read its own text, or another suite's comment, as evidence.
#
# `bare` is assigned in its OWN statement: `local a="$1" b="${a%x}"` expands $a
# from the CALLER's scope, which left the pattern as ["']["'] — two adjacent
# quote characters, which occur all over the tree — and made every token count
# as printed. The expiry test at the bottom of this file is what caught it.
token_is_printed() {
    local tok="$1"
    local bare="${tok%[:=]}"
    [ -n "$bare" ] || return 1
    grep -rqF -- "$tok" "$HOST_DIR" && return 0
    grep -rqE -- "[\"']${bare}[\"']" "$HOST_DIR" && return 0
    return 1
}

# Every guard below reads GATE_TEXT, a CR-stripped copy of the document, not the
# document itself. This repository is checked out with core.autocrlf=true on
# Windows and `git archive` applies the same conversion, so docs/ops/*.md arrives
# CRLF there; an anchored pattern like ^## G1-LEGAL$ then never matches, awk's
# $0 == "## " id is never equal, and the structural guards report drift that does
# not exist. Measured: running this suite against `git archive HEAD` failed tests
# 3, 4, 5 and 12 for exactly that reason and nothing else. The existence check
# stays on the real path, so a missing document still fails loudly.
setup() {
    GATE_TEXT="${BATS_TEST_TMPDIR:-${BATS_TMPDIR:-/tmp}}/go-live-gate.text"
    if [ -f "$GATE_DOC" ]; then
        tr -d '\r' < "$GATE_DOC" > "$GATE_TEXT"
    else
        : > "$GATE_TEXT"
    fi
}

# Body of one "## <id>" section.
gate_section() {
    awk -v id="$1" '
        $0 == "## " id { inb = 1; next }
        /^## / { inb = 0 }
        inb { print }
    ' "$GATE_TEXT"
}

@test "the gate document exists" {
    [ -f "$GATE_DOC" ]
}

@test "PROJECT_ROOT is exported by the kernel test helper" {
    [ -n "${PROJECT_ROOT:-}" ]
    [ -d "${PROJECT_ROOT}/infra/host" ]
}

@test "the gate declares each of the eight items exactly once" {
    [ -f "$GATE_DOC" ]
    local id count
    for id in "${GATE_IDS[@]}"; do
        count="$(grep -cE "^## ${id}\$" "$GATE_TEXT" || true)"
        if [ "${count:-0}" != "1" ]; then
            echo "heading '## ${id}' appears ${count:-0} times, expected 1" >&2
            return 1
        fi
    done
}

@test "every gate item carries Gate, Proof, Owner and Evidence" {
    [ -f "$GATE_DOC" ]
    local id field body
    for id in "${GATE_IDS[@]}"; do
        body="$(gate_section "$id")"
        for field in "${GATE_FIELDS[@]}"; do
            if ! grep -qF -- "$field" <<<"$body"; then
                echo "${id} has no ${field} field" >&2
                return 1
            fi
        done
    done
}

@test "every Owner is OPERATOR, AGENT or OPERATOR + AGENT" {
    [ -f "$GATE_DOC" ]
    local owner bad=0 seen=0
    # Only a line that STARTS with the field is an item's Owner. The "How to
    # read an item" table documents the same field inside a cell, and reading
    # that cell as if it were a value is what a bulk grep -F does.
    while read -r owner; do
        seen=$((seen + 1))
        case "$owner" in
            'OPERATOR'|'AGENT'|'OPERATOR + AGENT') ;;
            *) echo "unknown Owner value: '${owner}'" >&2; bad=1 ;;
        esac
    done < <(grep -E '^\*\*Owner:\*\*' "$GATE_TEXT" | sed 's/^\*\*Owner:\*\* *//; s/ *$//')
    if [ "$seen" -ne "${#GATE_IDS[@]}" ]; then
        echo "found ${seen} Owner lines, expected ${#GATE_IDS[@]} — one per gate item" >&2
        return 1
    fi
    [ "$bad" -eq 0 ]
}

@test "every gremion-* command the gate names has a file in infra/host/bin" {
    [ -f "$GATE_DOC" ]
    local name missing=()
    while read -r name; do
        [[ "$name" =~ $NON_BIN_NAMES ]] && continue
        is_pending "$name" "${PENDING_BINS[@]}" && continue
        [ -f "${BIN_DIR}/${name}" ] || missing+=("$name")
    done < <(grep -oE 'gremion-[a-z0-9-]+' "$GATE_TEXT" | sort -u)
    if [ "${#missing[@]}" -ne 0 ]; then
        echo "gate names commands with no file in infra/host/bin: ${missing[*]}" >&2
        return 1
    fi
}

@test "the proof-token extractor finds the four load-bearing tokens" {
    # A positive control over the extractor itself. Without it, an extractor
    # that matched nothing would make the next test pass vacuously — which is
    # exactly what a backtick-only pattern did: it saw BLOCKED: and missed
    # FW-PROOF:, MAIL-BRINGUP: and RTO-SECONDS= because they live in fenced
    # blocks.
    [ -f "$GATE_DOC" ]
    local found want
    found="$(proof_tokens | tr '\n' ' ')"
    for want in 'BLOCKED:' 'FW-PROOF:' 'MAIL-BRINGUP:' 'RTO-SECONDS='; do
        if ! grep -qF -- "$want" <<<"$found"; then
            echo "extractor missed '${want}'; it found: ${found}" >&2
            return 1
        fi
    done
}

@test "every proof token the gate quotes is printed by the host tooling" {
    [ -f "$GATE_DOC" ]
    local tok missing=()
    while read -r tok; do
        [ -n "$tok" ] || continue
        is_pending "$tok" "${PENDING_TOKENS[@]}" && continue
        token_is_printed "$tok" || missing+=("$tok")
    done < <(proof_tokens)
    if [ "${#missing[@]}" -ne 0 ]; then
        echo "gate quotes proof tokens nothing under infra/host prints: ${missing[*]}" >&2
        return 1
    fi
}

@test "every runtime artefact the gate cites is written by the host tooling" {
    [ -f "$GATE_DOC" ]
    local art missing=()
    while read -r art; do
        is_pending "$art" "${PENDING_ARTEFACTS[@]}" && continue
        grep -rqF -- "$art" "$HOST_DIR" && continue
        grep -rqF -- "${art#runtime/}" "$HOST_DIR" && continue
        missing+=("$art")
    done < <(grep -oE 'runtime/[a-z0-9.-]+' "$GATE_TEXT" | sort -u)
    if [ "${#missing[@]}" -ne 0 ]; then
        echo "gate cites runtime artefacts nothing under infra/host writes: ${missing[*]}" >&2
        return 1
    fi
}

# A deploy.log line is written by infra/host/bin/gremion-deploy's log_step and
# by nothing else. Its format is not "STEP n name ok": log_step prepends an
# ISO-8601 timestamp, so every line begins with the date. A gate pattern
# anchored at ^STEP therefore matches nothing — and the half of the proof that
# counts FAILED steps then prints 0 on a deploy in which every step failed,
# which is a guard that lies in the direction the gate exists to prevent.
#
# The fixture is produced by lifting log_step out of the real program and
# running it. Writing a sample line here instead would only move the drift:
# the gate's pattern would be checked against this file's idea of a log line
# rather than the program's.
real_deploy_log() {                              # <path to write>
    local body
    body="$(awk '/^log_step\(\) \{/ { inb = 1 }
                 inb            { print }
                 inb && /^\}/   { exit }' "${BIN_DIR}/gremion-deploy")"
    [ -n "$body" ] || return 1
    # shellcheck disable=SC2034  # DEPLOY_LOG is read by the eval'd log_step body,
    # which shellcheck cannot see; empty means "print, do not append to a file".
    ( DEPLOY_LOG=""; eval "$body"; log_step 3 checkout ok; log_step 4 render fail ) > "$1"
}

# Extracts the quoted regex from every grep the gate aims at deploy.log,
# single- or double-quoted.
deploy_log_patterns() {
    grep -F 'deploy.log' "$GATE_TEXT" | grep -F 'grep' \
        | sed -nE -e "s/.*grep[^']*'([^']*)'.*/\1/p" \
                  -e 's/.*grep[^"]*"([^"]*)".*/\1/p'
}

@test "every deploy.log pattern the gate greps matches a line gremion-deploy writes" {
    [ -f "$GATE_DOC" ]
    [ -f "${BIN_DIR}/gremion-deploy" ]

    local fixture="${BATS_TEST_TMPDIR}/deploy.log"
    real_deploy_log "$fixture" || { echo "could not lift log_step out of gremion-deploy" >&2; return 1; }

    # Positive control on the fixture: two lines, one ok, one fail. If log_step
    # ever stops producing them this test must fail here, not silently pass
    # because every pattern matched an empty file.
    [ "$(wc -l < "$fixture")" -eq 2 ]
    local ok_line fail_line
    ok_line="$(sed -n 1p "$fixture")"
    fail_line="$(sed -n 2p "$fixture")"
    [[ "$ok_line" == *" ok" ]]
    [[ "$fail_line" == *" fail" ]]

    local re pats=() dead=() sees_fail=0
    while IFS= read -r re; do
        [ -n "$re" ] || continue
        pats+=("$re")
    done < <(deploy_log_patterns)

    # Positive control on the extractor: the gate quotes an ok-count and a
    # fail-count. Fewer than two means the extractor is reading nothing and
    # the loop below would pass vacuously.
    if [ "${#pats[@]}" -lt 2 ]; then
        echo "found ${#pats[@]} deploy.log grep pattern(s) in the gate, expected at least 2" >&2
        return 1
    fi

    for re in "${pats[@]}"; do
        if ! grep -qE -- "$re" "$fixture"; then
            dead+=("$re")
        fi
        if grep -qE -- "$re" <<<"$fail_line"; then
            sees_fail=1
        fi
    done

    if [ "${#dead[@]}" -ne 0 ]; then
        echo "gate greps deploy.log with pattern(s) no real log line matches:" >&2
        printf '  %s\n' "${dead[@]}" >&2
        echo "a real line looks like: ${ok_line}" >&2
        return 1
    fi
    if [ "$sees_fail" -ne 1 ]; then
        echo "no deploy.log pattern in the gate matches a FAILED step — the fail-count proof would read 0 on a fully-failed deploy" >&2
        echo "a real failed line looks like: ${fail_line}" >&2
        return 1
    fi
}

# ---------------------------------------------------------------------------
# The N12 registry-credential step, RUN rather than read.
#
# gremion-deploy asserts this itself in a trap on every exit path, and
# test/host/deploy.bats covers that guard. What the two tests below cover is the
# runbook step an operator types by hand as the gate's independent read — which
# for one revision of this document was a single-line grep for an "auths" key
# over a file docker writes pretty-printed. That pattern answered 1 over a
# config holding a live token and 1 over an empty {}: a guard whose answer is a
# constant, in the one item whose whole subject is guards that cannot fire.
#
# So the step is extracted from the document and EXECUTED, against a real
# pretty-printed config.json, in three states. Checking the document for a
# blessed spelling instead would only move the drift: a rewrite of the step has
# to keep discriminating, not keep a particular pattern. The extracted block's
# absolute paths are rebased into BATS_TEST_TMPDIR before it runs, so it never
# reads the real /root/.docker/config.json of the box running the suite — a
# developer with a registry login would otherwise see a false RED.

# Every fenced block of <section body> that names a Docker config file, each
# preceded by a __BLOCK__ marker line so the caller can count them. More than
# one, or none, is drift the caller must report rather than guess through.
gate_docker_config_blocks() {                    # <section body>
    awk '
        /^```/ {
            if (inb) { if (hit) printf "__BLOCK__\n%s", buf; inb = 0; hit = 0; buf = "" }
            else     { inb = 1; hit = 0; buf = "" }
            next
        }
        inb {
            buf = buf $0 "\n"
            if ($0 ~ /\.docker\/config\.json/) hit = 1
        }
    ' <<<"$1"
}

# The jq predicate inside gremion-deploy's own assert_no_docker_auths, lifted
# out of the program the way real_deploy_log lifts log_step. Empty when the
# function is gone or no longer uses jq, which fails the test that reads it —
# naming the drift instead of passing on a stale expectation.
program_auths_predicate() {
    awk '/^assert_no_docker_auths\(\) \{/ { inb = 1 }
         inb                              { print }
         inb && /^\}/                     { exit }' "${BIN_DIR}/gremion-deploy" \
        | sed -nE "s/.*jq -e '([^']*)'.*/\1/p" | head -1
}

# Writes the gate's N12 step, rebased into <sandbox>, to <path>.
extract_n12_step() {                             # <sandbox> <path to write>
    local sandbox="$1" out="$2" blocks markers
    blocks="$(gate_docker_config_blocks "$(gate_section G8-GUARDS-RED)")"
    markers="$(grep -c '^__BLOCK__$' <<<"$blocks" || true)"
    if [ "${markers:-0}" != "1" ]; then
        echo "G8-GUARDS-RED holds ${markers:-0} fenced block(s) naming a Docker config, expected exactly 1" >&2
        return 1
    fi
    grep -v '^__BLOCK__$' <<<"$blocks" \
        | sed -e "s#/root/#${sandbox}/root/#g" -e "s#/home/#${sandbox}/home/#g" > "$out"
    [ -s "$out" ] || return 1
    # This block gets EXECUTED, so it must hold the credential check and nothing
    # else. Commentary may name a program; a command line may not. Without this,
    # a check sharing one fence with the rest of the item has the test run
    # gremion-fw-proof and a nested `bats test/host` — measured, against the
    # revision of the document that held a single fence.
    if grep -vE '^[[:space:]]*#' "$out" \
       | grep -qE '(^|[[:space:]])(bats|gremion-[a-z0-9-]+)([[:space:]]|$)'; then
        echo "the N12 credential check shares its fenced block with another program." >&2
        echo "This test executes that block, so the check must have a fence of its own." >&2
        return 1
    fi
}

# Runs the extracted step with every Docker config location inside the sandbox.
# The step is a check, so a non-zero exit is a result, not an error: the caller
# asserts on what it printed.
run_n12_step() {                                 # <sandbox> <script>
    ( DOCKER_CONFIG="$1/dockercfg" HOME="$1/home/gremion" bash "$2" 2>&1 ) || true
}

@test "the gate's N12 credential step tells a surviving credential from a clean config" {
    [ -f "$GATE_DOC" ]
    [ -f "${BIN_DIR}/gremion-deploy" ]

    local sandbox="${BATS_TEST_TMPDIR}/n12"
    local step="${sandbox}/step.sh"
    # Every location the program's docker_config_files can resolve to, all of
    # them inside the sandbox: DOCKER_CONFIG, the deploy user's home, and
    # root's. The fixture is written to all three, so a step that reads only one
    # of them still sees a real credential and still has to say so. Which
    # locations the step covers is the sibling test's subject, not this one's.
    local cfgs=(
        "${sandbox}/dockercfg/config.json"
        "${sandbox}/home/gremion/.docker/config.json"
        "${sandbox}/root/.docker/config.json"
    )
    local cfg
    for cfg in "${cfgs[@]}"; do mkdir -p "$(dirname "$cfg")"; done
    extract_n12_step "$sandbox" "$step" || return 1

    # The auth blob is BUILT here, not pasted: a committed base64 literal of
    # "<user>:<password>" is high-entropy enough that gitleaks reports the
    # fixture itself as a finding, and this repo allowlists by value rather than
    # by path so test files stay scanned. Pretty-printed, as docker writes it.
    local blob
    blob="$(printf 'x-access-token:not-a-real-token' | base64)"
    for cfg in "${cfgs[@]}"; do
        cat > "$cfg" <<EOF
{
  "auths": {
    "ghcr.io": {
      "auth": "${blob}"
    }
  }
}
EOF
    done

    # Positive control on the fixture: it must be the shape that defeats a
    # single-line pattern, or the discrimination below proves nothing.
    [ "$(wc -l < "${cfgs[0]}")" -gt 1 ]
    run grep -q '"auths": {[^}]' "${cfgs[0]}"
    [ "$status" -ne 0 ]

    local dirty clean absent
    dirty="$(run_n12_step "$sandbox" "$step")"
    for cfg in "${cfgs[@]}"; do printf '{}\n' > "$cfg"; done
    clean="$(run_n12_step "$sandbox" "$step")"
    rm -f "${cfgs[@]}"
    absent="$(run_n12_step "$sandbox" "$step")"

    local red_re='(FAIL|fail|surviv|dirty=[1-9])'
    local green_re='(^|[[:space:]=])clean([[:space:]]|$)'

    if [ "$dirty" = "$clean" ]; then
        echo "the gate's N12 step answers the same thing with and without a surviving credential:" >&2
        echo "$dirty" >&2
        return 1
    fi
    if ! grep -qE "$red_re" <<<"$dirty"; then
        echo "a config.json holding a credential did not make the gate's N12 step say so:" >&2
        echo "$dirty" >&2
        return 1
    fi
    if ! grep -qE "$green_re" <<<"$clean"; then
        echo "an empty {} config did not make the gate's N12 step report clean:" >&2
        echo "$clean" >&2
        return 1
    fi
    if grep -qE "$red_re" <<<"$clean"; then
        echo "an empty {} config was reported as a surviving credential:" >&2
        echo "$clean" >&2
        return 1
    fi
    if grep -qE "$green_re" <<<"$absent"; then
        echo "the gate's N12 step reports clean when it read no Docker config at all:" >&2
        echo "$absent" >&2
        echo "nothing read must not read as green — that is a pass by absence" >&2
        return 1
    fi
}

@test "the gate's N12 credential step uses gremion-deploy's own jq predicate" {
    [ -f "$GATE_DOC" ]
    [ -f "${BIN_DIR}/gremion-deploy" ]

    local pred
    pred="$(program_auths_predicate)"
    if [ -z "$pred" ]; then
        echo "no jq predicate could be lifted out of gremion-deploy's assert_no_docker_auths" >&2
        return 1
    fi

    local sandbox="${BATS_TEST_TMPDIR}/n12pred" step="${BATS_TEST_TMPDIR}/n12pred/step.sh"
    mkdir -p "$sandbox"
    extract_n12_step "$sandbox" "$step" || return 1

    if ! grep -qF -- "$pred" "$step"; then
        echo "the gate's N12 step does not use the program's predicate: ${pred}" >&2
        cat "$step" >&2
        return 1
    fi
    # The program's docker_config_files checks /root as well as the deploy
    # user's config. A step that reads one home only can report clean while a
    # credential sits in the other.
    if ! grep -qF -- "${sandbox}/root/.docker/config.json" "$step"; then
        echo "the gate's N12 step does not read /root/.docker/config.json, which the program does" >&2
        cat "$step" >&2
        return 1
    fi
}

@test "no compose invocation in the gate uses -f, --profile or -p" {
    [ -f "$GATE_DOC" ]
    run grep -nE 'docker compose[^|#]*( -f | --profile | -p )' "$GATE_TEXT"
    if [ "$status" -ne 1 ]; then
        echo "forbidden compose flag (N20):" >&2
        echo "$output" >&2
        return 1
    fi
}

@test "the gate carries no address outside the documentation ranges" {
    [ -f "$GATE_DOC" ]
    local bad
    bad="$(grep -oE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' "$GATE_TEXT" | sort -u \
           | grep -vE '^(203\.0\.113\.[0-9]+|198\.51\.100\.[0-9]+|192\.0\.2\.[0-9]+|127\.0\.0\.1|0\.0\.0\.0)$' || true)"
    if [ -n "$bad" ]; then
        echo "non-documentation address in a public document: $bad" >&2
        return 1
    fi
}

@test "the sequence section names every gate item" {
    [ -f "$GATE_DOC" ]
    local id body
    body="$(awk '/^## Sequence$/ { inb = 1; next } /^## / { inb = 0 } inb' "$GATE_TEXT")"
    for id in "${GATE_IDS[@]}"; do
        if ! grep -qF -- "$id" <<<"$body"; then
            echo "${id} is not reachable from the sequence table" >&2
            return 1
        fi
    done
}

@test "no pending dependency has landed while its entry is still listed" {
    # The expiry half of the PENDING_* lists above. The moment Task 10's
    # program, proof line or artefact exists in this tree, this test goes RED
    # naming the entry to delete — so a temporary allowlist cannot become a
    # permanent hole, and the three guards above start policing those names
    # again in the same commit that lands the dependency.
    local n t a landed=()
    for n in "${PENDING_BINS[@]}"; do
        if [ -f "${BIN_DIR}/${n}" ]; then
            landed+=("PENDING_BINS entry '${n}' — infra/host/bin/${n} now exists")
        fi
    done
    for t in "${PENDING_TOKENS[@]}"; do
        if token_is_printed "$t"; then
            landed+=("PENDING_TOKENS entry '${t}' — the host tooling prints it now")
        fi
    done
    for a in "${PENDING_ARTEFACTS[@]}"; do
        if grep -rqF -- "$a" "$HOST_DIR" || grep -rqF -- "${a#runtime/}" "$HOST_DIR"; then
            landed+=("PENDING_ARTEFACTS entry '${a}' — the host tooling writes it now")
        fi
    done
    if [ "${#landed[@]}" -ne 0 ]; then
        printf 'delete this entry from test/host/go-live-gate.bats: %s\n' "${landed[@]}" >&2
        return 1
    fi
}
