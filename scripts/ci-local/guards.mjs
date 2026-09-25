#!/usr/bin/env node
// The single merge-gate entry point (TASK-012 acceptance item 4): one call
// that runs every arm TRD-346/356/364 need while GitHub Actions stays
// disabled, and that a re-enabled Actions pipeline can call unchanged
// (README.md has the one-line invocation).
//
//   node scripts/ci-local/guards.mjs --kernel <path> --vertical <path> [--base <ref>] [--kernel-base <ref>] [--vertical-base <ref>] [--waivers <path>] [--known-secrets-denylist <path>] [--out <dir>]
//   node --test scripts/ci-local/guards.test.mjs
//
// Arms, run in this order, ALL of them, every time (a failing arm never
// skips the rest — the dated result must show every arm's outcome):
//   1. secret-scan   — gitleaks, diff-scoped when a base ref is given,
//                      whole-tree otherwise. A missing gitleaks binary
//                      FAILs; it is never treated as "scan skipped, pass".
//   2. known-secrets — the kernel-ported digest denylist (known-secrets.mjs),
//                      run against BOTH repos (TASK-012 §5 Q2).
//                      --known-secrets-denylist merges an extra
//                      {digest: note} JSON file onto it, which is also the
//                      injection point for proving this arm RED at the
//                      entry point on a seeded sentinel (the kernel's own
//                      denylist starts empty).
//   3. known-secrets-vertical-native — StuRaOS's OWN
//                      scripts/check-no-known-secrets.mjs (its 2 real
//                      incident digests), because the kernel-ported copy
//                      above can never fail against the kernel's own
//                      (empty) denylist and would otherwise silently drop
//                      StuRaOS's incidents the day this became StuRaOS's
//                      own gate too.
//   4. cve-floor     — the kernel's own scripts/check-cve-floors.mjs (its
//                      unit test runs first, same idiom as `make
//                      lint-cve-floors`).
//   5. overrides-drift — StuRaOS's scripts/check-overrides-drift.mjs,
//                      pointed at the KERNEL PATH's pnpm-workspace.yaml
//                      (never the upstream/gremion submodule — this repo's
//                      copy of the kernel tip is the source of truth here).
//   6. runner-policy — self-hosted / signing / age / SSH / deploy secret
//                      references in .github/workflows/*.yml, on both repos.
//
// Any failing arm means a non-zero exit (acceptance item 4). Nothing here
// mutates either repo; the CVE-floor and overrides-drift arms literally ARE
// `make lint-cve-floors` / `pnpm run test:overrides` run against whichever
// path is handed in, so a scratch clone works exactly like a real checkout.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname, relative, resolve, isAbsolute } from 'node:path'
import { walkFiles } from './lib/discover.mjs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { run } from './lib/run.mjs'
import { parseNodeTest } from './lib/parse-output.mjs'
import { headInfo } from './lib/git.mjs'
import { scanRepo as knownSecretsScanRepo, trackedFiles, loadDenylistFile } from './known-secrets.mjs'
import { evaluateRepo as runnerPolicyEvaluateRepo, loadWaivers, todayIso } from './runner-policy.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Arm 1 — gitleaks
// ---------------------------------------------------------------------------

/**
 * The exact gitleaks invocation, per TASK-012 §5's fixed decision. Both modes
 * scan "." with a RELATIVE --config, never an embedded repo path: the repo
 * comes ENTIRELY from the process cwd runGitleaksArm runs the command in
 * (resolve()d to absolute first). This was a HIGH fix — embedding an
 * absolute repoPath in the command string, as this used to do, defeats
 * .gitleaks.toml's `^`-anchored `paths` allowlist (an anchor matches from
 * the string gitleaks sees a path AS, and gitleaks reports paths relative to
 * its OWN cwd/source argument, not to whatever the caller happened to pass
 * on the command line) — the kernel went falsely RED on an allowlisted file
 * with an absolute repoPath and GREEN only with the accidental relative form
 * "." the original implementer's own gate run happened to use. Running with
 * cwd=repo and source "." is the only form where the allowlist behaves the
 * same regardless of how a caller spells the repo path.
 *
 * Diff-scoped ("git") mode inherently sees only committed content.
 * Whole-tree ("dir") mode does NOT — it walks the raw filesystem, which also
 * catches untracked/gitignored local droppings (a real developer's
 * .playwright-auth/*.json session dumps, secrets/*.bak, ...) that can never
 * reach a merge. Those are not this guard's concern, so dir mode runs with
 * --exit-code 0 and a JSON report; runGitleaksArm filters the report down to
 * git-tracked files before deciding pass/fail.
 */
