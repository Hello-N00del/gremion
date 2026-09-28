#!/usr/bin/env bats
# Drift guards for the four-procedure operations runbook, docs/ops/runbook/
# (TRD-200, PRD-PLAT-005; TASK-037).
#
# A runbook cannot be "run" by a test, so nothing notices when it rots. These
# tests are what notices. Every check is a function that takes RUNBOOK_DIR, a
# directory holding the six runbook files, so the same check runs against the
# real runbook AND against fixtures under test/host/fixtures/runbook/: the
# `valid` fixture must pass every check (the positive control), and each other
# fixture breaks exactly one rule and must fail exactly that check (every check
# watched RED). No check calls git.
#
# DEVIATION, on purpose (the same one go-live-gate.bats makes): this suite shims
# nothing, it reads text, so it loads the kernel helper test/test_helper/common
# for PROJECT_ROOT instead of test/host's docker/nft/ssh shims.
#
# RUNBOOK_TREE_ROOT may point the suite at a copy of the tree (a git archive
# under .scratch/), which is how the real-runbook guards are watched RED against
# a deliberately broken copy without editing the working tree. The fixtures are
# always read from this checkout.
#
# CR stripping: the tree is checked out with core.autocrlf=true on Windows, so
# docs/ops/**/*.md can arrive CRLF and every anchored pattern would then miss
# (measured in go-live-gate.bats: four tests failed for that reason alone). Each
# check therefore reads a CR-stripped copy under BATS_TEST_TMPDIR; the existence
# check always runs on the real path first, so a missing file fails loudly.
#
# Run: bats test/host/runbook.bats

load '../test_helper/common'

TREE_ROOT="${RUNBOOK_TREE_ROOT:-$PROJECT_ROOT}"
REAL_RUNBOOK="${TREE_ROOT}/docs/ops/runbook"
FIX="${PROJECT_ROOT}/test/host/fixtures/runbook"

RUNBOOK_FILES=(README install upgrade backup restore run-record)
PROCEDURE_FILES=(install upgrade backup restore)
# A procedure unit is what carries Preconditions / Steps / Post-condition once:
# each of install, upgrade and backup, and each of restore's three arms.
UNITS=(install upgrade backup restore-A restore-B restore-C)

# gremion-* names the runbook may use that are services, not host programs.
NON_BIN_NAMES='^(gremion-ui|gremion-ui-oss|gremion-public|gremion-public-oss|gremion-control|gremion-module-sdk)$'

# Top-level entries a backticked repository path may start with.
REPO_PATH_RE='^(infra|scripts|docs|compose|test|docker|packages|services|gremion-ui|gremion-public|k8s|modules|ops|contracts)/[A-Za-z0-9._/-]*$'

# The host layout (infra/host/README.md, docs/ops/host-tooling.md section 1).
HOST_LAYOUT_RE='^(bin|lib|etc|releases|current|backups|runtime|logs)$'

# A post-condition line that observes state rather than an exit code.
OBSERVE_RE='(docker (inspect|exec|ps|volume inspect|network inspect)|docker compose .*(ps|exec)|(^|[^a-z-])(curl|psql|jq|journalctl|grep|find|stat|openssl|sha256sum|kcadm\.sh)([^a-z-]|$)|systemctl (is-enabled|is-active|show)|(^|[^a-z])test -[a-z] )'

# The columns of DB-OPS-RUNBOOK-PROCEDURE-RUN (SCHEMA-gremion.md), brief Q7.
RUN_RECORD_COLUMNS=(procedure_kind scope customer_id performed_by_kind performed_by
                    non_vendor started_at finished_at wall_clock_minutes
                    post_condition_met published_ref)

# file|token pairs every procedure must carry (TDD 9).
REQUIRED_TOKENS=(
    'restore|TRD-174' 'restore|TRD-180' 'restore|gremion-restore-into'
    'restore|reboot-gate.log' 'restore|sign-in' 'restore|probe' 'restore|TASK-123'
    'install|TRD-042' 'install|TRD-004' 'install|TRD-340' 'install|volumes'
    'install|DNS' 'install|certificates' 'install|is-enabled gremion-backup.timer'
    'upgrade|TRD-206' 'upgrade|R18-4' 'upgrade|TRD-348' 'upgrade|TRD-189'
    'upgrade|## Known gaps'
    'backup|R15-1' 'backup|R18-4' 'backup|is-enabled'
)

# The one fixture per forbidden pattern (TDD 10), appended to a valid file.
FORBIDDEN_FIXTURES=(vendor-contact compose-f compose-profile compose-p down-v
                    prune address submodule)

# ---------------------------------------------------------------------------
# Dependencies the runbook legitimately cites that have NOT landed on this
# branch yet, as "<path>|<owning task>". A cited path in this list is exempt from
# the existence check; the expiry test at the bottom fails the moment a listed
# path DOES exist, naming the entry to delete. An allowlist that cannot outlive
# its reason is the only kind this file accepts (brief Q5: the owning task's own
# gate goes RED, and the orchestrator grants the line edit).
PENDING_PATHS=(
    'scripts/migrations/ranges.json|TASK-029'  # the migration register (upgrade.md)
    'scripts/migrations/runner/|TASK-075'      # the pre-migration dump (upgrade.md)
    'scripts/backup/|TASK-089'                 # the one-off verification (backup.md)
    'compose/observability/|TASK-039'          # the operator-only stack (install.md)
    'compose/README.md|TASK-040'               # the pooled compose layout (install.md)
    'packages/provisioning/|TASK-043'          # customer creation (install.md)
    'services/kernel-api/export/|TASK-119'     # tenant export (restore.md)
)
PENDING_BINS=()
PENDING_ARTEFACTS=()

