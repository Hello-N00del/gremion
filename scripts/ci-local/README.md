# ci-local

TASK-012 (L1-28): dated test-suite snapshots plus the merge-gate guard set,
run locally while GitHub Actions stays disabled (TRD-340/342/346/356/364).
Everything here is pure Node (no external deps beyond `gitleaks` on PATH),
so one call works unchanged on Windows, Debian and `ubuntu-latest`.

## The one-line call a re-enabled pipeline makes unchanged

```
node scripts/ci-local/guards.mjs --kernel <kernel-path> --sturaos <sturaos-path> --base <base-ref>
```

Exit code is the merge gate: non-zero means at least one arm failed and the
merge must be blocked. This is exactly the call a re-enabled `ci.yml` (or the
`docker-build` image-build job beside it, see below) makes — nothing here
takes an Actions-specific input, and the runner-policy arm (below) is what
keeps a re-enabled Actions runner honest about TRD-364 in the first place.

## Two entry points

### `guards.mjs` — the single merge-gate entry point

```
node scripts/ci-local/guards.mjs --kernel <path> --sturaos <path> [--base <ref>] [--waivers <path>] [--out <dir>]
```

Runs every arm below, in order, **all of them every time** — a failing arm
never skips the rest, so the dated result always shows every arm's outcome:

1. **secret-scan** — `gitleaks`, diff-scoped (`git ... --log-opts "<base>..HEAD"`)
   when `--base` is given, whole-tree (`dir`, filtered to git-tracked files)
   otherwise. A missing `gitleaks` binary is its own FAIL, never a skip.
2. **known-secrets** — `known-secrets.mjs`'s SHA-256 digest denylist, run
   against **both** repos (the kernel owns the scanner; §5 Q2 below).
3. **cve-floor** — the kernel's own `scripts/check-cve-floors.mjs`, same
   order as `make lint-cve-floors` (its unit test first, then the guard).
4. **overrides-drift** — StuRaOS's `scripts/check-overrides-drift.mjs`,
   pointed at *this* kernel checkout's `pnpm-workspace.yaml` (`--kernel`),
   never at the `upstream/gremion` submodule.
5. **runner-policy** — `runner-policy.mjs` on both repos' `.github/workflows/*.yml`.

`--waivers <path>` defaults to the committed `scripts/ci-local/waivers.json`.
`--out <dir>` additionally writes a dated `<dir>/<date>-guards.json`.

### `snapshot.mjs` — the dated pass/fail census

```
node scripts/ci-local/snapshot.mjs --kernel <path> --sturaos <path> --out <dir> [--only <suite-id,...>] [--stack-env <file>]
```

`--out` is **mandatory** (§5 Q3: nothing is committed to the kernel — the
orchestrator files snapshots in the vault ledger). Refuses a dirty tree in
either repo, and refuses an invalid `suites.json` (missing category
coverage). Writes `<out>/<date>-<kernel-sha7>-<sturaos-sha7>.json` and the
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
- The full run across every suite of both repos is the orchestrator's
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

Every `node --test` invocation in this package's own commands passes
`--test-reporter=tap` explicitly (the installed Node's `node --test` with no
reporter flag defaults to the human "spec" reporter, which has no `# tests`
summary line at all — see `lib/run.mjs`'s header comment for the related
`NODE_TEST_CONTEXT` leak this package also guards against).

## `known-secrets.mjs`

A SHA-256 digest denylist, ported from StuRaOS's
`scripts/check-no-known-secrets.mjs` because the kernel must not import from
the product (open-core boundary: dependency direction is kernel -> product,
never the reverse — §5 Q2). Carries digests only, never a plaintext
credential in any encoding. `guards.mjs` runs this same file against both
repos. There is no allowlist for this rule, on any path, ever: the only way
to suppress a match is to remove the credential from the tree (and rotate it
— this script cannot do that for you).

## `runner-policy.mjs`

Fails on any `.github/workflows/*.yml` that names a `self-hosted` runner or
references a signing/age/SSH/deploy secret (TRD-364). `waivers.json` waives
exactly one named file until its `expiresOn` date; an expired waiver still
fails the guard by design, so a forgotten waiver degrades to a normal RED
rather than a silent pass. See `waivers.json`'s own entry for why
`deploy.yml` is waived today and who owns removing the waiver.

## The image-build job

"The image-build job" (TRD-342) is the existing `docker-build` jobs, which
stay beside `guards.mjs` unchanged (§5 Q5) — this package does not build
images. `guards.mjs` takes no `--image-build` flag beyond what is documented
above; a re-enabled pipeline runs `docker-build` as its own job, in parallel
with (not instead of) the call at the top of this file.

## Runner posture (TRD-364)

Any CI runner used to run the call above is ephemeral, holds no signing key,
age key or deploy credential, and never runs on the operator's workstation
or the pilot host. `runner-policy.mjs` is what enforces that on the
`.github/workflows/*.yml` side; this package assumes it, it does not itself
provision a runner.