export function gitleaksCommand(base, reportPath) {
  // An argv ARRAY, spawned with no shell (lib/run.mjs). CRITICAL fix: this
  // used to be a string with ${base} and the report path spliced in, run
  // with shell:true — a git ref may legally contain `$(`, `)` and
  // backticks, so a CI-supplied --base could execute code on the runner.
  if (base) {
    return ['gitleaks', 'git', '.', '--log-opts', `${base}..HEAD`, '--config', '.gitleaks.toml', '--redact', '--exit-code', '1']
  }
  return ['gitleaks', 'dir', '.', '--config', '.gitleaks.toml', '--redact', '--exit-code', '0', '--report-format', 'json', '--report-path', reportPath]
}

/**
 * A base ref this guard is willing to hand to git/gitleaks. Even with no
 * shell involved, gitleaks splits --log-opts on whitespace and passes the
 * pieces to `git log`, so a ref with a space or a leading `-` could smuggle
 * a git option (`--output=<file>`). Accepts branch names, remote refs, tags,
 * SHAs and rev suffixes (`~N`, `^`, `@{u}`); rejects whitespace, a leading
 * `-`, `..` (the caller builds the range itself) and shell metacharacters.
 */
export function isSafeRef(ref) {
  return typeof ref === 'string' && /^[A-Za-z0-9_][A-Za-z0-9._/~^@{}+-]*$/.test(ref) && !ref.includes('..')
}

/**
 * Run argv steps in order, like `a && b` but with no shell: stop at the
 * first step that fails. A step with `tap: true` is a `node --test` run and
 * must also report at least one collected test — `node --test` exits 0 on a
 * file that registers nothing, the vacuity the Makefile's
 * lint-extraction-source check exists for.
 *
 * @returns {{ exitCode, output, timedOut, spawnError, reason? }}
 */
export function runSteps(steps, cwd, runFn, { timeoutMs }) {
  let output = ''
  for (const step of steps) {
    const r = runFn(step.argv, cwd, { timeoutMs })
    output += (output ? '\n' : '') + (r.output ?? '')
    if (r.spawnError || r.timedOut || r.exitCode !== 0) return { ...r, output }
    if (step.tap) {
      const tap = parseNodeTest(r.output ?? '')
      if (tap.collected === 0) {
        return { exitCode: 1, output, timedOut: false, spawnError: null, reason: `${step.argv.slice(1).join(' ')} collected 0 tests — a vacuous test run is a failure` }
      }
    }
  }
  return { exitCode: 0, output, timedOut: false, spawnError: null }
}

const NODE = process.execPath

/**
 * Read a gitleaks JSON report written by a dir-mode run. Called ONLY after
 * confirming exit code 0 (verified empirically: a successful `--exit-code 0`
 * run always writes the report file, `[]` when clean — see the HIGH fix
 * below), so every failure mode here — missing file, unreadable file,
 * unparseable JSON, a parsed value that is not an array — means gitleaks did
 * NOT run to completion despite the exit code, and must surface as an error
 * the caller turns into a FAIL, never silently become "0 findings".
 *
 * HIGH fix: the previous version caught EVERY read/parse error (ENOENT,
 * a corrupted/truncated report, a non-JSON report) and returned [] for all
 * of them — indistinguishable from a real clean scan. Proven with the real
 * binary: a broken .gitleaks.toml makes gitleaks exit 1 with "FTL unable to
 * load gitleaks config" and write NO report file at all; the old code read
 * that missing file as "0 findings" = PASS.
 */
function readGitleaksReport(reportPath) {
  const text = readFileSync(reportPath, 'utf8')
  const parsed = JSON.parse(text)
  if (!Array.isArray(parsed)) {
    throw new Error(`gitleaks report at ${reportPath} was not a JSON array (got ${typeof parsed})`)
  }
  return parsed
}

/** A gitleaks FTL/ERR log line despite a "successful" exit code — defense in depth, never trusted as the sole signal. */
function hasFatalLog(output) {
  return /(^|[\s[])(FTL|ERR)([\s\]:]|$)/m.test(output ?? '')
}