# ---------------------------------------------------------------------------
# Text plumbing

norm_copy() {                                    # <src dir> <dst dir>
    local f
    mkdir -p "$2"
    for f in "$1"/*.md; do
        [ -f "$f" ] || continue
        tr -d '\r' < "$f" > "$2/$(basename "$f")"
    done
}

# The real runbook, existence-checked on the real path, CR-stripped into tmp.
real_dir() {
    local f d="${BATS_TEST_TMPDIR}/real"
    for f in "${RUNBOOK_FILES[@]}"; do
        if [ ! -f "${REAL_RUNBOOK}/${f}.md" ]; then
            echo "runbook file missing: docs/ops/runbook/${f}.md" >&2
            return 1
        fi
    done
    norm_copy "$REAL_RUNBOOK" "$d"
    printf '%s' "$d"
}

# valid/ overlaid with test/host/fixtures/runbook/<case>/ (the files it breaks).
fixture() {                                      # <case>
    local d="${BATS_TEST_TMPDIR}/fx-$1"
    [ -d "${FIX}/valid" ] || { echo "fixture missing: valid" >&2; return 1; }
    norm_copy "${FIX}/valid" "$d"
    if [ "$1" != valid ]; then
        [ -d "${FIX}/$1" ] || { echo "fixture missing: $1" >&2; return 1; }
        norm_copy "${FIX}/$1" "$d"
    fi
    printf '%s' "$d"
}

# valid/ with one snippet file appended to one runbook file.
fixture_snippet() {                              # <snippet path> <target file stem>
    local d="${BATS_TEST_TMPDIR}/fs-$(basename "$1" .md)-$2"
    [ -f "$1" ] || { echo "fixture snippet missing: $1" >&2; return 1; }
    norm_copy "${FIX}/valid" "$d"
    tr -d '\r' < "$1" >> "$d/$2.md"
    printf '%s' "$d"
}

file_of() { case "$1" in restore-*) echo restore ;; *) echo "$1" ;; esac; }
level_of() { case "$1" in restore-*) echo '###' ;; *) echo '##' ;; esac; }

unit_text() {                                    # <dir> <unit>
    case "$2" in
        restore-?)
            awk -v a="${2#restore-}" '
                /^[[:space:]]*```/ { f = !f }
                !f && /^## / { inb = ($0 ~ ("^## Arm " a "([^A-Za-z]|$)")); next }
                inb { print }' "$1/restore.md" ;;
        *) cat "$1/$2.md" ;;
    esac
}

# Lines exactly equal to <heading>, outside fenced blocks (a bash comment is not
# a heading).
count_heading() {                                # <heading>  (stdin)
    awk -v t="$1" 'BEGIN { c = 0 } /^[[:space:]]*```/ { f = !f; next } !f && $0 == t { c++ } END { print c }'
}

# Body of <heading> up to the next heading of the same or a higher level.
section_body() {                                 # <heading>  (stdin)
    awk -v t="$1" '
        function lvl(s) { match(s, /^#+/); return RLENGTH }
        BEGIN { tl = lvl(t) }
        /^[[:space:]]*```/ { if (inb) print; f = !f; next }
        !f && /^#+ / { if (inb && lvl($0) <= tl) inb = 0
                       if ($0 == t) { inb = 1; next } }
        inb { print }'
}

# One line per step: "<number> <bash|-> <manual|->".
steps_of() {                                     # <dir> <unit>
    unit_text "$1" "$2" | section_body "$(level_of "$2") Steps" | awk '
        /^[[:space:]]*```/ { if (!f && n && $0 ~ /^[[:space:]]*```bash[[:space:]]*$/) bash[n] = 1
                             f = !f; next }
        f { next }
        /^[0-9]+\. / { n++; v = $0; sub(/\..*/, "", v); num[n] = v
                       if ($0 ~ /MANUAL:/) man[n] = 1; next }
        n && /MANUAL:/ { man[n] = 1 }
        END { for (i = 1; i <= n; i++)
                  printf "%s %s %s\n", num[i], (bash[i] ? "bash" : "-"), (man[i] ? "manual" : "-") }'
}

# Every fenced bash block of stdin, each preceded by a __BLOCK__ line, with
# backslash continuations joined into one line.
bash_blocks() {
    awk '
        /^[[:space:]]*```/ {
            if (inb) { if (acc != "") print acc; acc = ""; inb = 0 }
            else if ($0 ~ /^[[:space:]]*```bash[[:space:]]*$/) { inb = 1; print "__BLOCK__" }
            else { other = !other }
            next
        }
        inb { line = $0
              if (line ~ /\\$/) { sub(/\\$/, "", line); acc = acc line; next }
              print acc line; acc = "" }'
}

postcondition_blocks() {                         # <dir> <unit>
    unit_text "$1" "$2" | section_body "$(level_of "$2") Post-condition" | bash_blocks
}

