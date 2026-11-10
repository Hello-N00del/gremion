#!/usr/bin/env bash
set -euo pipefail
#
# mutation-proof.sh -- watch the isolation:tenant guards go RED (the spine's
# GATE step 4: "a guard is done when you have watched it fail").
#
# It proves, for each module of the producer's case table, that BREAKING the
# isolation code makes `verify --only isolation:tenant` fail, write NO evidence
# file, and NAME the failing test of that module. Without this, a case file that
# passes whatever the code does would produce evidence for nothing.
#
#   1. `git clone --no-hardlinks` of HEAD into a scratch directory (the working
#      tree is never touched), `pnpm install --frozen-lockfile` there.
#   2. CONTROL: the producer on the unmutated clone MUST exit 0 and write
#      scripts/verify/out/isolation/<sha>.json. If it does not, every "no file"
#      below would pass for the wrong reason and the proof is VOID (exit 1).
#   3. For each mutation: apply it, COMMIT it in the scratch clone (verify
#      refuses a dirty tree with exit 1 and no file, which would make an
#      uncommitted mutation pass vacuously, so a "refusing to run" in the output
#      is itself a failure of the proof), run the producer, and require
#        - a non-zero exit,
#        - no evidence file for the mutated commit,
#        - the output to name the expected failing test of that module,
#      then `git reset --hard` back to the base commit.
#
# Usage (from the repository root, on a clean tree):
#   ISOLATION_TENANT_PG_URL=postgres://postgres@127.0.0.1:<port>/postgres \
#     test/isolation/tenant/mutation-proof.sh [--only id[,id...]] [--list]
#
#   ISOLATION_TENANT_PG_URL  the throwaway Postgres of the leaf cases: localhost,
#                            a port other than 5432 (the leaves' own guard
#                            enforces it). Required.
#   MUTATION_PROOF_CLONE     reuse (or create and keep) this scratch clone, so a
#                            long proof can run in several calls; the caller
#                            removes it. Unset: a temporary clone, removed on exit.
#
#   --check-targets          offline, no Postgres, no clone: only prove that every
#                            mutation's target line occurs exactly once in this
#                            work tree. A refactor that rewrites a target line makes
#                            a full pass die half way; this makes it red at once.
#                            scripts/check-isolation-mutation-targets.test.mjs runs it.
#
# One pass is a producer run per mutation (about 30 s each). Exit codes follow
# infra/host/README.md: 0 every mutation proved RED, 1 a proof failed, 2 usage.

MUTATION_IDS=(
  a-calendar a-content a-publishing
  b-calendar b-content b-publishing
  c-votes
  d-client d-token d-admin
  e-backslash e-dotdot e-dothidden e-uploadid e-bearer e-editpage
)

die() { printf 'mutation-proof: %s\n' "$*" >&2; exit "${2:-1}"; }
usage() { sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

ONLY=""
CHECK=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only) [[ $# -ge 2 ]] || die "--only needs a value" 2; ONLY="$2"; shift 2 ;;
    --check-targets) CHECK=1; shift ;;
    --list) printf '%s\n' "${MUTATION_IDS[@]}"; exit 0 ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1" 2 ;;
  esac
done
[[ "$CHECK" == 1 || -n "${ISOLATION_TENANT_PG_URL:-}" ]] || die "ISOLATION_TENANT_PG_URL is required (a throwaway Postgres on localhost, not port 5432)" 2

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SELF_DIR/../../.." && pwd)"
command -v node >/dev/null 2>&1 || die "node is required" 2
if [[ "$CHECK" != 1 ]]; then
  command -v git >/dev/null 2>&1 || die "git is required" 2
  command -v pnpm >/dev/null 2>&1 || die "pnpm is required" 2
  if [[ -n "$(git -C "$REPO" status --porcelain)" ]]; then
    die "the working tree is not clean: the proof is about the HEAD commit, commit or remove the changes first" 2
  fi
  BASE="$(git -C "$REPO" rev-parse HEAD)"
fi

