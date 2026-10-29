# ci-local

TASK-012 (L1-28): dated test-suite snapshots plus the merge-gate guard set,
run locally while GitHub Actions stays disabled (TRD-340/342/346/356/364).
Everything here is Node plus one npm package, `yaml` (runner-policy parses
workflows with it), and `gitleaks` on PATH, so one call works unchanged on
Windows, Debian and `ubuntu-latest`.

**Prerequisite:** run `pnpm install --frozen-lockfile` at the kernel root
first. `yaml` is a root `dependencies` entry (pinned 2.9.0) in `package.json` /
`pnpm-lock.yaml`. Those files belong to TASK-017; the maintainer granted
this one addition to TASK-012 under decision R24-1 (TASK-012-FU,
2026-09-25). If `yaml` cannot be imported, nothing crashes: `guards.mjs`
still writes its dated JSON, the runner-policy arm FAILs with a reason that
names this command, and the exit code is non-zero.

The second repo's CLI flag, repo label and suite-id prefix are spelled
`--vertical` / `vertical` / `vertical-*`, not the product's own name: the
kernel hygiene check (`make lint-hygiene` rule h2) forbids the retired
product token as a bare lower-case identifier anywhere in the tree, and this
package's own flag/label/ids were exactly that. `StuRaOS` (capitalized, the
vertical's proper noun) still appears in prose comments — h2 is
case-sensitive and only owns the lower-case identifier form.

## The one-line call a re-enabled pipeline makes unchanged

```
node scripts/ci-local/guards.mjs --kernel <kernel-path> --vertical <vertical-path> --kernel-base <kernel-base-ref> --vertical-base <vertical-base-ref>
```

Give each repo its own base ref: the kernel's default branch is `main`,
StuRaOS's is `master`. A shared `--base` is still accepted, but it must
resolve in BOTH repos — a base that does not resolve in a repo FAILs that
repo's secret-scan instead of scanning an empty range. Leave out the bases
for a whole-tree scan. A result JSON is written on every run (`--out` below);
a pipeline sets `CI_LOCAL_GUARDS_OUT` (or passes `--out`) to its artifact
directory.

Exit code is the merge gate: non-zero means at least one arm failed and the
merge must be blocked. This is exactly the call a re-enabled `ci.yml` (or the
`docker-build` image-build job beside it, see below) makes — nothing here
takes an Actions-specific input, and the runner-policy arm (below) is what
keeps a re-enabled Actions runner honest about TRD-364 in the first place.

## Kernel-only checkout (no `--vertical`)

`--vertical` is optional. From a kernel-only checkout run the same commands
without it:

```
node scripts/ci-local/snapshot.mjs --kernel . --out <dir> --list     # dry run: what would run / be skipped
node scripts/ci-local/snapshot.mjs --kernel . --out <dir>
node scripts/ci-local/guards.mjs   --kernel .
node scripts/ci-local/runner-policy.mjs --kernel .
```

- Every `vertical` suite (snapshot) and every vertical arm (guards:
  `secret-scan`, `known-secrets`, `known-secrets-vertical-native`,
  `overrides-drift` on the vertical) is reported **`SKIPPED`** with the reason
  `skipped: no --vertical` in the console, the JSON and the markdown. A
  skipped row is never counted as passed, and the exit code reflects the
  kernel suites/arms only: 0 if they pass, 1 if any fails.
- `runner-policy` evaluates the kernel only; the guards runner-policy arm
  reports `repo: kernel` instead of `both`.
- A `--vertical` path that is given but does not exist is a loud error
  (exit 1, nothing written) — never a silent fall-back to kernel-only.
- With `--vertical`, behaviour is unchanged (both repos, clean-tree check,
  all arms).
- `snapshot.mjs --list` is the dry run: it prints `WOULD RUN` / `SKIPPED` per
  suite and runs nothing (no `--out`, no clean tree needed).
- A kernel-only run is not a full reading: do not file it as the
  F1/re-init/first-offer snapshot (that needs both repositories).

## Two entry points

### `guards.mjs` — the single merge-gate entry point

```
node scripts/ci-local/guards.mjs --kernel <path> [--vertical <path>] [--base <ref>] [--kernel-base <ref>] [--vertical-base <ref>] [--waivers <path>] [--known-secrets-denylist <path>] [--out <dir>]
```