is_observation() {                               # <line>
    local l="$1"
    [[ "$l" =~ ^[[:space:]]*# ]] && return 1
    grep -qE -- "$OBSERVE_RE" <<<"$l"
}

all_text() { local f; for f in "${RUNBOOK_FILES[@]}"; do cat "$1/$f.md"; done; }

pending_path_hit() {                             # <repo path>
    local e p
    for e in "${PENDING_PATHS[@]}"; do
        p="${e%%|*}"
        [ "$1" = "$p" ] || [ "${1%/}" = "${p%/}" ] || [[ "$1" == "${p%/}/"* ]] && return 0
    done
    return 1
}

in_list() {                                      # <needle> <item>...
    local n="$1" i; shift
    for i in "$@"; do [ "$i" = "$n" ] && return 0; done
    return 1
}

# ---------------------------------------------------------------------------
# Checks. Each takes RUNBOOK_DIR, prints what is wrong to stderr, returns 1.

check_files() {
    local f bad=0
    for f in "${RUNBOOK_FILES[@]}"; do
        [ -s "$1/$f.md" ] || { echo "missing or empty: $f.md" >&2; bad=1; }
    done
    return "$bad"
}

check_version() {
    local f v n bad=0
    for f in "${PROCEDURE_FILES[@]}"; do
        n="$(grep -cE '^(- )?Version: [0-9]+\.[0-9]+\.[0-9]+$' "$1/$f.md" || true)"
        if [ "$n" != 1 ]; then echo "$f.md: ${n} 'Version: X.Y.Z' lines, expected 1" >&2; bad=1; continue; fi
        v="$(sed -nE 's/^(- )?Version: ([0-9]+\.[0-9]+\.[0-9]+)$/\2/p' "$1/$f.md")"
        n="$(count_heading '## Changelog' < "$1/$f.md")"
        if [ "$n" != 1 ]; then echo "$f.md: ${n} '## Changelog' headings, expected 1" >&2; bad=1; continue; fi
        if ! section_body '## Changelog' < "$1/$f.md" | awk -v v="$v" 'index($0, "- " v " ") == 1 || $0 == "- " v { h = 1 } END { exit !h }'; then
            echo "$f.md: Version ${v} has no '- ${v} ...' entry under ## Changelog" >&2; bad=1
        fi
    done
    for f in "${UNITS[@]}"; do
        if ! unit_text "$1" "$f" | grep -qE '^(- )?Wall-clock budget: .+'; then
            echo "${f}: no 'Wall-clock budget:' line (PRD-PLAT-005)" >&2; bad=1
        fi
    done
    return "$bad"
}

check_sections() {
    local u h n bad=0 a
    for a in A B C; do
        n="$(awk -v a="$a" '/^[[:space:]]*```/ { f = !f; next } !f && $0 ~ ("^## Arm " a "([^A-Za-z]|$)") { c++ } END { print c + 0 }' "$1/restore.md")"
        [ "$n" = 1 ] || { echo "restore.md: ${n} '## Arm ${a}' headings, expected 1" >&2; bad=1; }
    done
    for u in "${UNITS[@]}"; do
        for h in Preconditions Steps Post-condition; do
            n="$(unit_text "$1" "$u" | count_heading "$(level_of "$u") ${h}")"
            [ "$n" = 1 ] || { echo "${u}: ${n} '$(level_of "$u") ${h}' headings, expected 1" >&2; bad=1; }
        done
    done
    return "$bad"
}

check_steps() {
    local u line num kind man want bad=0
    for u in "${UNITS[@]}"; do
        want=1
        while read -r num kind man; do
            [ -n "$num" ] || continue
            [ "$num" = "$want" ] || { echo "${u}: step ${num} where step ${want} was expected (number steps 1..n)" >&2; bad=1; }
            want=$((num + 1))
            if [ "$kind" != bash ] && [ "$man" != manual ]; then
                echo "${u}: step ${num} has neither a fenced bash block nor a MANUAL: marker" >&2; bad=1
            fi
        done < <(steps_of "$1" "$u")
    done
    return "$bad"
}

manual_keys_extracted() {
    local u num kind man key
    for u in "${UNITS[@]}"; do
        case "$u" in restore-?) key="restore.md arm ${u#restore-}" ;; *) key="${u}.md" ;; esac
        while read -r num kind man; do
            [ "$man" = manual ] && printf '%s step %s\n' "$key" "$num"
        done < <(steps_of "$1" "$u")
    done | sort -u
}

manual_keys_listed() {
    section_body '## Manual steps' < "$1/README.md" \
        | sed -nE 's/^- `([a-z-]+\.md)`( arm ([ABC]))? step ([0-9]+)([^0-9].*)?$/\1\2 step \4/p' | sort -u
}

check_manual_list() {
    local ext lst
    ext="$(manual_keys_extracted "$1")"
    lst="$(manual_keys_listed "$1")"
    if [ -z "$ext" ]; then
        echo "no MANUAL: step extracted at all; the extractor or the runbook is broken" >&2; return 1
    fi
    if [ "$ext" != "$lst" ]; then
        echo "README.md '## Manual steps' does not list exactly the MANUAL: steps." >&2
        echo "extracted:" >&2; printf '  %s\n' "$ext" >&2
        echo "listed:" >&2; printf '  %s\n' "${lst:-<none>}" >&2
        return 1
    fi
}

check_operator_phrase() {
    local all arm
    all="$(all_text "$1" | grep -ciF 'performed by the operator' || true)"
    arm="$(unit_text "$1" restore-A | grep -ciF 'performed by the operator' || true)"
    if [ "${arm:-0}" -lt 1 ]; then
        echo "restore arm A does not say it is performed by the operator (R21-26)" >&2; return 1
    fi
    if [ "${all:-0}" != "${arm:-0}" ]; then
        echo "'performed by the operator' appears outside restore arm A; only arm A is the operator's (R21-26)" >&2; return 1
    fi
}

check_commands() {
    local name missing=()
    while read -r name; do
        [[ "$name" =~ $NON_BIN_NAMES ]] && continue
        in_list "$name" ${PENDING_BINS[@]+"${PENDING_BINS[@]}"} && continue
        [ -f "${TREE_ROOT}/infra/host/bin/${name}" ] || missing+=("$name")
    done < <(all_text "$1" | grep -oE 'gremion-[a-z0-9-]+' | sort -u)
    if [ "${#missing[@]}" -ne 0 ]; then
        echo "runbook names commands with no file in infra/host/bin: ${missing[*]}" >&2; return 1
    fi
}