KEEP=1
CLONE="${MUTATION_PROOF_CLONE:-}"
if [[ "$CHECK" == 1 ]]; then
  # --check-targets reads this work tree and writes nothing
  CLONE="$REPO"
elif [[ -z "$CLONE" ]]; then
  CLONE="$(mktemp -d)"
  KEEP=0
fi
LOG="$(mktemp)"
trap '[[ "$KEEP" == 1 ]] || rm -rf "$CLONE"; rm -f "$LOG"' EXIT

# The scratch commits need an identity; environment variables, never `git config`.
export GIT_AUTHOR_NAME=mutation-proof GIT_AUTHOR_EMAIL=mutation-proof@invalid
export GIT_COMMITTER_NAME=mutation-proof GIT_COMMITTER_EMAIL=mutation-proof@invalid
export CI=true

g() { git -C "$CLONE" "$@"; }

# The marker lives inside .git: a file in the work tree would make verify see a dirty tree.
if [[ "$CHECK" != 1 && ! -e "$CLONE/.git/mutation-proof-ready" ]]; then
  # never delete a directory this script did not make
  if [[ -e "$CLONE" && -n "$(ls -A "$CLONE" 2>/dev/null)" ]]; then die "MUTATION_PROOF_CLONE=$CLONE exists, is not empty and is not a prepared clone of this proof" 2; fi
  mkdir -p "$CLONE"
  git clone --no-hardlinks -q "$REPO" "$CLONE"
  g cat-file -e "${BASE}^{commit}" 2>/dev/null || die "HEAD $BASE is not reachable from a ref of this repository, so the clone does not hold it"
  g checkout -q --detach "$BASE"
  (cd "$CLONE" && pnpm install --frozen-lockfile >/dev/null 2>&1) || die "pnpm install --frozen-lockfile failed in the scratch clone"
  : > "$CLONE/.git/mutation-proof-ready"
fi
if [[ "$CHECK" != 1 ]]; then
  g reset --hard -q "$BASE"
  [[ "$(g rev-parse HEAD)" == "$BASE" ]] || die "the scratch clone is not at $BASE"
fi

# run_producer -- the producer on the clone's HEAD; output in $LOG, exit code in $RC.
RC=0
run_producer() {
  RC=0
  (cd "$CLONE" && node scripts/verify/verify.mjs --only isolation:tenant) >"$LOG" 2>&1 || RC=$?
}

# mutate <file> <find> <replace> -- one exact, single-line replacement; refuses to
# continue when the line is absent or occurs more than once (a mutation that
# changes nothing would prove nothing).
mutate() {
  # Git Bash hands node a POSIX path it cannot always convert (a `[roomId]` segment defeats the
  # automatic conversion), so give it the native form where cygpath exists.
  local target="$CLONE/$1"
  if command -v cygpath >/dev/null 2>&1; then target="$(cygpath -m "$target")"; fi
  # shellcheck disable=SC2016  # the JavaScript is deliberately literal, nothing here is shell
  node -e '
    const fs = require("node:fs")
    const [file, find, repl, check] = process.argv.slice(1)
    const text = fs.readFileSync(file, "utf8")
    const n = text.split(find).length - 1
    if (n !== 1) { console.error(`mutate: ${JSON.stringify(find)} occurs ${n} time(s) in ${file}, expected exactly 1`); process.exit(3) }
    if (find === repl) { console.error(`mutate: the replacement equals the target in ${file}, it would change nothing`); process.exit(3) }
    if (check !== "1") fs.writeFileSync(file, text.replace(find, () => repl))
  ' "$target" "$2" "$3" "$CHECK" || die "could not apply a mutation to $1"
}

# ---- the mutations: each sets EXPECT (an ERE the failing output must match) and DESC ----

