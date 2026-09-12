#!/usr/bin/env bats
# The public-kernel host-literal guard (skeleton Global Constraints, spec A).
#
# WHAT IT FORBIDS. Six strings identify the operator's netcup machine: its IPv4
# /16 prefix, its IPv6 allocation prefix, its inventory name, the provider's
# default hostname, its FQDN and its registrar. None of them may appear
# anywhere under this repository, which is public. The host-specific values
# live in /opt/gremion/etc/env/*.env on the host and in PRIVATE StuRaOS
# documents; the kernel's own examples use example.org, 203.0.113.0/24 and
# 2001:db8::/32 (RFC 2606 / RFC 5737 / RFC 3849).
#
# WHY THIS FILE AND NOT scripts/kernel-hygiene-check.mjs's (i1). (i1) owns the
# two RETIRED hosts (the stopped staging deployment and an unowned domain) and
# runs under `make lint-hygiene`, which needs a Node toolchain. This list runs
# under `make test-unit`, which needs only bash and bats -- the toolchain a
# Debian host and a fresh agent worktree actually have. Two lists, two homes,
# one stated reason. Folding this into (i1) as an (i3) is a legitimate
# follow-up; it is not done here because this plan's file list is fixed.
#
# NOT COVERED HERE, on purpose: the `stura*` product tokens. They are still in
# this tree and N13 / spec B own their removal. A pattern added here today
# would be RED on day one, and a guard that is red on day one gets deleted
# rather than fixed.
#
# THREE LESSONS COPIED FROM (i1), each with a test below that proves it:
#   1. ESCAPED SPELLINGS. A host survives longest in its regexp-escaped form --
#      a Traefik HostRegexp leg, a DOMAIN_REGEX value, an nft comment, a doc.
#      (i1)'s own comment calls this leg load-bearing: a pattern without it
#      walked past every escaped occurrence and reported clean.
#   2. VACUITY. A scan that reaches zero files reports clean. Nothing here
#      believes a clean result until the canary test has proven the scanner
#      reaches this tree, and until every pattern has matched its own sample.
#   3. EXEMPTIONS CARRY A REASON, AND ARE PROVEN STILL NEEDED. A stale
#      exemption reads as coverage while excluding whatever is on it.
#
# HOW LESSON 1 IS IMPLEMENTED, AND WHY NOT THE OBVIOUS WAY. The obvious way is
# a pattern with an optional backslash before each dot. It does not survive the
# trip through bash quoting: such a fragment reaches grep in a form that
# matches neither the plain nor the escaped spelling -- measured on this box,
# both git grep and grep -E returned nothing for either. So NO PATTERN HERE
# CONTAINS A BACKSLASH. Each separator is written as a negated character class
# with a {0,2} bound, which matches "." and the escaped spelling alike, and
# also "-", "_" and " . ". Over-matching is the safe direction for a leak
# guard, and the exemption list exists for the rare false positive.
#
# WHY THE PATTERNS ARE FRAGMENTED. The Global Constraint is that the literal
# must not appear ANYWHERE under this repository, and a guard is not exempt
# from the rule it enforces. bash concatenates adjacent quoted strings at parse
# time, so the runtime pattern is whole while the bytes committed here are not
# -- every fragment boundary inserts two quote characters, which is one more
# than the {0,2} bound allows, so no pattern and no sample in this file matches
# itself. Test 2 covers this file too, which is what proves it.
# Honest limit: fragmentation defeats a string search, not a reader. What is
# never written here at all is the part that matters -- no full address, no
# /64, no credential.

load 'test_helper/host'

KERNEL_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

HOST_LITERAL_NAMES=(
  edge-ipv4-prefix
  ipv6-allocation-prefix
  host-inventory-name
  provider-default-hostname
  host-fqdn
  registrar
)

# Extended regular expressions, matched case-insensitively, backslash-free.
# The [:space:] exclusion in host-inventory-name is deliberate: without it the
# pattern matches the phrase "Gremion production" in ordinary prose and the
# guard would have shipped with a false positive on day one.
HOST_LITERAL_PATTERNS=(
  '159''[^0-9]{0,2}''195''[^0-9]'
  '2a0a''[^0-9a-z]{0,2}''4cc0'
  'gremion''[^a-z0-9[:space:]]{1,2}''prod'
  'quick''srv'
  'rs1''[^a-z0-9]{0,2}''gremion''[^a-z0-9]{0,2}''de'
  'in''wx'
)

