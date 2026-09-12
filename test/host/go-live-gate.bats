#!/usr/bin/env bats
# Drift guards for docs/ops/go-live-gate.md.
#
# A gate document cannot be "run", so nothing notices when it rots. These
# tests are what notices: every command it names must exist, every proof line
# it quotes must be printed by something under infra/host, every runtime
# artefact it cites must be written by something under infra/host, no compose
# invocation may carry a flag the host forbids (N20), and no real address may
# appear in a public document.
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
PENDING_BINS=(gremion-restore-into)              # Task 10
PENDING_TOKENS=('RTO-SECONDS=')                  # Task 10
PENDING_ARTEFACTS=(runtime/last-restore.json)    # Task 10

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