mut_a() { # shared database: the database name ignores the tenant slug
  mutate "modules/$1/src/tenant-store.ts" "  const dbName = dbPrefix + tenant.slug" "  const dbName = dbPrefix + 'shared'"
  EXPECT="each tenant is served from its own physical database"
  DESC="$1 leaf: dbName ignores the slug"
}
mut_b() { # binding check removed: the throw in assertCatalogBinding and the warm-path check
  mutate "modules/$1/src/tenant-store.ts" "      throw new TenantIdentityMismatchError(tenant, { id: row.tenant_id, slug: row.slug })" "      continue"
  mutate "modules/$1/src/tenant-store.ts" "    if (existing.slug !== tenant.slug) {" "    if (false as boolean) {"
  EXPECT="binding: B's id with A's slug"
  DESC="$1 leaf: the identity binding checks are gone"
}
mut_c_votes() { # scopePoll returns any poll
  mutate "modules/votes/app/lib/server/polls/tenant-scope.ts" "  if (effective !== tenantId) return null" "  if (false as boolean) return null"
  EXPECT="A cannot list B polls"
  DESC="votes: scopePoll serves any tenant's poll"
}
mut_d_client() { # getMatrixClient ignores the tenant key
  mutate "modules/messaging/app/lib/server/messages/matrix-client.ts" "  const existing = _clientByTenant.get(ctx.id)" "  const existing = _clientByTenant.get('shared')"
  mutate "modules/messaging/app/lib/server/messages/matrix-client.ts" "  _clientByTenant.set(ctx.id, client)" "  _clientByTenant.set('shared', client)"
  EXPECT="tenant A and B get DISTINCT instances|in-process client, whose clients are the per-tenant keyed ones"
  DESC="messaging: getMatrixClient serves one client to every tenant"
}
mut_d_token() { # the Matrix token cache key ignores the tenant
  # shellcheck disable=SC2016  # a JavaScript template literal, deliberately not expanded
  mutate "modules/messaging/app/lib/server/messages/matrix-client.ts" '    const cacheKey = `${tenantId}|${subKey}`' '    const cacheKey = `${subKey}`'
  EXPECT="gets two logins and two different Matrix tokens"
  DESC="messaging: the token cache is shared between tenants"
}
mut_d_admin() { # PATCH no longer checks the room against the caller's ledger
  mutate "modules/messaging/app/routes/api/messages/rooms/[roomId]/+server.ts" "  if (resource?.external_id !== params.roomId) {" "  if (false as boolean) {"
  EXPECT="rename: B's room with A's unit"
  DESC="messaging: PATCH trusts the roomId in the URL"
}
mut_e_backslash() { # the path guard no longer refuses backslashes and control characters
  mutate "modules/files/app/lib/server/files/webdav-path.ts" '  if (/[\\\u0000-\u001f\u007f]/.test(decoded)) {' "  if (false as boolean) {"
  EXPECT="backslash dot-dot"
  DESC="files: backslash and control characters pass the path guard"
}
mut_e_dotdot() { # the dot-dot check is gone
  mutate "modules/files/app/lib/server/files/webdav-path.ts" "  if (decoded.split('/').some(isDotSegment)) {" "  if (false as boolean) {"
  EXPECT="dot-dot to the other customer"
  DESC="files: a .. segment passes the path guard"
}
mut_e_dothidden() { # a dot segment is only recognised when it is bare: `..?x`, `..#x`, `.. ` pass
  mutate "modules/files/app/lib/server/files/webdav-path.ts" "  const head = seg.split(/[?#]/, 1)[0].trim()" "  const head = seg"
  EXPECT="dot-dot with a query suffix"
  DESC="files: a dot segment hidden behind ?x, #x or a space passes the path guard"
}
mut_e_uploadid() { # an upload id may be . or ..
  mutate "modules/files/app/routes/api/files/upload-chunk/+server.ts" 'const UPLOAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/' 'const UPLOAD_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/'
  EXPECT="uploadId carrying a path"
  DESC="files: an upload id of . or .. is accepted"
}
mut_e_bearer() { # A's request carries another bearer
  # shellcheck disable=SC2016  # a JavaScript template literal, deliberately not expanded
  mutate "modules/files/app/lib/server/files/nextcloud-client.ts" '    if (this.webdavBearer) return `Bearer ${this.webdavBearer}`' "    if (this.webdavBearer) return 'Bearer tok-B'"
  EXPECT="GET list: A sees its own folder|request carries exactly its caller bearer"
  DESC="files: every request carries one fixed bearer"
}