Runs every arm below, in order, **all of them every time** — a failing arm
never skips the rest, so the dated result always shows every arm's outcome:

1. **secret-scan** — `gitleaks`, diff-scoped (`git ... --log-opts "<base>..HEAD"`)
   when a base ref is given, whole-tree (`dir`, filtered to git-tracked
   files) otherwise. Always runs with `cwd` set to the (resolved-absolute)
   repo path and scans/configures via the relative `"."` / `.gitleaks.toml`
   — never an embedded absolute path — so `.gitleaks.toml`'s `^`-anchored
   `paths` allowlist behaves the same no matter how the caller spelled the
   repo path (a HIGH fix: an absolute repo path used to defeat the anchor).
   A missing `gitleaks` binary is its own FAIL, never a skip. In dir mode a
   non-zero exit (only possible as a scan error, since `--exit-code 0`
   neutralizes "leaks found") is a FAIL, and a missing/unparseable/
   non-array report is a FAIL — never coerced to "0 findings" (HIGH fix: a
   broken `.gitleaks.toml` used to make gitleaks FTL with no report file,
   which read as a silent PASS). `--kernel-base`/`--vertical-base` set a
   per-repo diff base ref (falling back to the shared `--base`); either way,
   `runGitleaksArm` verifies the ref resolves to a commit IN THAT REPO before
   scanning and FAILs if it does not, rather than vacuously scanning an empty
   range (HIGH fix: one `--base` applied to both repos silently no-opped
   whichever repo's default branch it did not match — kernel `main` vs.
   StuRaOS `master`). An `ERR`/`FTL` line in gitleaks' own output FAILs the
   arm even if the exit code alone would have looked clean. A diff-scoped
   result records `commitsScanned`. A base that resolves to `HEAD` still
   PASSes, but carries `note: "empty range, 0 commits"`, so a zero-commit
   scan is visible in the dated JSON.
2. **known-secrets** — `known-secrets.mjs`'s SHA-256 digest denylist, run
   against **both** repos (the kernel owns the scanner; §5 Q2 below).
   `--known-secrets-denylist <path>` merges an extra JSON `{digest: note}`
   file onto it — the kernel's own denylist starts empty (no incidents
   recorded yet), so this is also the only way to prove this arm FAILs at
   the entry point without editing source.
3. **known-secrets-vertical-native** — StuRaOS's **own**
   `scripts/check-no-known-secrets.mjs` (its 2 real incident digests), run
   against the vertical path. The kernel-ported arm above can never fail on
   the kernel's own empty denylist, so relying on it alone would silently
   drop StuRaOS's real incidents; this arm is what actually protects them.
4. **cve-floor** — the kernel's own `scripts/check-cve-floors.mjs`, same
   order as `make lint-cve-floors` (its unit test first, then the guard).
5. **overrides-drift** — StuRaOS's `scripts/check-overrides-drift.mjs`,
   pointed at *this* kernel checkout's `pnpm-workspace.yaml` (`--kernel`),
   never at the `upstream/gremion` submodule.
6. **runner-policy** — `runner-policy.mjs` on both repos' `.github/workflows/*.yml`.

`--waivers <path>` defaults to the committed `scripts/ci-local/waivers.json`.

Every run writes `<out>/<YYYY-MM-DD>T<hhmmss>Z-<kernel-sha7>-<vertical-sha7>-guards.json`
(a new name each second, so a RED record is never overwritten by the GREEN
re-run). `<out>` is `--out <dir>`, else `$CI_LOCAL_GUARDS_OUT`, else
`<os tmpdir>/ci-local-guards-results` — never inside either repo.

Every guard command is spawned as an argument array with no shell
(`lib/run.mjs`), so a ref or a path is never parsed by a shell, and a base
ref with whitespace, a leading `-`, `..` or shell metacharacters is refused
before git or gitleaks sees it. The script arms (native known-secrets,
cve-floor, overrides-drift) run the script's own `node --test` first and
FAIL if it collected 0 tests. Only `suites.json` commands (committed text,
no runtime value) go through a shell.

### `snapshot.mjs` — the dated pass/fail census

```
node scripts/ci-local/snapshot.mjs --kernel <path> [--vertical <path>] --out <dir> [--list] [--only <suite-id,...>] [--stack-env <file>]
```