# One concrete sample per pattern, used only by the self-proof tests, which
# plant them in throwaway repositories. A pattern that stopped matching its own
# sample fails here instead of reporting the tree clean.
HOST_LITERAL_SAMPLES=(
  '159''.195''.10.20'
  '2a0a'':''4cc0::1'
  'gremion-''prod'
  'quick''srv'
  'rs1''.gremion''.de'
  'IN''WX'
)

# The regexp-escaped spellings of the three separator-bearing patterns, for
# lesson 1. These are the spellings the naive pattern walked straight past.
HOST_LITERAL_ESCAPED_SAMPLES=(
  '159''\.195''\.10.20'
  'gremion''\-''prod'
  'rs1''\.gremion''\.de'
)
HOST_LITERAL_ESCAPED_NAMES=(edge-ipv4-prefix host-inventory-name host-fqdn)

# <name>|<path> -- an occurrence that is provably not a host literal.
# Every entry needs a reason above it and must still be necessary (test 7).
#
# registrar | docs/compliance/controller-processor-split.md
#   The sub-processor table names the registrar as a supplier under Art. 28
#   GDPR ("Registrar and authoritative DNS ... No API credential exists, by
#   decision"). It is a disclosure obligation, not an operational detail: no
#   address, no hostname, no credential. The kernel is the repository that
#   publishes it. Reviewed 2026-09-09; test 7 fails if the occurrence goes
#   away and this entry stays.
HOST_LITERAL_EXEMPTIONS=(
  'registrar|docs/compliance/controller-processor-split.md'
)

literal_exempt() {  # $1 = pattern name, $2 = repo-relative path
  local name="$1" path="$2" entry
  for entry in ${HOST_LITERAL_EXEMPTIONS[@]+"${HOST_LITERAL_EXEMPTIONS[@]}"}; do
    if [ "${entry%%|*}" = "$name" ] && [ "${entry#*|}" = "$path" ]; then
      return 0
    fi
  done
  return 1
}

# Prints "<name> <path>:<line>:<text>" for every un-exempted hit; 1 if any.
# git grep, not a recursive grep: it honours .gitignore (so node_modules,
# .superpowers and the rest of the ignored tree can neither slow it down nor
# fill it with noise) and skips .git itself, while --untracked makes it see a
# file that has been created but not yet added -- which is the state a leak is
# actually in when it matters.
scan_literals() {  # $1 = repository directory
  local repo="$1" i name pattern hit path rc=0
  for i in "${!HOST_LITERAL_PATTERNS[@]}"; do
    name="${HOST_LITERAL_NAMES[$i]}"
    pattern="${HOST_LITERAL_PATTERNS[$i]}"
    while IFS= read -r hit; do
      [ -n "$hit" ] || continue
      path="${hit%%:*}"
      if literal_exempt "$name" "$path"; then continue; fi
      printf '%s %s\n' "$name" "$hit"
      rc=1
    done < <(git -C "$repo" grep -nIiE --untracked --exclude-standard -e "$pattern" -- . || true)
  done
  return "$rc"
}

plant_repo() {  # $1 = directory to create as a throwaway git repo
  mkdir -p "$1"
  git -C "$1" init -q
}

@test "the pattern arrays stay in step" {
  [ "${#HOST_LITERAL_NAMES[@]}" -eq "${#HOST_LITERAL_PATTERNS[@]}" ]
  [ "${#HOST_LITERAL_SAMPLES[@]}" -eq "${#HOST_LITERAL_PATTERNS[@]}" ]
  [ "${#HOST_LITERAL_ESCAPED_SAMPLES[@]}" -eq "${#HOST_LITERAL_ESCAPED_NAMES[@]}" ]
  [ "${#HOST_LITERAL_PATTERNS[@]}" -eq 6 ]
}

@test "no netcup host literal appears anywhere in the kernel tree" {
  run scan_literals "$KERNEL_ROOT"
  if [ "$status" -ne 0 ]; then
    printf 'host literal(s) found in the public kernel:\n%s\n' "$output" >&2
  fi
  [ "$status" -eq 0 ]
}