/**
 * A base ref that does not resolve to a commit in THIS repo. HIGH fix: a
 * single --base ref applied to both repos vacuously PASSes whichever repo it
 * does not resolve in (gitleaks prints "fatal: ambiguous argument ...
 * unknown revision", reports "0 commits scanned", and exits 0) — proven with
 * a synthetic PEM committed in a StuRaOS scratch clone: --base main gave
 * [PASS] secret-scan on the StuRaOS clone with the key still in the scanned range,
 * because the kernel's default branch is main and StuRaOS's is master.
 */
export function baseRefResolves(repoPath, ref) {
  try {
    execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', `${ref}^{commit}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Run the gitleaks arm for one repo. A missing binary is detected up front
 * (via `gitleaks version`) so it is reported as its own reason rather than
 * folded into "leaks found".
 */
export function runGitleaksArm(repoLabel, repoPath, base, { runFn = run, verifyBaseRefFn = baseRefResolves } = {}) {
  const absRepoPath = resolve(repoPath)
  let binaryPresent = true
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' })
  } catch {
    binaryPresent = false
  }
  if (!binaryPresent) {
    return {
      arm: 'secret-scan',
      repo: repoLabel,
      status: 'FAIL',
      reason: 'gitleaks binary not found on PATH — a missing scanner is a failure, never a skip',
    }
  }

  if (base) {
    // Refuse a ref that could carry an option or a shell payload before it
    // reaches git or gitleaks at all (see isSafeRef).
    if (!isSafeRef(base)) {
      return {
        arm: 'secret-scan',
        repo: repoLabel,
        status: 'FAIL',
        reason: `base ref ${JSON.stringify(base)} is not a plain ref name (whitespace, a leading '-', '..' or shell metacharacters) — refused`,
      }
    }
    // Fail closed on an undefined range instead of vacuously scanning zero
    // commits — see baseRefResolves' header.
    if (!verifyBaseRefFn(absRepoPath, base)) {
      return {
        arm: 'secret-scan',
        repo: repoLabel,
        status: 'FAIL',
        reason: `base ref '${base}' does not resolve to a commit in ${repoLabel} — refusing to scan an undefined range rather than vacuously pass`,
      }
    }
    const command = gitleaksCommand(base)
    const { exitCode, output, timedOut, spawnError } = runFn(command, absRepoPath, { timeoutMs: 180_000 })
    if (spawnError) return { arm: 'secret-scan', repo: repoLabel, status: 'FAIL', reason: `could not run gitleaks: ${spawnError.message}` }
    if (timedOut) return { arm: 'secret-scan', repo: repoLabel, status: 'FAIL', reason: 'gitleaks timed out' }
    if (hasFatalLog(output)) {
      return { arm: 'secret-scan', repo: repoLabel, status: 'FAIL', reason: 'gitleaks logged an ERR/FTL line despite its exit code — treated as a failure', output }
    }
    return {
      arm: 'secret-scan',
      repo: repoLabel,
      status: exitCode === 0 ? 'PASS' : 'FAIL',
      reason: exitCode === 0 ? undefined : 'gitleaks found a leak in the diff (see output)',
      output,
    }
  }

  // Whole-tree mode: run, then filter the report to git-tracked files only.
  // A private, freshly created directory (mkdtemp, mode 0700 on POSIX), not
  // a predictable name in the shared tmpdir that another local user could
  // pre-create as a directory or symlink.
  const reportDir = mkdtempSync(join(tmpdir(), 'ci-local-gitleaks-'))
  const reportPath = join(reportDir, 'report.json')
  const command = gitleaksCommand(undefined, reportPath)
  const { exitCode, output, timedOut, spawnError } = runFn(command, absRepoPath, { timeoutMs: 180_000 })
  const cleanup = () => {
    try {
      rmSync(reportDir, { recursive: true, force: true })
    } catch {
      /* best effort cleanup */
    }
  }
  if (spawnError) {
    cleanup()
    return { arm: 'secret-scan', repo: repoLabel, status: 'FAIL', reason: `could not run gitleaks: ${spawnError.message}` }
  }
  if (timedOut) {
    cleanup()
    return { arm: 'secret-scan', repo: repoLabel, status: 'FAIL', reason: 'gitleaks timed out' }
  }
  // HIGH fix: dir mode runs with --exit-code 0, so a non-zero exit can ONLY
  // mean gitleaks itself errored (bad config, bad path, ...) — never "leaks
  // found" (that is neutralized by --exit-code 0) and never "clean". The
  // previous version ignored exitCode entirely in this branch.
  if (exitCode !== 0) {
    cleanup()
    return {
      arm: 'secret-scan',
      repo: repoLabel,
      status: 'FAIL',
      reason: `gitleaks exited ${exitCode} running a whole-tree scan of ${repoLabel} (dir mode uses --exit-code 0, so any non-zero exit means the scanner did not run to completion — see output)`,
      output,
    }
  }
  if (hasFatalLog(output)) {
    cleanup()
    return { arm: 'secret-scan', repo: repoLabel, status: 'FAIL', reason: 'gitleaks logged an ERR/FTL line despite exiting 0 — treated as a failure', output }
  }

  let rawFindings
  try {
    rawFindings = readGitleaksReport(reportPath)
  } catch (err) {
    return { arm: 'secret-scan', repo: repoLabel, status: 'FAIL', reason: `could not read gitleaks report: ${err.message}`, output }
  } finally {
    cleanup()
  }

  let tracked
  try {
    tracked = new Set(trackedFiles(absRepoPath))
  } catch (err) {
    return { arm: 'secret-scan', repo: repoLabel, status: 'FAIL', reason: `could not list tracked files: ${err.message}` }
  }
  const trackedFindings = rawFindings.filter((f) => {
    const rawFile = f.File ?? ''
    // Since gitleaksCommand runs `dir "."` with cwd=absRepoPath (the HIGH
    // allowlist fix above), gitleaks reports `File` already REPO-RELATIVE
    // (e.g. "fixture.pem"), not absolute. path.relative() on a relative
    // input resolves it against process.cwd() instead — the wrong base —
    // which silently un-matched every real finding against `tracked` and
    // made this arm PASS with leaks still in the report. Only resolve
    // against absRepoPath when gitleaks handed back an absolute path.
    const rel = (isAbsolute(rawFile) ? relative(absRepoPath, rawFile) : rawFile).split('\\').join('/')
    return tracked.has(rel)
  })

  return {
    arm: 'secret-scan',
    repo: repoLabel,
    status: trackedFindings.length === 0 ? 'PASS' : 'FAIL',
    reason:
      trackedFindings.length === 0
        ? undefined
        : `gitleaks found ${trackedFindings.length} leak(s) in tracked files (of ${rawFindings.length} raw match(es) incl. untracked)`,
    output,
  }
}

// ---------------------------------------------------------------------------
// Arm 2 — known-secrets (kernel-ported), on both repos
// ---------------------------------------------------------------------------

/**
 * @param denylistPath  optional path to a JSON {digest: note} file, merged
 *                      onto the kernel's own (empty) KNOWN_COMPROMISED via
 *                      known-secrets.mjs's loadDenylistFile. This is the
 *                      injection point that lets guards.mjs's entry point be
 *                      proven RED on a seeded digest (§7 gate efficacy (a))
 *                      without editing known-secrets.mjs's source — the
 *                      kernel starts with zero incidents, so without this
 *                      the arm could only ever be unit-tested directly.
 */
export function runKnownSecretsArm(repoLabel, repoPath, { denylistPath } = {}) {
  try {
    const denylist = loadDenylistFile(denylistPath)
    const { findings, scanned } = knownSecretsScanRepo(repoPath, denylist)
    return {
      arm: 'known-secrets',
      repo: repoLabel,
      status: findings.length === 0 ? 'PASS' : 'FAIL',
      reason: findings.length === 0 ? undefined : `${findings.length} known-compromised digest match(es)`,
      scanned,
    }
  } catch (err) {
    return { arm: 'known-secrets', repo: repoLabel, status: 'FAIL', reason: `could not scan: ${err.message}` }
  }
}

/**
 * StuRaOS's OWN `scripts/check-no-known-secrets.mjs`, run against the
 * StuRaOS path directly (same subprocess pattern as cve-floor/
 * overrides-drift: its own test first, then the guard). HIGH fix: the
 * kernel-ported `known-secrets.mjs` arm above can never fail in practice
 * (the kernel's KNOWN_COMPROMISED starts empty, and guards.mjs had no CLI
 * input to seed one), which made it strictly WEAKER than StuRaOS's own
 * script — StuRaOS carries 2 real incident digests that this arm would
 * otherwise silently drop the day guards.mjs became StuRaOS's own gate too.
 * Running StuRaOS's native script here, rather than only the kernel-ported
 * copy, is what keeps both incidents covered without the kernel importing
 * from the product (the open-core boundary §5 Q2 exists to protect).
 */
export function runVerticalNativeKnownSecretsArm(sturaosPath, { runFn = run } = {}) {
  return runScriptArm('known-secrets-vertical-native', 'vertical', resolve(sturaosPath), runFn, [
    { argv: [NODE, '--test', '--test-reporter=tap', 'scripts/check-no-known-secrets.test.mjs'], tap: true },
    { argv: [NODE, 'scripts/check-no-known-secrets.mjs'] },
  ])
}

/**
 * Shared shape of the subprocess arms (native known-secrets, cve-floor,
 * overrides-drift): the script's own test first, then the guard, as argv
 * steps with no shell (see runSteps).
 */
function runScriptArm(arm, repo, cwd, runFn, steps) {
  const { exitCode, output, timedOut, spawnError, reason } = runSteps(steps, cwd, runFn, { timeoutMs: 60_000 })
  if (spawnError) return { arm, repo, status: 'FAIL', reason: `could not run: ${spawnError.message}`, output }
  if (timedOut) return { arm, repo, status: 'FAIL', reason: 'timed out', output }
  if (exitCode === 0) return { arm, repo, status: 'PASS', output }
  const script = steps[steps.length - 1].argv[1]
  return { arm, repo, status: 'FAIL', reason: reason ?? `${script} (or its own test) failed — see output`, output }
}

// ---------------------------------------------------------------------------
// Arm 3 — kernel CVE-floor guard
// ---------------------------------------------------------------------------

export function runCveFloorArm(kernelPath, { runFn = run } = {}) {
  // --test-reporter=tap: recent `node --test` versions default to the
  // human-facing "spec" reporter even when stdout is not a TTY (observed on
  // the installed Node here), so lib/parse-output.mjs's TAP "# tests"
  // regex never matches unless a reporter is forced. This affects only
  // pass/fail correctness of the composite parse (parseCounts('guard', ...)
  // still falls back to the bare exit-code arm without it), but forcing TAP
  // keeps the declared-vs-collected check meaningful for every node-test
  // suite this package invokes.
  return runScriptArm('cve-floor', 'kernel', resolve(kernelPath), runFn, [
    { argv: [NODE, '--test', '--test-reporter=tap', 'scripts/check-cve-floors.test.mjs'], tap: true },
    { argv: [NODE, 'scripts/check-cve-floors.mjs'] },
  ])
}

// ---------------------------------------------------------------------------
// Arm 4 — StuRaOS overrides-drift guard, pointed at the KERNEL PATH
// ---------------------------------------------------------------------------

export function runOverridesDriftArm(sturaosPath, kernelPath, { runFn = run } = {}) {
  // Absolute, so the vertical cwd never re-resolves a relative kernel path,
  // and passed as its own argv element, never spliced into a shell string.
  const kernelWorkspace = join(resolve(kernelPath), 'pnpm-workspace.yaml')
  return runScriptArm('overrides-drift', 'vertical', resolve(sturaosPath), runFn, [
    { argv: [NODE, '--test', '--test-reporter=tap', 'scripts/check-overrides-drift.test.mjs'], tap: true },
    { argv: [NODE, 'scripts/check-overrides-drift.mjs', '--kernel', kernelWorkspace] },
  ])
}

// ---------------------------------------------------------------------------
// Arm 5 — runner-policy, both repos
// ---------------------------------------------------------------------------

export function runRunnerPolicyArm(kernelPath, sturaosPath, waiversPath) {
  const waivers = loadWaivers(waiversPath)
  const today = todayIso()
  const results = []
  const waived = []
  for (const [label, path] of [
    ['kernel', kernelPath],
    ['vertical', sturaosPath],
  ]) {
    // repoLabel is REQUIRED here (evaluateRepo has no default): a waiver is
    // {repo, file}, never {file} alone, so a waiver committed for one repo's
    // deploy.yml can never silently cover the other repo's same-named file.
    const perFile = runnerPolicyEvaluateRepo(label, path, waivers, today)
    for (const entry of perFile) {
      // Waiver use is reported in the arm result (not just console output),
      // so the dated JSON shows it too — an ever-growing waiver list must
      // leave a trace, never a bare PASS with an empty findings array. A
      // waiver mutes only the finding ids it covers; the rest still fail.
      if (entry.waivedFindings?.length > 0) {
        waived.push({ repo: label, path: entry.path, owner: entry.waiver.owner, expiresOn: entry.waiver.expiresOn, findings: entry.waivedFindings.map((f) => f.id) })
      }
      if (!entry.waived) results.push({ repo: label, path: entry.path, findings: entry.findings })
    }
  }
  return {
    arm: 'runner-policy',
    repo: 'both',
    status: results.length === 0 ? 'PASS' : 'FAIL',
    reason: results.length === 0 ? undefined : results.map((r) => `${r.repo}/${r.path}`).join(', '),
    findings: results,
    waived,
  }
}

// ---------------------------------------------------------------------------
// --image-build — TASK-012 §5 Q5 default: "the image-build job" is the
// existing `docker-build` jobs, which stay beside this file unchanged. This
// flag is purely informational (it never runs docker, never gates anything)
// — it only lists the Dockerfiles those jobs would build, so a re-enabled
// pipeline (or an operator) can see the surface at a glance.
// ---------------------------------------------------------------------------

/**
 * `<date>T<hhmmss>Z-<kernelShortSha>-<sturaosShortSha>-guards.json` — a NEW
 * name every run (to the second), naming both tips, so a watch-RED-then-
 * GREEN sequence never overwrites its own RED record (MEDIUM fix: the old
 * `<date>-guards.json` name collided on every same-day re-run, and `--out`
 * was optional at all, so the README's own one-line call recorded nothing).
 */
export function guardsResultFileName(now, kernelShortSha, sturaosShortSha) {
  const date = now.toISOString().slice(0, 10)
  const hhmmss = now.toISOString().slice(11, 19).replace(/:/g, '')
  return `${date}T${hhmmss}Z-${kernelShortSha}-${sturaosShortSha}-guards.json`
}

/** Every Dockerfile (bare `Dockerfile`, or `Dockerfile.*`) under `repoRoot`, repo-relative POSIX paths, sorted. */
export function listDockerfiles(repoRoot) {
  return walkFiles(repoRoot)
    .filter((f) => /(^|\/)Dockerfile(\..+)?$/.test(f))
    .sort()
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * HIGH fix: a single `base` ref used to be applied to both repos. When it
 * does not resolve in one of them (the kernel's default branch is `main`,
 * StuRaOS's is `master`), that repo's gitleaks arm scanned an empty range
 * and vacuously PASSed. `kernelBase`/`sturaosBase` let a caller name a
 * per-repo ref; either falls back to the shared `base` when not given, and
 * `runGitleaksArm` independently verifies whichever ref it ends up with
 * resolves in ITS OWN repo before scanning.
 */
export function runAllArms({ kernelPath, sturaosPath, base, kernelBase, sturaosBase, waiversPath, denylistPath, runFn = run }) {
  const arms = []
  arms.push(runGitleaksArm('kernel', kernelPath, kernelBase ?? base, { runFn }))
  arms.push(runGitleaksArm('vertical', sturaosPath, sturaosBase ?? base, { runFn }))
  arms.push(runKnownSecretsArm('kernel', kernelPath, { denylistPath }))
  arms.push(runKnownSecretsArm('vertical', sturaosPath, { denylistPath }))
  // HIGH fix: also run StuRaOS's OWN check-no-known-secrets.mjs (its 2 real
  // incident digests) rather than relying solely on the kernel-ported copy
  // above, which the kernel's own (empty) KNOWN_COMPROMISED can never fail —
  // see runVerticalNativeKnownSecretsArm's header.
  arms.push(runVerticalNativeKnownSecretsArm(sturaosPath, { runFn }))
  arms.push(runCveFloorArm(kernelPath, { runFn }))
  arms.push(runOverridesDriftArm(sturaosPath, kernelPath, { runFn }))
  arms.push(runRunnerPolicyArm(kernelPath, sturaosPath, waiversPath))
  const overallExit = arms.some((a) => a.status === 'FAIL') ? 1 : 0
  return { arms, overallExit }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i === -1 ? null : argv[i + 1]
}

/**
 * Where the dated JSON goes when no --out is given: $CI_LOCAL_GUARDS_OUT if
 * set (a re-enabled pipeline points it at its artifact dir), otherwise
 * <os tmpdir>/ci-local-guards-results. Never inside either repo: a result
 * file there would make the tree dirty (snapshot.mjs refuses a dirty tree)
 * and would put run records into the kernel (§5 Q3).
 */
export function defaultGuardsOutDir() {
  return process.env.CI_LOCAL_GUARDS_OUT || join(tmpdir(), 'ci-local-guards-results')
}

/** HEAD's short SHA for the result filename, or 'unknown' if `path` is not (yet) a git repo. */
function tryHeadShortSha(path) {
  try {
    return headInfo(path).shortSha
  } catch {
    return 'unknown'
  }
}

export function main(argv = process.argv.slice(2)) {
  const kernelPath = argValue(argv, '--kernel')
  const sturaosPath = argValue(argv, '--vertical')
  const base = argValue(argv, '--base') ?? undefined
  const kernelBase = argValue(argv, '--kernel-base') ?? undefined
  const sturaosBase = argValue(argv, '--vertical-base') ?? undefined
  const waiversPath = argValue(argv, '--waivers') ?? join(HERE, 'waivers.json')
  const denylistPath = argValue(argv, '--known-secrets-denylist') ?? undefined
  // MEDIUM fix: --out used to be optional, and the README's own one-line
  // call omitted it, so the acceptance item "guards.mjs ... writes a dated
  // JSON result" was unconditionally true only when a caller remembered to
  // pass --out. Defaulting it (rather than making it a hard requirement,
  // which would break that one-line call) means a dated record is ALWAYS
  // written.
  const outDir = argValue(argv, '--out') ?? defaultGuardsOutDir()
  const imageBuild = argv.includes('--image-build')

  if (!kernelPath || !sturaosPath) {
    console.error('guards: --kernel <path> and --vertical <path> are both required')
    process.exitCode = 1
    return
  }

  if (imageBuild) {
    console.log('\nci-local --image-build — Dockerfiles the existing docker-build jobs build (informational only, no gate effect):\n')
    for (const [label, path] of [
      ['kernel', kernelPath],
      ['vertical', sturaosPath],
    ]) {
      const files = listDockerfiles(path)
      console.log(`  ${label}:`)
      if (files.length === 0) console.log('    (none found)')
      for (const f of files) console.log(`    ${f}`)
    }
    console.log('')
    process.exitCode = 0
    return
  }

  const { arms, overallExit } = runAllArms({ kernelPath, sturaosPath, base, kernelBase, sturaosBase, waiversPath, denylistPath })

  console.log(`\nci-local guards — ${new Date().toISOString()}\n`)
  for (const arm of arms) {
    console.log(`  [${arm.status}] ${arm.arm} (${arm.repo})${arm.reason ? ` — ${arm.reason}` : ''}`)
  }
  console.log(`\nguards: overall ${overallExit === 0 ? 'PASS' : 'FAIL'} (${arms.filter((a) => a.status === 'FAIL').length}/${arms.length} arm(s) failed)\n`)

  {
    mkdirSync(outDir, { recursive: true })
    const now = new Date()
    // Best-effort SHAs for the filename only — a scratch path that is not a
    // real git repo (or mid-teardown) must never stop the dated result from
    // being written; the JSON body's own `kernelPath`/`sturaosPath` remain
    // the authoritative identification either way.
    const kernelShortSha = tryHeadShortSha(kernelPath)
    const sturaosShortSha = tryHeadShortSha(sturaosPath)
    const fileName = guardsResultFileName(now, kernelShortSha, sturaosShortSha)
    const path = join(outDir, fileName)
    writeFileSync(
      path,
      JSON.stringify(
        { date: now.toISOString().slice(0, 10), timestamp: now.toISOString(), kernelPath, sturaosPath, kernelSha: kernelShortSha, sturaosSha: sturaosShortSha, base, kernelBase, sturaosBase, overallExit, arms },
        null,
        2,
      ),
    )
    console.log(`wrote ${path}`)
  }

  process.exitCode = overallExit
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('guards.mjs')) {
  main()
}