`--out` is **mandatory** (§5 Q3: nothing is committed to the kernel — the
maintainer files snapshots in the vault ledger). Refuses a dirty tree in
either repo, and refuses an invalid `suites.json` (missing category
coverage). Writes `<out>/<date>-<kernel-sha7>-<vertical-sha7>.json` and the
companion `.md`, naming both full SHAs, branches, the OS, start/finish times,
and every suite's repo/category/command/collected/passed/failed/status/exit
code. Exit is non-zero whenever **any** row is FAIL — including an honest
"no stack" row; this script's job is to record a FAIL, never to make one
disappear.

- `--only <suite-id,suite-id,...>` runs a named subset (for staying under a
  wall-clock budget); unclaimed-file detection still uses the **full**
  manifest regardless of `--only`, because `--only` changes what runs, not
  what ownership looks like.
- `--stack-env <file>` is a marker file only — this script never starts or
  stops a stack. Without it, every `requiresStack: true` suite FAILs "no
  stack" rather than being skipped.
- The full run across every suite of both repos is the maintainer's
  whole-tree gate, run once per lane — not something this script does on
  every invocation.

## `suites.json`

The committed suite manifest. Every repo needs ≥1 suite per category
(`unit`, `integration`, `e2e`, `shell`, `tree-guard`) or both scripts refuse
to run. Each suite's `testGlobs` are what prove its files exist (a missing
manifest suite is a FAIL) and what claims a test file so it is not reported
as unclaimed; a test file (`*.test.ts`, `*.spec.ts`, `*.test.mjs`, `*.bats`,
`*_test.dart`) that no suite's globs reach is its own FAIL row. `kind`
selects the output parser in `lib/parse-output.mjs`; the `guard` kind
composes a suite's own `node --test` TAP summary with its trailing guard
script's exit code (see `lib/snapshot-core.mjs`).

Two optional fields keep the manifest honest as the tree grows (TASK-012-FU2):

- `excludeGlobs` names files a suite's `testGlobs` reach but its command does
  not run (a vitest `exclude`). Prefer directory-level `testGlobs`
  (`modules/x/test/**/*.test.ts`) plus the runner's own excludes: a new file
  is then claimed automatically, and a new integration file stays UNCLAIMED
  (RED) until a suite that really runs it exists, instead of being claimed by
  a unit runner that skips it.
- `unrunnable: "<reason>"` marks a suite whose files are real and claimed but
  for which no runner exists in this tree. It is recorded FAIL
  (`could not run: <reason>`) on every reading, never skipped.

`scripts/ci-local/tree-claim.test.mjs` walks the real kernel tree against
this manifest and fails on any unclaimed test file (and on any suite that
owns no file), so a lane that adds a test file without a suite goes RED in the
ordinary `node --test scripts/ci-local/*.test.mjs` run. Set
`CI_LOCAL_VERTICAL=<path to the vertical checkout>` to run the same census on
the vertical; `snapshot.mjs --vertical` does it on every reading.

Every `node --test` invocation in this package's own commands passes
`--test-reporter=tap` explicitly (the installed Node's `node --test` with no
reporter flag defaults to the human "spec" reporter, which has no `# tests`
summary line at all — see `lib/run.mjs`'s header comment for the related
`NODE_TEST_CONTEXT` leak this package also guards against). A suite this
package does not spell out itself (a `pnpm run test:carve` script in the
other repo) still gets the spec reporter, so `parseNodeTest` also reads the
spec summary (`ℹ tests N` / `ℹ pass N` / `ℹ fail N`) when no TAP summary is
present, ignoring ANSI colour codes and CRLF line ends.

## `known-secrets.mjs`

A SHA-256 digest denylist, ported from StuRaOS's
`scripts/check-no-known-secrets.mjs` because the kernel must not import from
the product (open-core boundary: dependency direction is kernel -> product,
never the reverse — §5 Q2). Carries digests only, never a plaintext
credential in any encoding. `guards.mjs` runs this same file against both
repos, PLUS StuRaOS's own `scripts/check-no-known-secrets.mjs` directly
against the vertical path (the `known-secrets-vertical-native` arm) — the
kernel's own `KNOWN_COMPROMISED` starts empty, so the kernel-ported copy
alone can never fail and would otherwise silently drop StuRaOS's 2 real
incident digests. `loadDenylistFile` merges an extra JSON `{digest: note}`
file onto the kernel-ported copy (`--known-secrets-denylist`), which is also
how this arm's entry-point behavior is proven RED on an injected sentinel
without editing source. There is no allowlist for this rule, on any path,
ever: the only way to suppress a match is to remove the credential from the
tree (and rotate it — this script cannot do that for you).