check_repo_paths() {
    local tok missing=() seen=0
    while read -r tok; do
        tok="$(sed -E 's/:[0-9]+(-[0-9]+)?$//' <<<"$tok")"
        [[ "$tok" == *'*'* ]] && continue
        [[ "$tok" =~ $REPO_PATH_RE ]] || continue
        seen=$((seen + 1))
        pending_path_hit "$tok" && continue
        [ -e "${TREE_ROOT}/${tok%/}" ] || missing+=("$tok")
    done < <(all_text "$1" | grep -oE '`[^`]+`' | tr -d '`' | tr ' \t' '\n\n' | sed '/^$/d' | sort -u)
    [ "$seen" -gt 0 ] || { echo "no repository path extracted at all; the extractor is reading nothing" >&2; return 1; }
    if [ "${#missing[@]}" -ne 0 ]; then
        echo "runbook cites repository paths that do not exist and are not PENDING: ${missing[*]}" >&2; return 1
    fi
}

check_host_paths() {
    local p rel first rest missing=() seen=0
    while read -r p; do
        rel="${p#/opt/gremion}"; rel="${rel#/}"; rel="${rel%/}"
        seen=$((seen + 1))
        [ -n "$rel" ] || continue
        first="${rel%%/*}"
        [ "$first" = "$rel" ] && rest="" || rest="${rel#*/}"
        if ! [[ "$first" =~ $HOST_LAYOUT_RE ]]; then missing+=("$p"); continue; fi
        case "$first" in
            bin)  [ -z "$rest" ] || [ -f "${TREE_ROOT}/infra/host/bin/${rest}" ] \
                    || in_list "$rest" ${PENDING_BINS[@]+"${PENDING_BINS[@]}"} || missing+=("$p") ;;
            lib)  [ -z "$rest" ] || [ -f "${TREE_ROOT}/infra/host/lib/${rest}" ] || missing+=("$p") ;;
            current)
                  [ -z "$rest" ] || [ -e "${TREE_ROOT}/${rest}" ] || pending_path_hit "$rest" || missing+=("$p") ;;
            releases)
                  rest="${rest#*/}"
                  [[ "$rel" != releases/*/* ]] || [ -e "${TREE_ROOT}/${rest}" ] || pending_path_hit "$rest" || missing+=("$p") ;;
            runtime|logs) : ;;              # check_artefacts owns these
            *)    [ -z "$rest" ] || grep -rqF -- "$rel" "${TREE_ROOT}/infra/host" || missing+=("$p") ;;
        esac
    done < <(all_text "$1" | grep -oE '/opt/gremion(/[A-Za-z0-9._-]+)*/?' | sort -u)
    [ "$seen" -gt 0 ] || { echo "no /opt/gremion path extracted at all; the extractor is reading nothing" >&2; return 1; }
    if [ "${#missing[@]}" -ne 0 ]; then
        echo "runbook cites host paths outside the host layout or unknown to infra/host: ${missing[*]}" >&2; return 1
    fi
}

check_links() {                                  # <text dir> <base dir>
    local f target missing=()
    for f in "${RUNBOOK_FILES[@]}"; do
        while read -r target; do
            [ -n "$target" ] || continue
            case "$target" in http://*|https://*|mailto:*|'#'*) continue ;; esac
            target="${target%%#*}"
            [ -e "$2/$target" ] || missing+=("$f.md -> $target")
        done < <(grep -oE '\]\([^)[:space:]]+\)' "$1/$f.md" | sed -E 's/^\]\((.*)\)$/\1/')
    done
    if [ "${#missing[@]}" -ne 0 ]; then
        echo "runbook links to files that do not exist: ${missing[*]}" >&2; return 1
    fi
}

check_postconditions() {
    local u line blocks=0 obs=0 bad=0 cur_obs=0 inblk=0
    for u in "${UNITS[@]}"; do
        blocks=0; obs=0; inblk=0
        while IFS= read -r line; do
            if [ "$line" = __BLOCK__ ]; then
                if [ "$inblk" = 1 ] && [ "$cur_obs" = 0 ]; then
                    echo "${u}: a Post-condition block observes nothing (exit code only)" >&2; bad=1
                fi
                inblk=1; cur_obs=0; blocks=$((blocks + 1)); continue
            fi
            if [[ "$line" == *'$?'* ]]; then
                echo "${u}: a Post-condition reads an exit code (\$?): ${line}" >&2; bad=1
            fi
            if is_observation "$line"; then cur_obs=1; obs=$((obs + 1)); fi
        done < <(postcondition_blocks "$1" "$u")
        if [ "$inblk" = 1 ] && [ "$cur_obs" = 0 ]; then
            echo "${u}: a Post-condition block observes nothing (exit code only)" >&2; bad=1
        fi
        [ "$blocks" -gt 0 ] || { echo "${u}: Post-condition has no fenced bash block" >&2; bad=1; }
    done
    return "$bad"
}

check_required() {
    local e f t bad=0
    for e in "${REQUIRED_TOKENS[@]}"; do
        f="${e%%|*}"; t="${e#*|}"
        grep -qF -- "$t" "$1/$f.md" || { echo "$f.md does not carry '${t}'" >&2; bad=1; }
    done
    return "$bad"
}

check_forbidden() {
    local text hit bad=0
    text="$(all_text "$1")"
    hit="$(grep -niE 'contact (the )?(vendor|Gremion|operator|support)|ask (the )?(vendor|operator)|open a (support )?ticket' <<<"$text" || true)"
    [ -z "$hit" ] || { echo "vendor contact (TRD-200: a step needing vendor contact fails): ${hit}" >&2; bad=1; }
    hit="$(grep -nE 'docker compose[^|#]*( -f | --profile | -p )' <<<"$text" || true)"
    [ -z "$hit" ] || { echo "forbidden compose flag (only --env-file): ${hit}" >&2; bad=1; }
    hit="$(grep -nE 'down (-v|--volumes)' <<<"$text" || true)"
    [ -z "$hit" ] || { echo "a volume-removing down: ${hit}" >&2; bad=1; }
    hit="$(grep -nwE 'prune' <<<"$text" || true)"
    [ -z "$hit" ] || { echo "a prune: ${hit}" >&2; bad=1; }
    hit="$(grep -nF 'git submodule update' <<<"$text" || true)"
    [ -z "$hit" ] || { echo "git submodule update (a5): ${hit}" >&2; bad=1; }
    hit="$(grep -oE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' <<<"$text" | sort -u \
           | grep -vE '^(203\.0\.113\.[0-9]+|198\.51\.100\.[0-9]+|192\.0\.2\.[0-9]+|127\.0\.0\.1|0\.0\.0\.0)$' || true)"
    [ -z "$hit" ] || { echo "non-documentation address: ${hit}" >&2; bad=1; }
    return "$bad"
}

# A restore-into target is never the production stack and never etc/: arm A is
# the one sanctioned same-host restore.
check_restore_target() {
    local line v seen=0 bad=0
    while IFS= read -r line; do
        [ "$line" = __BLOCK__ ] && continue
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ "$line" == *gremion-restore-into* ]] || continue
        seen=$((seen + 1))
        if ! [[ "$line" =~ --stack[[:space:]]+([^[:space:]]+) ]]; then
            echo "gremion-restore-into without --stack: ${line}" >&2; bad=1; continue
        fi
        v="${BASH_REMATCH[1]//\"/}"
        case "$v" in
            gremion|'$STACK'|'${STACK}'|'$GREMION_PRODUCTION_STACK'|'${GREMION_PRODUCTION_STACK}')
                echo "gremion-restore-into targets the production stack (${v}): ${line}" >&2; bad=1 ;;
        esac
        if [[ "$line" == *'--root /opt/gremion/etc'* ]]; then
            echo "gremion-restore-into targets etc/: ${line}" >&2; bad=1
        fi
    done < <(all_text "$1" | bash_blocks)
    [ "$seen" -gt 0 ] || { echo "no gremion-restore-into invocation found in any bash block" >&2; return 1; }
    return "$bad"
}

