#!/usr/bin/env bats
# Drift guards for docs/ops/release-1-waivers.md, the signed P4 waiver ledger.
#
# Six go-live-gate items are waived until the pilot (spec B §1.4, §G). The
# hazard the ledger exists for is a reading error, not a code defect: "the
# release deployed" read as "the gate passed". So the ledger must name each
# waiver, its §L item number and the gate id it suspends — and must never claim
# an item spec B keeps as a technical proof (§L:3 the reboot gate, §L:7 the
# erasure proof).
#
# This file is also the CONTRACT gremion-verify parses at run time: the row
# shape asserted below is the shape infra/host/bin/gremion-verify reads out of
# the release tree. Change one and this suite fails.
#
# It loads test/test_helper/common (PROJECT_ROOT), not test_helper/host: this
# suite shims nothing, it reads text.
#
# NOTE ON TEST NAMES. Every @test title below is ASCII on purpose. bats 1.13 on
# the maintainer's Windows box cannot address a test whose name carries a
# non-ASCII byte: it reported `bats: unknown test name` and then
# `Executed 5 instead of expected 7` — two assertions silently did not run,
# which is exactly the vacuous pass this suite exists to prevent. The section
# numbers are spelled out in the bodies and comments instead.
#
# Run: bats test/host/release-1-waivers.bats

load '../test_helper/common'

# ONE parser for the ledger row shape. waiver_rows() lives in the library the
# READER loads too, so this guard cannot become more permissive than the thing
# it guards - which is the only direction two copies of a pattern ever drift.
# shellcheck source=../../infra/host/lib/common.sh
. "${PROJECT_ROOT}/infra/host/lib/common.sh"

LEDGER="${PROJECT_ROOT}/docs/ops/release-1-waivers.md"
GATE_DOC="${PROJECT_ROOT}/docs/ops/go-live-gate.md"

WAIVER_IDS=(offsite-backup-remote external-probe-and-alerting mail-bringup
            legal-documents apex-dns pilot-inputs)
WAIVER_LITEMS=(2 6 4 1 5 5)
WAIVER_GATES=(G2-RESTORE G6-OFFBOX G4-MAIL G1-LEGAL G5-TENANT G5-TENANT)

# "<id> <litem> <gate>" per ledger row, sorted. Anchored on the row shape so a
# waiver mentioned only in prose does not count as declared. The parse is
# waiver_rows() from infra/host/lib/common.sh - literally the function
# gremion-verify reads the ledger with.
ledger_triples() {
  waiver_rows "$LEDGER" | awk -F'|' '{ print $1, $2, $3 }' | sort
}

@test "the ledger exists, is tracked, and the expectation arrays stay in step" {
  [ -f "$LEDGER" ]
  run git -C "$PROJECT_ROOT" ls-files --error-unmatch -- docs/ops/release-1-waivers.md
  [ "$status" -eq 0 ]
  [ "${#WAIVER_IDS[@]}" -eq 6 ]
  [ "${#WAIVER_LITEMS[@]}" -eq 6 ]
  [ "${#WAIVER_GATES[@]}" -eq 6 ]
}

@test "the ledger declares exactly the six waivers with their L item and gate id" {
  local got expected="" i
  got="$(ledger_triples)"
  [ "$(printf '%s\n' "$got" | wc -l)" -eq 6 ]
  for i in "${!WAIVER_IDS[@]}"; do
    expected="${expected}${WAIVER_IDS[$i]} ${WAIVER_LITEMS[$i]} ${WAIVER_GATES[$i]}"$'\n'
  done
  expected="$(printf '%s' "$expected" | sort)"
  if [ "$got" != "$expected" ]; then
    printf 'ledger:\n%s\nexpected:\n%s\n' "$got" "$expected" >&2
  fi
  [ "$got" = "$expected" ]
}

@test "every gate id the ledger names is defined by the go-live gate document" {
  local gate
  [ -f "$GATE_DOC" ]
  while read -r _ _ gate; do
    [ -n "$gate" ]
    grep -qF "## ${gate}" "$GATE_DOC" || { echo "invented gate id: ${gate}" >&2; false; }
  done < <(ledger_triples)
}

@test "the ledger waives no item spec B keeps as a technical proof (L:3, L:7)" {
  local item
  while read -r _ item _; do
    [ "$item" != "3" ]
    [ "$item" != "7" ]
  done < <(ledger_triples)
}