mut_e_editpage() { # the editor page builds its WebDAV path by hand again, without the shared guard
  # shellcheck disable=SC2016  # a JavaScript template literal, deliberately not expanded
  mutate "modules/files/app/routes/files/edit/[...path]/+page.server.ts" '  const webdavPath = buildWebdavPath(username, paramPath)' '  const webdavPath = `/remote.php/dav/files/${encodeURIComponent(username)}/${decodeURIComponent(paramPath)}`'
  EXPECT="the edit page"
  DESC="files: the editor page skips the shared path guard"
}

apply() {
  EXPECT=""; DESC=""
  case "$1" in
    a-calendar) mut_a calendar ;;
    a-content) mut_a content ;;
    a-publishing) mut_a publishing ;;
    b-calendar) mut_b calendar ;;
    b-content) mut_b content ;;
    b-publishing) mut_b publishing ;;
    c-votes) mut_c_votes ;;
    d-client) mut_d_client ;;
    d-token) mut_d_token ;;
    d-admin) mut_d_admin ;;
    e-backslash) mut_e_backslash ;;
    e-dotdot) mut_e_dotdot ;;
    e-dothidden) mut_e_dothidden ;;
    e-uploadid) mut_e_uploadid ;;
    e-bearer) mut_e_bearer ;;
    e-editpage) mut_e_editpage ;;
    *) die "unknown mutation id: $1" 2 ;;
  esac
}

# ---- --check-targets: every target line is present, exactly once, in this tree ----

if [[ "$CHECK" == 1 ]]; then
  for id in "${MUTATION_IDS[@]}"; do apply "$id"; done
  printf 'mutation-proof: all %s mutation targets occur exactly once\n' "${#MUTATION_IDS[@]}"
  exit 0
fi

# ---- CONTROL ---------------------------------------------------------------

printf 'control: the producer on the unmutated clone at %s\n' "${BASE:0:12}"
run_producer
if [[ "$RC" -ne 0 || ! -s "$CLONE/scripts/verify/out/isolation/$BASE.json" ]]; then
  tail -n 40 "$LOG" >&2
  die "the CONTROL run did not pass and write the evidence file: every 'no file' below would pass for the wrong reason, the proof is VOID"
fi
printf '  control OK: evidence file written\n'

# ---- the mutations -----------------------------------------------------------

if [[ -n "$ONLY" ]]; then IFS=',' read -r -a RUN <<< "$ONLY"; else RUN=("${MUTATION_IDS[@]}"); fi
proved=0
for id in "${RUN[@]}"; do
  g reset --hard -q "$BASE"
  apply "$id"
  if [[ -z "$(g status --porcelain)" ]]; then die "mutation $id changed nothing"; fi
  g add -A
  g commit -q -m "mutation $id"
  sha="$(g rev-parse HEAD)"
  run_producer
  fail=""
  [[ "$RC" -ne 0 ]] || fail="the producer EXITED 0 under the mutation"
  [[ -z "$fail" && -e "$CLONE/scripts/verify/out/isolation/$sha.json" ]] && fail="an evidence file was written under the mutation"
  if [[ -z "$fail" ]] && grep -q 'refusing to run' "$LOG"; then fail="the run was refused (dirty tree), not failed by a test: no RED"; fi
  if [[ -z "$fail" ]] && ! grep -Eq "$EXPECT" "$LOG"; then fail="the output does not name the expected failing test /$EXPECT/"; fi
  if [[ -n "$fail" ]]; then
    tail -n 60 "$LOG" >&2
    die "NOT proved: $id ($DESC): $fail"
  fi
  proved=$((proved + 1))
  printf '  RED proved: %-14s %s (exit %s, no evidence file, named /%s/)\n' "$id" "$DESC" "$RC" "$EXPECT"
done
g reset --hard -q "$BASE"
[[ "$proved" -gt 0 ]] || die "no mutation was run"
printf 'mutation-proof: %s mutation(s) proved RED against a passing control\n' "$proved"