check_install_tail() {
    local last post
    last="$(unit_text "$1" install | section_body '## Steps' | awk '
        /^[[:space:]]*```/ { f = !f }
        !f && /^[0-9]+\. / { buf = "" }
        { buf = buf $0 "\n" }
        END { printf "%s", buf }')"
    if ! grep -qF 'systemctl disable --now gremion-backup.timer' <<<"$last"; then
        echo "install.md's last step is not 'systemctl disable --now gremion-backup.timer' (R15-1)" >&2; return 1
    fi
    post="$(unit_text "$1" install | section_body '## Post-condition')"
    local want
    for want in 'systemctl is-enabled gremion-backup.timer' 'systemctl is-active gremion-backup.timer' 'disabled' 'inactive'; do
        grep -qF -- "$want" <<<"$post" || { echo "install.md Post-condition lacks '${want}'" >&2; return 1; }
    done
}

# The Known gap stays true only while bootstrap.sh still enables the timer.
check_timer_gap() {                              # <dir> <bootstrap.sh>
    local gap
    gap="$(section_body '## Known gaps' < "$1/install.md")"
    local want
    for want in stage_timers TASK-040 'enable --now'; do
        grep -qF -- "$want" <<<"$gap" || { echo "install.md '## Known gaps' lacks '${want}'" >&2; return 1; }
    done
    if ! tr -d '\r' < "$2" | grep -qF 'systemctl enable --now gremion-backup.timer'; then
        echo "bootstrap.sh no longer runs 'systemctl enable --now gremion-backup.timer': the gap is closed." >&2
        echo "Rewrite install.md's last step and delete its '## Known gaps' timer entry." >&2
        return 1
    fi
}

check_run_record() {
    local c bad=0
    for c in "${RUN_RECORD_COLUMNS[@]}"; do
        grep -qE "^\| \`${c}\` \|" "$1/run-record.md" || { echo "run-record.md does not name column '${c}'" >&2; bad=1; }
    done
    return "$bad"
}

check_floor() {
    local u steps obs line bad=0
    for u in "${UNITS[@]}"; do
        steps="$(steps_of "$1" "$u" | grep -c . || true)"
        obs=0
        while IFS= read -r line; do
            [ "$line" = __BLOCK__ ] && continue
            is_observation "$line" && obs=$((obs + 1))
        done < <(postcondition_blocks "$1" "$u")
        [ "${steps:-0}" -ge 1 ] || { echo "${u}: the step extractor found no step" >&2; bad=1; }
        [ "$obs" -ge 1 ] || { echo "${u}: the extractor found no post-condition observation" >&2; bad=1; }
    done
    return "$bad"
}

check_artefacts() {
    local art missing=()
    while read -r art; do
        in_list "$art" ${PENDING_ARTEFACTS[@]+"${PENDING_ARTEFACTS[@]}"} && continue
        grep -rqF -- "$art" "${TREE_ROOT}/infra/host" && continue
        grep -rqF -- "${art#*/}" "${TREE_ROOT}/infra/host" && continue
        missing+=("$art")
    done < <(all_text "$1" | grep -oE '(runtime|logs)/[a-z0-9.-]*[a-z0-9]' | sort -u)
    if [ "${#missing[@]}" -ne 0 ]; then
        echo "runbook cites host artefacts nothing under infra/host writes: ${missing[*]}" >&2; return 1
    fi
}

# A deploy.log line is written only by gremion-deploy's log_step, which prepends
# an ISO-8601 timestamp; the fixture log is produced by running that function.
real_deploy_log() {                              # <path to write>
    local body
    body="$(awk '/^log_step\(\) \{/ { inb = 1 }
                 inb            { print }
                 inb && /^\}/   { exit }' "${TREE_ROOT}/infra/host/bin/gremion-deploy")"
    [ -n "$body" ] || return 1
    # shellcheck disable=SC2034  # read by the eval'd log_step body
    ( DEPLOY_LOG=""; eval "$body"; log_step 3 space-and-pull ok; log_step 7 migrate fail ) > "$1"
}

check_deploy_log() {
    local fixture="${BATS_TEST_TMPDIR}/deploy.log" re pats=() dead=() sees_fail=0 fail_line
    real_deploy_log "$fixture" || { echo "could not lift log_step out of gremion-deploy" >&2; return 1; }
    [ "$(wc -l < "$fixture")" -eq 2 ] || { echo "log_step fixture is not two lines" >&2; return 1; }
    fail_line="$(sed -n 2p "$fixture")"
    while IFS= read -r re; do
        [ -n "$re" ] && pats+=("$re")
    done < <(grep -F 'deploy.log' "$1/upgrade.md" | grep -F 'grep' \
               | sed -nE -e "s/.*grep[^']*'([^']*)'.*/\1/p" -e 's/.*grep[^"]*"([^"]*)".*/\1/p')
    [ "${#pats[@]}" -ge 2 ] || { echo "found ${#pats[@]} deploy.log grep pattern(s) in upgrade.md, expected an ok-count and a fail-count" >&2; return 1; }
    for re in "${pats[@]}"; do
        grep -qE -- "$re" "$fixture" || dead+=("$re")
        grep -qE -- "$re" <<<"$fail_line" && sees_fail=1
    done
    [ "${#dead[@]}" -eq 0 ] || { echo "deploy.log pattern(s) no real log line matches: ${dead[*]}" >&2; return 1; }
    [ "$sees_fail" -eq 1 ] || { echo "no deploy.log pattern matches a FAILED step" >&2; return 1; }
}

check_reboot_gate() {
    local lits pats=() re hit=0 dead=()
    lits="$(grep -oE 'echo "REBOOT-GATE: [^"]*"' "${TREE_ROOT}/infra/host/bin/gremion-verify" \
            | sed -E 's/^echo "//; s/"$//')"
    [ -n "$lits" ] || { echo "no REBOOT-GATE: line could be lifted out of gremion-verify" >&2; return 1; }
    while IFS= read -r re; do
        [ -n "$re" ] && pats+=("$re")
    done < <(grep -F 'reboot-gate.log' "$1/restore.md" | grep -F 'grep' \
               | sed -nE -e "s/.*grep[^']*'([^']*)'.*/\1/p" -e 's/.*grep[^"]*"([^"]*)".*/\1/p')
    [ "${#pats[@]}" -ge 1 ] || { echo "restore.md greps reboot-gate.log with no pattern" >&2; return 1; }
    for re in "${pats[@]}"; do
        if grep -qE -- "$re" <<<"$lits"; then
            grep -E -- "$re" <<<"$lits" | grep -qF 'verify=pass' && hit=1
        else
            dead+=("$re")
        fi
    done
    [ "${#dead[@]}" -eq 0 ] || { echo "reboot-gate.log pattern(s) gremion-verify never prints: ${dead[*]}" >&2; return 1; }
    [ "$hit" -eq 1 ] || { echo "no reboot-gate.log pattern selects a verify=pass line" >&2; return 1; }
}

check_pending_cited() {
    local e p t bad=0 text
    text="$(all_text "$1")"
    for e in "${PENDING_PATHS[@]}"; do
        p="${e%%|*}"; t="${e#*|}"
        [[ "$t" =~ ^TASK-[0-9]{3}$ ]] || { echo "PENDING entry '${e}' names no owning task" >&2; bad=1; continue; }
        if ! grep -F -- "$p" <<<"$text" | grep -F -- "$t" | grep -qF 'PENDING'; then
            echo "PENDING entry '${e}' is not cited as 'PENDING ${t}' next to ${p} in the runbook" >&2; bad=1
        fi
    done
    return "$bad"
}

pending_landed() {                               # <tree root>
    local e p landed=()
    for e in "${PENDING_PATHS[@]}"; do
        p="${e%%|*}"
        [ -e "$1/${p%/}" ] && landed+=("PENDING_PATHS entry '${e}' -- ${p} now exists")
    done
    for p in ${PENDING_BINS[@]+"${PENDING_BINS[@]}"}; do
        [ -f "$1/infra/host/bin/$p" ] && landed+=("PENDING_BINS entry '${p}' -- infra/host/bin/${p} now exists")
    done
    for p in ${PENDING_ARTEFACTS[@]+"${PENDING_ARTEFACTS[@]}"}; do
        grep -rqF -- "$p" "$1/infra/host" && landed+=("PENDING_ARTEFACTS entry '${p}' -- infra/host writes it now")
    done
    if [ "${#landed[@]}" -ne 0 ]; then
        printf 'delete this entry from test/host/runbook.bats and rewrite its PENDING citation: %s\n' "${landed[@]}" >&2
        return 1
    fi
}

ALL_CHECKS=(check_files check_version check_sections check_steps check_manual_list
            check_operator_phrase check_commands check_repo_paths check_host_paths
            check_postconditions check_required check_forbidden check_restore_target
            check_install_tail check_run_record check_floor check_artefacts
            check_deploy_log check_reboot_gate)

# ---------------------------------------------------------------------------

@test "the runbook directory holds its six files" {
    d="$(real_dir)"
    check_files "$d"
}

@test "PROJECT_ROOT is exported by the kernel test helper" {
    [ -n "${PROJECT_ROOT:-}" ]
    [ -d "${PROJECT_ROOT}/infra/host/bin" ]
    [ -d "${FIX}/valid" ]
}

@test "every procedure carries a Version, its Changelog entry and a wall-clock budget" {
    d="$(real_dir)"; check_version "$d"
    d="$(fixture valid)"; check_version "$d"
    d="$(fixture no-version)"
    run check_version "$d"
    [ "$status" -ne 0 ]
    [[ "$output" == *"install.md: 0 'Version: X.Y.Z' lines"* ]]
}

@test "each procedure and each restore arm has Preconditions, Steps and Post-condition exactly once" {
    d="$(real_dir)"; check_sections "$d"
    d="$(fixture valid)"; check_sections "$d"
    d="$(fixture missing-postcondition)"
    run check_sections "$d"
    [ "$status" -ne 0 ]; [[ "$output" == *"install: 0 '## Post-condition' headings"* ]]
    d="$(fixture dup-steps)"
    run check_sections "$d"
    [ "$status" -ne 0 ]; [[ "$output" == *"install: 2 '## Steps' headings"* ]]
    d="$(fixture no-arm-c)"
    run check_sections "$d"
    [ "$status" -ne 0 ]; [[ "$output" == *"restore.md: 0 '## Arm C' headings"* ]]
}

@test "every step is numbered and carries a fenced bash block or a MANUAL: marker" {
    d="$(real_dir)"; check_steps "$d"
    d="$(fixture valid)"; check_steps "$d"
    d="$(fixture bare-step)"
    run check_steps "$d"
    [ "$status" -ne 0 ]; [[ "$output" == *"install: step 2 has neither"* ]]
}

@test "README lists exactly the MANUAL: steps" {
    d="$(real_dir)"; check_manual_list "$d"
    d="$(fixture valid)"; check_manual_list "$d"
    d="$(fixture readme-unlisted)"
    run check_manual_list "$d"
    [ "$status" -ne 0 ]; [[ "$output" == *"does not list exactly the MANUAL: steps"* ]]
}

@test "only restore arm A is performed by the operator (R21-26)" {
    d="$(real_dir)"; check_operator_phrase "$d"
    d="$(fixture valid)"; check_operator_phrase "$d"
    d="$(fixture_snippet "${FIX}/snippets/operator-outside-arm-a.md" install)"
    run check_operator_phrase "$d"
    [ "$status" -ne 0 ]; [[ "$output" == *"appears outside restore arm A"* ]]
}

@test "every gremion-* command the runbook names has a file in infra/host/bin" {
    d="$(real_dir)"; check_commands "$d"
    d="$(fixture valid)"; check_commands "$d"
    d="$(fixture gremion-bakup)"
    run check_commands "$d"
    [ "$status" -ne 0 ]; [[ "$output" == *"gremion-bakup"* ]]
}

@test "every repository path the runbook cites exists or is PENDING" {
    d="$(real_dir)"; check_repo_paths "$d"
    d="$(fixture valid)"; check_repo_paths "$d"
    d="$(fixture bad-path)"
    run check_repo_paths "$d"
    [ "$status" -ne 0 ]; [[ "$output" == *"scripts/no-such-helper.mjs"* ]]
}

@test "every /opt/gremion path the runbook cites is in the host layout" {
    d="$(real_dir)"; check_host_paths "$d"
    d="$(fixture valid)"; check_host_paths "$d"
    d="$(fixture_snippet "${FIX}/snippets/bad-host-path.md" backup)"
    run check_host_paths "$d"
    [ "$status" -ne 0 ]; [[ "$output" == *"/opt/gremion/etc/no-such-file.env"* ]]
}

@test "every relative link in the runbook resolves" {
    d="$(real_dir)"; check_links "$d" "$REAL_RUNBOOK"
    d="$(fixture valid)"; check_links "$d" "$d"
    d="$(fixture_snippet "${FIX}/snippets/broken-link.md" README)"
    run check_links "$d" "$d"
    [ "$status" -ne 0 ]; [[ "$output" == *"no-such-procedure.md"* ]]
}

@test "every post-condition observes state, never an exit code alone" {
    d="$(real_dir)"; check_postconditions "$d"
    d="$(fixture valid)"; check_postconditions "$d"
    d="$(fixture exit-code-only)"
    run check_postconditions "$d"
    [ "$status" -ne 0 ]; [[ "$output" == *"upgrade: a Post-condition"* ]]
}

@test "every procedure carries its required tokens, and each stripped token goes RED" {
    d="$(real_dir)"; check_required "$d"
    d="$(fixture valid)"; check_required "$d"
    local e f t s n=0
    for e in "${REQUIRED_TOKENS[@]}"; do
        f="${e%%|*}"; t="${e#*|}"
        s="${BATS_TEST_TMPDIR}/strip-${n}"; n=$((n + 1))
        norm_copy "${FIX}/valid" "$s"
        awk -v t="$t" '{ while ((i = index($0, t)) > 0) $0 = substr($0, 1, i - 1) substr($0, i + length(t)); print }' \
            "$s/$f.md" > "$s/$f.tmp" && mv "$s/$f.tmp" "$s/$f.md"
        run check_required "$s"
        if [ "$status" -eq 0 ] || [[ "$output" != *"$f.md does not carry '${t}'"* ]]; then
            echo "stripping '${t}' from ${f}.md did not turn the check RED: ${output}" >&2
            return 1
        fi
    done
    [ "$n" -eq "${#REQUIRED_TOKENS[@]}" ]
}

@test "no vendor contact, forbidden compose flag, volume removal, prune, real address or submodule update" {
    d="$(real_dir)"; check_forbidden "$d"
    d="$(fixture valid)"; check_forbidden "$d"
    local c
    for c in "${FORBIDDEN_FIXTURES[@]}"; do
        d="$(fixture_snippet "${FIX}/forbidden/${c}.md" backup)"
        run check_forbidden "$d"
        if [ "$status" -eq 0 ]; then
            echo "forbidden fixture '${c}' passed the check" >&2
            return 1
        fi
    done
}

@test "gremion-restore-into never targets the production stack or etc/" {
    d="$(real_dir)"; check_restore_target "$d"
    d="$(fixture valid)"; check_restore_target "$d"
    d="$(fixture_snippet "${FIX}/snippets/restore-into-production.md" restore)"
    run check_restore_target "$d"
    [ "$status" -ne 0 ]; [[ "$output" == *"targets the production stack (gremion)"* ]]
}

@test "install ends by disabling the backup timer and asserts disabled and inactive" {
    d="$(real_dir)"; check_install_tail "$d"
    d="$(fixture valid)"; check_install_tail "$d"
    d="$(fixture timer-not-last)"
    run check_install_tail "$d"
    [ "$status" -ne 0 ]; [[ "$output" == *"last step is not"* ]]
}

@test "install's timer Known gap is still true of bootstrap.sh (owner TASK-040)" {
    d="$(real_dir)"
    check_timer_gap "$d" "${TREE_ROOT}/infra/host/bootstrap.sh"
    local closed="${BATS_TEST_TMPDIR}/bootstrap-closed.sh"
    grep -vF 'systemctl enable --now gremion-backup.timer' "${TREE_ROOT}/infra/host/bootstrap.sh" > "$closed"
    run check_timer_gap "$d" "$closed"
    [ "$status" -ne 0 ]; [[ "$output" == *"the gap is closed"* ]]
}

@test "the run record names every DB-OPS-RUNBOOK-PROCEDURE-RUN column" {
    d="$(real_dir)"; check_run_record "$d"
    d="$(fixture valid)"; check_run_record "$d"
    d="$(fixture missing-scope)"
    run check_run_record "$d"
    [ "$status" -ne 0 ]; [[ "$output" == *"column 'scope'"* ]]
}

@test "extractor floor: every procedure unit yields a step and a post-condition observation" {
    d="$(real_dir)"; check_floor "$d"
    d="$(fixture empty-steps)"
    run check_floor "$d"
    [ "$status" -ne 0 ]; [[ "$output" == *"install: the step extractor found no step"* ]]
}

@test "every runtime/ and logs/ artefact the runbook cites is written by infra/host" {
    d="$(real_dir)"; check_artefacts "$d"
    d="$(fixture valid)"; check_artefacts "$d"
    d="$(fixture_snippet "${FIX}/snippets/unknown-artefact.md" backup)"
    run check_artefacts "$d"
    [ "$status" -ne 0 ]; [[ "$output" == *"runtime/last-nothing.json"* ]]
}

@test "every deploy.log pattern matches a line gremion-deploy writes, including a failed step" {
    [ -f "${TREE_ROOT}/infra/host/bin/gremion-deploy" ]
    d="$(real_dir)"; check_deploy_log "$d"
    d="$(fixture valid)"; check_deploy_log "$d"
    d="$(fixture anchored-deploy-log)"
    run check_deploy_log "$d"
    [ "$status" -ne 0 ]; [[ "$output" == *"no real log line matches"* ]]
}

@test "every reboot-gate.log pattern matches a REBOOT-GATE: line gremion-verify prints" {
    [ -f "${TREE_ROOT}/infra/host/bin/gremion-verify" ]
    d="$(real_dir)"; check_reboot_gate "$d"
    d="$(fixture valid)"; check_reboot_gate "$d"
    d="$(fixture wrong-reboot-gate)"
    run check_reboot_gate "$d"
    [ "$status" -ne 0 ]; [[ "$output" == *"gremion-verify never prints"* ]]
}

@test "every PENDING entry names its owning task and is cited in the runbook" {
    d="$(real_dir)"
    [ "${#PENDING_PATHS[@]}" -ge 1 ]
    check_pending_cited "$d"
}

@test "positive control: the valid fixture passes every check" {
    local c
    d="$(fixture valid)"
    for c in "${ALL_CHECKS[@]}"; do
        if ! "$c" "$d"; then echo "valid fixture failed ${c}" >&2; return 1; fi
    done
    check_links "$d" "$d"
}

@test "no pending dependency has landed while its entry is still listed" {
    pending_landed "$TREE_ROOT"
    # Watched RED on a synthetic tree in which one listed path has landed.
    local t="${BATS_TEST_TMPDIR}/landed"
    mkdir -p "$t/infra/host" "$t/scripts/backup"
    run pending_landed "$t"
    [ "$status" -ne 0 ]
    [[ "$output" == *"delete this entry from test/host/runbook.bats"* ]]
    [[ "$output" == *"scripts/backup/|TASK-089"* ]]
}