@test "the scan actually reaches this tree (vacuity canary)" {
  local n
  n="$(git -C "$KERNEL_ROOT" grep -lI --untracked --exclude-standard -e 'gremion' -- . | wc -l)"
  # Several hundred files carry the token. The floor is deliberately far below
  # that: it is here to catch a scan that reaches nothing, not to track the
  # tree's size.
  [ "$n" -ge 100 ]
}

@test "every pattern detects its own sample (no dead pattern)" {
  local tmp="$BATS_TEST_TMPDIR/samples" i
  plant_repo "$tmp"
  for i in "${!HOST_LITERAL_SAMPLES[@]}"; do
    printf 'sample: %s\n' "${HOST_LITERAL_SAMPLES[$i]}" > "$tmp/sample-$i.txt"
  done
  run scan_literals "$tmp"
  [ "$status" -eq 1 ]
  for i in "${!HOST_LITERAL_NAMES[@]}"; do
    [[ "$output" == *"${HOST_LITERAL_NAMES[$i]} sample-$i.txt:1:"* ]]
  done
}

@test "the separator patterns also detect the regexp-escaped spelling" {
  local tmp="$BATS_TEST_TMPDIR/escaped" i
  plant_repo "$tmp"
  for i in "${!HOST_LITERAL_ESCAPED_SAMPLES[@]}"; do
    printf 'rule: %s\n' "${HOST_LITERAL_ESCAPED_SAMPLES[$i]}" > "$tmp/escaped-$i.txt"
  done
  run scan_literals "$tmp"
  [ "$status" -eq 1 ]
  for i in "${!HOST_LITERAL_ESCAPED_NAMES[@]}"; do
    [[ "$output" == *"${HOST_LITERAL_ESCAPED_NAMES[$i]} escaped-$i.txt:1:"* ]]
  done
}

@test "the scan skips ignored paths -- the documented blind spot" {
  local tmp="$BATS_TEST_TMPDIR/ignored"
  plant_repo "$tmp"
  mkdir -p "$tmp/node_modules"
  printf 'node_modules/\n' > "$tmp/.gitignore"
  printf 'visible: %s\n' "${HOST_LITERAL_SAMPLES[3]}" > "$tmp/visible.txt"
  printf 'vendored: %s\n' "${HOST_LITERAL_SAMPLES[1]}" > "$tmp/node_modules/vendored.txt"
  run scan_literals "$tmp"
  [ "$status" -eq 1 ]
  [[ "$output" == *"visible.txt:1:"* ]]
  # Stated, not hidden: a literal inside an ignored path is invisible here.
  # That is correct -- an ignored path ships nowhere -- and it is written down
  # so nobody reads this guard as covering more than it does.
  [[ "$output" != *"node_modules"* ]]
}

@test "every exemption is still needed" {
  local entry name path i idx=-1 hits
  for entry in ${HOST_LITERAL_EXEMPTIONS[@]+"${HOST_LITERAL_EXEMPTIONS[@]}"}; do
    name="${entry%%|*}"
    path="${entry#*|}"
    idx=-1
    for i in "${!HOST_LITERAL_NAMES[@]}"; do
      if [ "${HOST_LITERAL_NAMES[$i]}" = "$name" ]; then idx="$i"; fi
    done
    if [ "$idx" -lt 0 ]; then
      echo "exemption names no known pattern: $entry" >&2
      false
    fi
    [ -f "$KERNEL_ROOT/$path" ] || { echo "exempted path is gone: $path" >&2; false; }
    hits="$(git -C "$KERNEL_ROOT" grep -cIiE --untracked --exclude-standard \
              -e "${HOST_LITERAL_PATTERNS[$idx]}" -- "$path" || true)"
    if [ -z "$hits" ] || [ "$hits" -eq 0 ]; then
      echo "exemption is spent -- $path no longer matches $name; delete the entry" >&2
      false
    fi
  done
}

# ---------------------------------------------------------------------------
# Coverage couplings. A guard nothing runs is not a guard; these four tests
# pin the four places where that could silently become true again.
# They read the Makefile and ci.yml as TEXT rather than running make: make is
# not reliably usable on the operator's Windows box (the ledger records why),
# and the question here is what the recipe COVERS, which is a property of its
# argument list.
# ---------------------------------------------------------------------------

recipe_body() {  # $1 = make target; prints its recipe lines
  awk -v t="$1:" '$0 ~ "^" t {f=1; next} f && /^[^\t]/ {exit} f' "$KERNEL_ROOT/Makefile"
}

