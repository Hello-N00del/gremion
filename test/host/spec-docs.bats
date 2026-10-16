#!/usr/bin/env bats
# The two operator-approved design specs (spec B, spec D; 2026-09-15) must live
# IN the kernel and be TRACKED, because every later unit cites them by repo path.
# They arrived in a directory .gitignore used to blanket-ignore as generated
# scratch output, so "the file is on disk" was never the same as "the repo
# carries it" — which is the state this suite pins.
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
  b="$(git -C "$KERNEL_ROOT" ls-files -- 'docs/design-specs/spec-b-*.md' | wc -l)"
  d="$(git -C "$KERNEL_ROOT" ls-files -- 'docs/design-specs/spec-d-*.md' | wc -l)"
  [ "$b" -eq 1 ]
  [ "$d" -eq 1 ]
}

@test "the tracked spec B carries the B0 row, the P1-P5 posture and the ledger path" {
  local f
  f="$(git -C "$KERNEL_ROOT" ls-files -- 'docs/design-specs/spec-b-*.md')"
  grep -qF 'B0-spec-docs-and-waiver-ledger' "${KERNEL_ROOT}/${f}"
  grep -qF 'Release-1 posture (P1' "${KERNEL_ROOT}/${f}"
  grep -qF 'docs/ops/release-1-waivers.md' "${KERNEL_ROOT}/${f}"
}

@test "the tracked spec D carries its own unit registry" {
  local f
  f="$(git -C "$KERNEL_ROOT" ls-files -- 'docs/design-specs/spec-d-*.md')"
  grep -qF 'D2-module-json-and-dist-schema' "${KERNEL_ROOT}/${f}"
}

@test "nothing else under docs/design-specs is tracked (only the two approved specs live there)" {
  local extra
  extra="$(git -C "$KERNEL_ROOT" ls-files -- 'docs/design-specs' \
            | grep -vE '^docs/design-specs/spec-[bd]-[^/]+\.md$' || true)"
  if [ -n "$extra" ]; then
    echo "unexpected file(s) tracked under docs/design-specs:" >&2
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
  [[ "$output" == *"docs/design-specs/spec-b-"* ]]
  [[ "$output" == *"B1a-realm-identity-and-boot-import"* ]]
}

@test "docs/deployment-architecture.md is tracked and uses documentation values only" {
  run git -C "$KERNEL_ROOT" ls-files --error-unmatch -- docs/deployment-architecture.md
  [ "$status" -eq 0 ]
  grep -qF '203.0.113.0/24' "${KERNEL_ROOT}/docs/deployment-architecture.md"
  grep -qF '2001:db8::/32'  "${KERNEL_ROOT}/docs/deployment-architecture.md"
  grep -qF 'example.org'    "${KERNEL_ROOT}/docs/deployment-architecture.md"
  # The ACME exemption is a named, accepted exposure — not an unremarked hole.
  grep -qF 'acme-http@internal' "${KERNEL_ROOT}/docs/deployment-architecture.md"
  grep -qF 'accepted exposure'  "${KERNEL_ROOT}/docs/deployment-architecture.md"
}

@test "the hygiene rule and the tree-wide bats scan enumerate the same six literals" {
  # Count INSIDE the HOST_LITERALS array, not across the whole 1100-line
  # script. Counted file-wide the number is 6 only because HOST_LITERALS
  # happens to be the sole four-space-indented `name:` key in the file today;
  # B1b and D8 both edit this script next, and the first unrelated object
  # literal they add would turn a test about the spec-A host literals red for a
  # reason that has nothing to do with them.
  local block mjs res samples
  # Strip CR before awk: scripts/kernel-hygiene-check.mjs carries no
  # eol=lf .gitattributes rule, so a Windows checkout (core.autocrlf=true)
  # gives the working copy CRLF line endings, and both awk anchors below
  # are end-of-line anchors (`\[$`, `^\]$`) that silently match nothing
  # against a `\r\n` file — leaving $block empty and this test dying on
  # the vacuity floor below instead of running its real assertions.
  block="$(tr -d '\r' < "${KERNEL_ROOT}/scripts/kernel-hygiene-check.mjs" \
      | awk '/^const HOST_LITERALS = \[$/{f=1;next} f && /^\]$/{f=0} f')"
  [ -n "$block" ]
  # The range really stopped at the array: the next declaration is outside it.
  run bash -c "printf '%s\n' \"\$1\" | grep -q HOST_LITERAL_EXEMPT" _ "$block"
  [ "$status" -ne 0 ]
  mjs="$(printf '%s\n' "$block" | grep -cE "^    name: '")"
  [ "$mjs" -eq 6 ]
  # Every entry carries the pair that makes it a rule; a name with no regex
  # would enumerate a literal nothing scans for.
  res="$(printf '%s\n' "$block" | grep -cE "^    re: ")"
  samples="$(printf '%s\n' "$block" | grep -cE "^    sample: ")"
  [ "$res" -eq 6 ]
  [ "$samples" -eq 6 ]
  for n in edge-ipv4-prefix ipv6-allocation-prefix host-inventory-name \
           provider-default-hostname host-fqdn registrar; do
    grep -qF "name: '${n}'" "${KERNEL_ROOT}/scripts/kernel-hygiene-check.mjs"
    grep -qF "  ${n}" "${KERNEL_ROOT}/test/host/no-host-literals.bats"
  done
}