@test "the ledger says in words that release 1 is a deployment bar, not the gate" {
  grep -qF 'deployment bar, not the go-live gate' "$LEDGER"
  grep -qF 'docs/ops/go-live-gate.md' "$LEDGER"
}

@test "the measured local restore is explicitly NOT waived by the off-site row" {
  grep -qE '^\| `offsite-backup-remote` \| §L:2 \|.*measured local restore .*not waived' "$LEDGER"
}

@test "the named residuals are recorded and are NOT dressed as waivers" {
  # A residual is a thing release 1 ships with, not a gate item anyone waived.
  # It lives in its own section, as prose, so it can never parse as a row.
  grep -qF '## Named residuals' "$LEDGER"
  grep -qF 'frozen-lockfile' "$LEDGER"
  grep -qF 'D-05' "$LEDGER"
  # vacuity + shape: the residual section adds no seventh triple
  [ "$(ledger_triples | wc -l)" -eq 6 ]
}

VERIFY_BIN="${PROJECT_ROOT}/infra/host/bin/gremion-verify"

@test "gremion-verify reads the ledger from the release tree and enumerates nothing itself" {
  # The drift guard this replaces compared two copies. There is now one copy:
  # the verifier must name the ledger path and must contain no hardcoded
  # '<id>|<litem>|<gate>|…' row of its own.
  grep -qF 'current/docs/ops/release-1-waivers.md' "$VERIFY_BIN"
  run grep -nE "^[[:space:]]*'[a-z0-9-]{1,}\|[0-9]\|G[0-9]-[A-Z]{1,}\|" "$VERIFY_BIN"
  [ "$status" -ne 0 ] || { echo "an in-script waiver table is back:" >&2; echo "$output" >&2; false; }
}

@test "gremion-verify never hands a waiver to ok()" {
  local id
  for id in "${WAIVER_IDS[@]}"; do
    run grep -nE "^[[:space:]]*ok .*${id}" "$VERIFY_BIN"
    [ "$status" -ne 0 ]
  done
  # The id-by-id greps above cannot see the ONE mutation that turns all six
  # waivers green at once: `waived() { ok "$@"; }`. Measured - under exactly
  # that mutation every grep above stayed non-matching and this test passed,
  # so it proved nothing about the behaviour it is named for. The printer is
  # therefore pinned directly: it must exist, it must print its own line, and
  # it must not delegate to the green printer.
  run grep -cE '^waived\(\) \{ printf ' "$VERIFY_BIN"
  [ "$output" = "1" ]
  run grep -nE '^waived\(\).*[^a-zA-Z_](ok|info)[[:space:]]' "$VERIFY_BIN"
  [ "$status" -ne 0 ] || { echo "waived() delegates to a printer that is not its own:" >&2; echo "$output" >&2; false; }
}

@test "one parser: the ledger row shape is defined once, in common.sh" {
  # A guard that carries its own copy of the row pattern drifts looser than the
  # reader and then counts rows the reader never saw. Measured before this was
  # shared: one markdown-legal escaped pipe inside a cell cost gremion-verify
  # the apex-dns waiver - five printed, waivers[] of length 5, exit 0 - while
  # this suite still counted six and stayed green.
  grep -qF 'waiver_rows() {' "${PROJECT_ROOT}/infra/host/lib/common.sh"
  grep -qF 'waiver_candidate_count() {' "${PROJECT_ROOT}/infra/host/lib/common.sh"
  grep -qF 'waiver_rows "$ledger"' "$VERIFY_BIN"
  grep -qF 'waiver_rows "$LEDGER"' "$BATS_TEST_FILENAME"
  # Neither the reader nor this guard may carry a second copy of the pattern.
  # The needle is an ERE that matches the row sed WITHOUT matching its own
  # source line - a literal needle for a pattern-ban always finds itself first,
  # and a guard that only ever catches itself catches nothing.
  local needle="sed -n .s/.\| \`"
  # Vacuity: the needle must still find the ONE real copy, in common.sh.
  run grep -cE "$needle" "${PROJECT_ROOT}/infra/host/lib/common.sh"
  [ "$output" = "1" ]
  run grep -nE "$needle" "$VERIFY_BIN" "$BATS_TEST_FILENAME"
  [ "$status" -ne 0 ] || { echo "a second copy of the ledger row pattern:" >&2; echo "$output" >&2; false; }
  # The reader measures the parse against the candidate count rather than
  # against a floor of one row.
  grep -qF 'parsed == candidates' "$VERIFY_BIN"
}