# Every path the lint-sh recipe names, expanded against the tree.
#
# The WHOLE recipe body is tokenised rather than one command's argument list,
# because the host arms are a `for f in <globs>; do shellcheck "$f"; done` loop
# (a glob that matches nothing must not abort the lint before the ops/
# directory exists) and a parser tied to one command shape would report zero
# coverage the day the recipe is rewritten -- which is the vacuous-pass this
# whole file exists to prevent. Only tokens containing a `/` are considered, so
# shell keywords and option flags drop out and no bare `*` can ever be handed
# to the expansion. A token that is not a path expands to nothing.
lint_sh_files() {
  recipe_body lint-sh \
    | tr ' \t' '\n' \
    | sed 's/[";\\]//g' \
    | grep '/' \
    | grep -v '[$]' \
    | while IFS= read -r tok; do
        case "$tok" in
          -*) continue ;;
        esac
        # Deliberate globbing: this is the recipe's own path token being
        # expanded the way sh would expand it.
        # shellcheck disable=SC2086
        ( cd "$KERNEL_ROOT" && ls -1d $tok 2>/dev/null || true )
      done | sort -u
}

# Every bats file the test-unit recipe hands to the runner.
test_unit_files() {
  recipe_body test-unit \
    | sed -n 's/^[[:space:]]*@\{0,1\}\$(BATS)[[:space:]]//p' \
    | tr ' \t' '\n' | grep -v '^$' \
    | while IFS= read -r tok; do
        # shellcheck disable=SC2086
        ( cd "$KERNEL_ROOT" && ls -1d $tok 2>/dev/null || true )
      done | sort -u
}

# Every shell file of the host-tooling surface, tracked or merely present.
# .sh covers lib/, mail/ and ops/; the second alternative covers bin/, which
# is EXTENSIONLESS on purpose (those are commands on the host's PATH).
# test_helper/host.bash is deliberately out of scope -- see the residuals.
host_shell_files() {
  git -C "$KERNEL_ROOT" ls-files --cached --others --exclude-standard -- infra/host test/host \
    | grep -E '\.sh$|^infra/host/bin/gremion-' \
    | sort -u
}

@test "make lint-sh covers every shell file under infra/host and test/host" {
  local covered missing="" f
  covered="$(lint_sh_files)"
  [ -n "$covered" ]                       # the recipe parser found something
  [ -n "$(host_shell_files)" ]            # there ARE host shell files to cover
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    printf '%s\n' "$covered" | grep -qxF "$f" || missing="$missing $f"
  done < <(host_shell_files)
  if [ -n "$missing" ]; then
    echo "not covered by make lint-sh:$missing" >&2
  fi
  [ -z "$missing" ]
}

@test "make test-unit collects every test/host bats file" {
  local collected missing="" f
  collected="$(test_unit_files)"
  [ -n "$collected" ]
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    printf '%s\n' "$collected" | grep -qxF "$f" || missing="$missing $f"
  done < <(git -C "$KERNEL_ROOT" ls-files --cached --others --exclude-standard -- test/host \
             | grep -E '^test/host/[^/]+\.bats$' | sort -u)
  if [ -n "$missing" ]; then
    echo "not collected by make test-unit:$missing" >&2
  fi
  [ -z "$missing" ]
}

# `run <cmd>` plus an explicit status assertion rather than a bare `! <cmd>`:
# in bats a negated command only fails the test while it is the LAST command in
# the body, so a bare `!` assertion silently stops asserting the day a line is
# appended after it (shellcheck's SC2314). `run !` would fix that too but emits
# a BW02 warning unless the file declares bats_require_minimum_version, and a
# warning on every green run is noise nobody reads twice.
@test "ci.yml lints shell scripts through make lint-sh -- one home for the rule" {
  grep -q 'run: make lint-sh' "$KERNEL_ROOT/.github/workflows/ci.yml"
  run grep -qE '^[[:space:]]+shellcheck -x scripts/' "$KERNEL_ROOT/.github/workflows/ci.yml"
  [ "$status" -ne 0 ]
}

