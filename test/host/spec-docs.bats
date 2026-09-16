#!/usr/bin/env bats
# The two operator-approved design specs (spec B, spec D; 2026-09-15) must live
# IN the kernel and be TRACKED, because every later unit cites them by repo path.
# They arrived in a directory .gitignore blanket-ignores as AI tooling output
# (.gitignore:188 `docs/superpowers/`), so "the file is on disk" was never the
# same as "the repo carries it" — which is the state this suite pins.
#
# Every test asserts through `git ls-files`, not `test -f`: an untracked file
# reads identical on disk and ships nowhere.
#
# Run: bats test/host/spec-docs.bats

load '../test_helper/common'

KERNEL_ROOT="${PROJECT_ROOT}"

@test "PROJECT_ROOT resolves (vacuity: no test below may rebase onto /)" {
  [ -n "$KERNEL_ROOT" ]
  [ -f "${KERNEL_ROOT}/KNOWN_ISSUES.md" ]
}

@test "exactly one tracked spec-b-*.md and one tracked spec-d-*.md" {
  local b d
  b="$(git -C "$KERNEL_ROOT" ls-files -- 'docs/superpowers/specs/spec-b-*.md' | wc -l)"
  d="$(git -C "$KERNEL_ROOT" ls-files -- 'docs/superpowers/specs/spec-d-*.md' | wc -l)"
  [ "$b" -eq 1 ]
  [ "$d" -eq 1 ]
}

@test "the tracked spec B carries the B0 row, the P1-P5 posture and the ledger path" {
  local f
  f="$(git -C "$KERNEL_ROOT" ls-files -- 'docs/superpowers/specs/spec-b-*.md')"
  grep -qF 'B0-spec-docs-and-waiver-ledger' "${KERNEL_ROOT}/${f}"
  grep -qF 'Release-1 posture (P1' "${KERNEL_ROOT}/${f}"
  grep -qF 'docs/ops/release-1-waivers.md' "${KERNEL_ROOT}/${f}"
}

@test "the tracked spec D carries its own unit registry" {
  local f
  f="$(git -C "$KERNEL_ROOT" ls-files -- 'docs/superpowers/specs/spec-d-*.md')"
  grep -qF 'D2-module-json-and-dist-schema' "${KERNEL_ROOT}/${f}"
}

@test "nothing else under docs/superpowers is tracked (the tooling ignore still holds)" {
  local extra
  extra="$(git -C "$KERNEL_ROOT" ls-files -- 'docs/superpowers' \
            | grep -vE '^docs/superpowers/specs/spec-[bd]-[^/]+\.md$' || true)"
  if [ -n "$extra" ]; then
    echo "tooling artefact(s) tracked under docs/superpowers:" >&2
    printf '%s\n' "$extra" >&2
  fi
  [ -z "$extra" ]
}

@test "KNOWN_ISSUES T11 points at the in-repo spec that owns its resolution" {
  # Anchor on the stable head of the heading, not its whole text: B1a rewrote
  # the T11 heading ("... is still `<retired realm>`" -> "... the login-theme
  # half is CLOSED") and B1b rewrites it again. A full-text anchor would match
  # nothing and hand this test an empty range, which is why the `-n "$output"`
  # floor below is checked before the two content assertions.
  run awk '/^### The Keycloak realm/{f=1;next} f&&/^### /{exit} f' \
      "${KERNEL_ROOT}/KNOWN_ISSUES.md"
  [ -n "$output" ]
  [[ "$output" == *"docs/superpowers/specs/spec-b-"* ]]
  [[ "$output" == *"B1a-realm-identity-and-boot-import"* ]]
}