## `runner-policy.mjs`

Parses each `.github/workflows/*.yml` with `yaml` and fails on any job whose
`runs-on` does not provably resolve to GitHub-hosted labels (an allowlist:
a custom label, a runner group, an unresolvable expression or an
unparseable file all fail closed). A matrix-supplied `runs-on`
(`${{ matrix.<key> }}`) passes only when every value of that key — the base
list AND every `strategy.matrix.include` entry — is a hosted label; a
matrix, `include` or `exclude` that is an expression or not a list of
mappings fails closed. It also fails on any reference to a signing/age/SSH/
deploy secret (TRD-364). Context and function names are matched ignoring
case, as GitHub does: `secrets.NAME`, `SECRETS.NAME` and `secrets['NAME']`
give `secret:NAME` (name upper-cased); `toJson(secrets)`, a computed index
(`secrets[format(...)]`, `secrets[matrix.k]`), any other use of the whole
context inside an expression, and `secrets: inherit` all fail closed, since
they can carry ANY secret, not just a named one. Each `waivers.json`
entry is `{repo, file, owner, expiresOn, covers, reason}`. `covers` lists
the exact finding ids the waiver mutes (`secret:DEPLOY_SSH_KEY`,
`self-hosted`, `secrets-tojson`, `secrets-dynamic-index`,
`secrets-context`, `secrets-inherit`); any other finding in
the waived file still fails, so a waiver cannot grow silently. An entry
whose `expiresOn` is not a real `YYYY-MM-DD` date, or with no `covers`, is
never live (fail closed). Matching uses BOTH `repo` and `file` — a
waiver naming `{repo: "kernel", file: "deploy.yml"}` never covers a StuRaOS
`deploy.yml`, even though the basename is identical (a bare `{file}` waiver
was a HIGH finding: it silently muted the other repo's same-named file too).
An expired waiver still fails the guard by design, so a forgotten waiver
degrades to a normal RED rather than a silent pass. Waiver use is also
reported in `guards.mjs`'s arm result (a `waived[]` array with `repo`,
`path`, `owner` and `expiresOn`), so the dated JSON shows every waiver that
was actually exercised, not just an empty `findings` array.
`waivers.json` is empty today: the one waiver it ever held, for the kernel's
`deploy.yml`, was retired with that workflow (replaced by the keyless
`release-images.yml`).

**Accepted heuristic limit:** `SENSITIVE_SECRET_NAME_RE` matches secret names
only, on a fixed set of substrings (DEPLOY/SIGN(ING)/SSH/GPG/SOPS/COSIGN/
KEYSTORE/PRIVATE_KEY/HOST_KEY/AGE). A deploy credential whose *name* does not
contain one of those (e.g. `KUBECONFIG`, `SERVER_TOKEN`) is not flagged, even
though it may be exactly the kind of secret TRD-364 cares about. This is a
known, accepted gap in the heuristic, not a bug: extending the list is cheap
(add a term to the regex) whenever a real workflow secret name falls outside
it.

## The image-build job

"The image-build job" (TRD-342) is the existing `docker-build` jobs, which
stay beside `guards.mjs` unchanged (§5 Q5) — this package does not build
images. `guards.mjs --kernel <path> --vertical <path> --image-build` is purely
informational: it lists the Dockerfiles those jobs build (for both repos)
and exits 0 without running any guard arm. A re-enabled pipeline runs
`docker-build` as its own job, in parallel with (not instead of) the call at
the top of this file.

## Runner posture (TRD-364)

Any CI runner used to run the call above is ephemeral, holds no signing key,
age key or deploy credential, and never runs on the operator's workstation
or the pilot host. `runner-policy.mjs` is what enforces that on the
`.github/workflows/*.yml` side; this package assumes it, it does not itself
provision a runner.