@test "ci.yml runs unit tests through make test-unit -- one home for the runner" {
  grep -q 'run: make test-unit' "$KERNEL_ROOT/.github/workflows/ci.yml"
  run grep -qE '^[[:space:]]+bats test/setup\.bats' "$KERNEL_ROOT/.github/workflows/ci.yml"
  [ "$status" -ne 0 ]
}

# The directive regex captures only the FIRST whitespace-delimited field after
# `source=`. That is a decision, not an accident: infra/host/bootstrap.sh
# carries the combined form `# shellcheck source=lib/common.sh disable=SC1091`
# on ONE line, which shellcheck accepts and which an anchored
# `source=[^[:space:]]+$` regex would reject. Loosening the regex here is the
# cheaper half of that trade than splitting a working directive in bootstrap.sh
# into two lines, so that file is correct as written and is NOT modified.
# `grep -oE` keeps the ^ anchor while returning only the matched span, so a
# `source=` that appears mid-line (in prose, in a heredoc) is not accepted.
#
# Scope is the SHELL files under infra/host, not every file under it:
# infra/host/README.md documents the convention in a fenced example, so a scan
# over all files would demand that the README's own snippet resolve from the
# README's directory -- a false positive on documentation. test/host/integration
# is linted by make lint-sh but is outside this rule -- stated in the residuals,
# not implied.
#
# The `checked` counter is lesson 2 again: a file list that silently became
# empty would make this test pass while proving nothing.
@test "every host script that sources common.sh tells shellcheck where it is" {
  local f rel dir missing="" checked=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    grep -qE '^\.[[:space:]]+"\$SCRIPT_DIR/[^"]*common\.sh"[[:space:]]*$' "$KERNEL_ROOT/$f" || continue
    checked=$((checked + 1))
    rel="$(grep -oE '^# shellcheck source=[^[:space:]]+' "$KERNEL_ROOT/$f" \
             | head -n1 | sed 's/^# shellcheck source=//')"
    dir="$(dirname "$KERNEL_ROOT/$f")"
    if [ -z "$rel" ] || [ ! -f "$dir/$rel" ]; then
      missing="$missing $f"
    fi
  done < <(host_shell_files | grep '^infra/host/')
  if [ -n "$missing" ]; then
    echo "no resolvable '# shellcheck source=' directive in:$missing" >&2
  fi
  [ -z "$missing" ]
  [ "$checked" -ge 10 ]
}

# ---------------------------------------------------------------------------
# Index hygiene for the host surface. Both of these are properties of what is
# COMMITTED, not of what is on disk, and both are invisible on the Windows box
# this tooling is written on: git there runs with core.fileMode=false (so a new
# program is recorded 100644 however it looks in `ls -l`) and core.autocrlf=true
# (so a CRLF file reads back as LF). A host program without its executable bit
# and a unit file with carriage returns both fail on the Debian host, at the
# far end of a deploy, for a reason nothing local reports.
#
# They live in this file rather than in scripts/kernel-hygiene-check.mjs for the
# same reason the literal list does: `make test-unit` needs only bash and bats.
# ---------------------------------------------------------------------------

# <path> -- a *.sh under infra/host that is NOT a program and must stay 0644.
#
# infra/host/lib/common.sh
#   A library, sourced through `. "$SCRIPT_DIR/../lib/common.sh"` and never
#   invoked. infra/host/bootstrap.sh installs bin/ with `install -m 0755` and
#   lib/ with `install -m 0644`, deliberately; marking it executable in the
#   index would contradict the mode it is deployed with. The test below fails
#   if it ever becomes 100755, so this entry cannot outlive its reason.
EXEC_BIT_EXEMPTIONS=(
  'infra/host/lib/common.sh'
)

exec_bit_exempt() {  # $1 = repo-relative path
  local path="$1" entry
  for entry in ${EXEC_BIT_EXEMPTIONS[@]+"${EXEC_BIT_EXEMPTIONS[@]}"}; do
    [ "$entry" = "$path" ] && return 0
  done
  return 1
}

@test "every host program is executable in the index" {
  local mode path bad="" spent="" n=0
  while read -r mode _ _ path; do
    [ -n "$path" ] || continue
    n=$((n + 1))
    if exec_bit_exempt "$path"; then
      [ "$mode" = "100755" ] && spent="$spent $path"
      continue
    fi
    [ "$mode" = "100755" ] || bad="$bad $path($mode)"
  done < <(git -C "$KERNEL_ROOT" ls-files -s -- infra/host test/host/integration \
             | grep -E '	infra/host/bin/|\.sh$')
  if [ -n "$bad" ]; then
    echo "not executable in the index -- run git update-index --chmod=+x:$bad" >&2
  fi
  if [ -n "$spent" ]; then
    echo "exec-bit exemption is spent (now 100755); delete the entry:$spent" >&2
  fi
  [ -z "$bad" ]
  [ -z "$spent" ]
  [ "$n" -ge 10 ]   # vacuity: the file list must not have silently emptied
}

@test "no file under infra/host or test/host carries CRLF in the index" {
  local eol path bad="" n=0
  while read -r eol _ _ path; do
    [ -n "$path" ] || continue
    n=$((n + 1))
    case "$eol" in
      i/lf|i/none|i/-text) ;;
      *) bad="$bad $path($eol)" ;;
    esac
  done < <(git -C "$KERNEL_ROOT" ls-files --eol -- infra/host test/host)
  if [ -n "$bad" ]; then
    echo "CRLF (or mixed) line endings in the index:$bad" >&2
    echo "add the extension to .gitattributes with 'text eol=lf' and re-add the file" >&2
  fi
  [ -z "$bad" ]
  [ "$n" -ge 30 ]   # vacuity: infra/host and test/host are not empty
}

# ---------------------------------------------------------------------------
# The local container runner, and the tools CI needs to actually RUN the suite
# rather than skip through it.
# ---------------------------------------------------------------------------

@test "make test-host-docker builds the runner image from the in-repo Dockerfile" {
  local body dockerfile="$KERNEL_ROOT/test/host/runner/Dockerfile"
  body="$(recipe_body test-host-docker)"
  [ -n "$body" ]
  [[ "$body" == *"docker build"* ]]
  [[ "$body" == *"test/host/runner"* ]]
  [ -f "$dockerfile" ]
  # Pinned, so the local runner and CI agree on the bats that interprets the
  # suite; unpinned, a runner image rebuilt months later is a different runtime.
  grep -q 'bats@1\.13\.0' "$dockerfile"
  grep -q '^ENTRYPOINT \["bats"\]' "$dockerfile"
  # The tools the suite's non-skipping assertions need. openssl, envsubst
  # (gettext-base) and jq are used by the render, secrets and release suites;
  # git is what this file's own scan runs on.
  #
  # Matched against the Dockerfile with its COMMENTS STRIPPED. The header above
  # each instruction names these same packages, so a grep over the whole file
  # would be satisfied by the prose that explains the install after the install
  # itself was deleted -- a guard matching its own comment, which is how this
  # class of check usually fails open. Proven: deleting a package from the RUN
  # line turns this test red.
  local pkg instructions
  instructions="$(grep -v '^[[:space:]]*#' "$dockerfile")"
  for pkg in shellcheck openssl gettext-base jq git; do
    printf '%s\n' "$instructions" | grep -q -- "$pkg" \
      || { echo "runner image lacks $pkg" >&2; false; }
  done
}

# Prints one job's block of ci.yml with COMMENT LINES REMOVED -- see the
# Dockerfile note above: the step's own comment names the tools it installs, so
# an uncommented match would survive the install being deleted.
ci_job_block() {  # $1 = job id
  awk -v j="^  $1:" '$0 ~ j {f=1} f && /^  [a-z]/ && $0 !~ j {exit} f' \
    "$KERNEL_ROOT/.github/workflows/ci.yml" \
    | grep -v '^[[:space:]]*#'
}

# test/host/deploy-workflow.bats asserts on deploy.yml's extracted shell blocks
# (shellcheck) and on its YAML (yamllint), and `skip`s when the tool is absent.
# Both of its skip messages say "CI installs it" -- which was true of the Lint
# job, which runs no bats, and false of the job that actually runs the suite. A
# guard that skips is a guard that passes, so this pins the install.
@test "the CI unit-test job installs what the host suites need to not skip" {
  local block
  block="$(ci_job_block unit-test)"
  [ -n "$block" ]
  [[ "$block" == *"Run unit tests"* ]]   # vacuity: this really is that job
  [[ "$block" == *"shellcheck"* ]]
  [[ "$block" == *"yamllint"* ]]
  [[ "$block" == *"gettext-base"* ]]
  [[ "$block" == *"bats"* ]]
}
