#!/usr/bin/env node
// Tree guard: fails on any .github/workflows/*.yml that runs on a
// self-hosted runner, or that references a signing, age, SSH or deploy
// secret (TRD-364: "any CI runner used is ephemeral, holds no signing key,
// age key or deploy credential, and never runs on the operator's workstation
// or the pilot host").
//
//   node scripts/ci-local/runner-policy.mjs --repo <path> [--repo <path> ...] [--waivers <path>]
//   node scripts/ci-local/runner-policy.mjs --kernel <path> --vertical <path> [--waivers <path>]
//   node --test scripts/ci-local/runner-policy.test.mjs
//
// TASK-012 §5 Q1: this guard is RED on today's kernel tree —
// .github/workflows/deploy.yml passes DEPLOY_SSH_KEY/DEPLOY_HOST/
// DEPLOY_HOST_KEY to an Actions runner. Fixing deploy.yml is TASK-086's
// deploy-path work and .github/** is TASK-018's file ownership, so this unit
// applies the brief's default: a dated waiver naming only deploy.yml, owned
// by TASK-086, expiring when TASK-038 lands. An unwaived hit, or an expired
// waiver, still fails the guard — the waiver only mutes the ONE named file,
// and only until its expiry.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'

// HIGH fix (round 5): the previous regex denylist scanned raw text lines
// and failed OPEN on ordinary YAML a scanner should have no trouble with —
// a trailing comment on a plain-scalar `runs-on: self-hosted  # gpu box`
// slipped past its end-of-line anchor entirely, and a custom label
// (`runs-on: my-raspberry-pi`), a runner `group:`, a `${{ vars.* }}` /
// `${{ inputs.* }}` expression and a quoted key all returned NO finding.
// This file now parses each workflow structurally with `yaml` (already
// resolved in the lockfile — see package.json/pnpm-lock.yaml, no build
// script) and classifies every `jobs.*.runs-on` against an ALLOWLIST of
// GitHub-hosted runner labels, rather than denylisting known-bad ones:
// PASS only when a value resolves to one or more allowlisted labels;
// everything else — a custom label, a `group`/`labels` object, an
// unresolvable expression, a malformed job body, or a workflow that fails
// to parse at all — fails CLOSED.
//
// TASK-012-FU finding 2 (HIGH): both regexes were case-sensitive and
// literal-index only, but GitHub expressions ignore case in context and
// function names — `${{ toJson(secrets) }}`, `${{ SECRETS.DEPLOY_SSH_KEY }}`
// and `${{ secrets[format('DEPLOY_{0}','SSH_KEY')] }}` all returned NO
// finding. Both are now /i, a secret name is upper-cased for its finding id
// (GitHub secret names are case-insensitive), and inside an expression any
// `secrets[` whose index is not one quoted literal, or any use of the whole
// `secrets` context (bare, `secrets.*`, passed to a function), is its own
// fail-closed sensitive finding — see scanExpressionForSecrets.
const SECRET_REF_RE = /secrets\s*(?:\.\s*([A-Za-z0-9_]+)|\[\s*['"]([A-Za-z0-9_]+)['"]\s*\])/gi
const SECRETS_TOJSON_RE = /toJSON\s*\(\s*secrets\s*\)/i
const SECRETS_WORD_RE = /\bsecrets\b/gi
const EXPR_BODY_RE = /\$\{\{([\s\S]*?)\}\}/g
const WHOLE_CONTEXT_DETAIL = {
  'secrets-tojson': 'toJSON(secrets) serializes the entire secrets context — treated as sensitive, fail closed',
  'secrets-dynamic-index': 'secrets[<expression>] computes the secret name at run time, so it can name ANY secret — treated as sensitive, fail closed',
  'secrets-context': 'the whole secrets context is used (bare, secrets.*, or passed to a function), so it can carry ANY secret — treated as sensitive, fail closed',
}
// Bounded so a name that merely CONTAINS "age" (STAGE_ENV_NAME, MESSAGE_ID)
// never false-positives: AGE must stand alone between start/end and `_`.
const SENSITIVE_SECRET_NAME_RE = /DEPLOY|SIGN(ING)?|SSH|GPG|SOPS|COSIGN|KEYSTORE|PRIVATE_KEY|HOST_KEY|(?:^|_)AGE(?:_|$)/i

// GitHub-hosted runner labels only: ubuntu-latest/windows-latest/macos-latest,
// their dated variants (ubuntu-22.04, windows-2022, macos-14) and GitHub's own
// larger-runner suffixes (-{4,8,16,32,64}-cores on ubuntu/windows, -large/
// -xlarge on macos). Anything that is not one of these — a custom label, a
// runner-group name, an unresolved expression — is NOT github-hosted as far
// as this guard can prove, so `isSafeRunsOn` below fails closed on it.
const GITHUB_HOSTED_LABEL_RE =
  /^ubuntu-(?:latest|\d{2}\.\d{2})(?:-(?:4|8|16|32|64)-cores)?$|^windows-(?:latest|\d{4})(?:-(?:4|8|16|32|64)-cores)?$|^macos-(?:latest|\d{1,2})(?:-(?:large|xlarge))?$/i
const MATRIX_EXPR_RE = /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/
const ANY_EXPR_RE = /\$\{\{/

function isHostedLabel(value) {
  return typeof value === 'string' && GITHUB_HOSTED_LABEL_RE.test(value.trim())
}

function isPlainMapping(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Values of every property of `obj` whose name equals `key` ignoring case (GitHub expression property access is case-insensitive). */
function valuesForKey(obj, key) {
  const lower = key.toLowerCase()
  return Object.entries(obj)
    .filter(([k]) => k.toLowerCase() === lower)
    .map(([, v]) => v)
}

/**
 * Every value `matrix.<key>` can take in one job, or undefined when this
 * file cannot prove the full set (fail closed).
 *
 * TASK-012-FU finding 1 (HIGH): this used to read only `matrix[key]`, but
 * GitHub ADDS a combination for every `strategy.matrix.include` entry, so
 * `os: [ubuntu-latest]` + `include: [{os: self-hosted}]` scheduled a
 * self-hosted job while the guard returned no finding. Now:
 *  - the matrix itself must be a mapping (an expression is unresolvable);
 *  - a base `matrix.<key>` must be a list (each element is one value);
 *  - `include` and `exclude`, when present, must each be a list of
 *    mappings — an expression or any other shape fails closed;
 *  - every include entry that names the key adds its value to the set.
 * `exclude` can only remove combinations, so its entries add nothing, but a
 * shape this file cannot read still fails closed. Keys match ignoring case.
 */
function resolveMatrixValues(jobBody, key) {
  const matrix = isPlainMapping(jobBody) ? jobBody.strategy?.matrix : undefined
  if (!isPlainMapping(matrix)) return undefined
  const values = []
  for (const [k, v] of Object.entries(matrix)) {
    const lower = k.toLowerCase()
    if (lower === 'include' || lower === 'exclude') {
      if (!Array.isArray(v) || !v.every(isPlainMapping)) return undefined
      if (lower === 'include') for (const entry of v) values.push(...valuesForKey(entry, key))
      continue
    }
    if (lower !== key.toLowerCase()) continue
    if (!Array.isArray(v)) return undefined
    values.push(...v)
  }
  return values
}

/**
 * True only when `value` (a job's `runs-on`, or one element of it) resolves
 * PROVABLY to GitHub-hosted runner(s). Anything this cannot prove — an
 * object (`group`/`labels` form), a non-matrix expression, an unresolved or
 * partially-resolved matrix reference, a number/null/other type, or a plain
 * string that is not an allowlisted label — returns false (fail closed).
 */
export function isSafeRunsOn(value, jobBody) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    const matrixMatch = trimmed.match(MATRIX_EXPR_RE)
    if (matrixMatch) {
      const resolved = resolveMatrixValues(jobBody, matrixMatch[1])
      // Every value the matrix (base list AND include entries) declares for
      // this key must itself resolve to a hosted label, or this fails
      // closed — an unresolvable matrix shape (undefined) or an empty set
      // counts as unresolvable rather than as an empty (vacuous) PASS. Each
      // value is classified WITHOUT the job body, so a value that itself
      // references `matrix.*` fails closed instead of recursing forever.
      return Array.isArray(resolved) && resolved.length > 0 && resolved.every((v) => isSafeRunsOn(v, undefined))
    }
    if (ANY_EXPR_RE.test(trimmed)) return false // ${{ vars.* }}, ${{ inputs.* }}, etc. — cannot classify, fail closed
    return isHostedLabel(trimmed)
  }
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((v) => isSafeRunsOn(v, jobBody))
  }
  // An object (`{group: ..., labels: ...}`), null, a number, a boolean — none
  // of these is "a string or list of strings you can classify" as hosted.
  return false
}

/** Every string LEAF value in a parsed workflow tree (never keys, never comments — those are not value nodes at all once parsed). */
function collectStrings(node, out = []) {
  if (typeof node === 'string') out.push(node)
  else if (Array.isArray(node)) for (const v of node) collectStrings(v, out)
  else if (node && typeof node === 'object') for (const v of Object.values(node)) collectStrings(v, out)
  return out
}

/**
 * Every expression body GitHub evaluates in a parsed workflow tree: each
 * `${{ ... }}` segment of a string leaf, plus the whole value of an `if:`
 * key that has no `${{` (GitHub evaluates a bare `if:` as an expression).
 * Plain `run:` text outside `${{ }}` is shell, not an expression, so it is
 * not returned here — the whole-context/dynamic-index checks only look at
 * what GitHub itself will evaluate.
 */
function collectExpressionBodies(node, key, out = []) {
  if (typeof node === 'string') {
    let any = false
    for (const m of node.matchAll(EXPR_BODY_RE)) {
      any = true
      out.push(m[1])
    }
    if (!any && typeof key === 'string' && key.toLowerCase() === 'if') out.push(node)
  } else if (Array.isArray(node)) {
    for (const v of node) collectExpressionBodies(v, undefined, out)
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) collectExpressionBodies(v, k, out)
  }
  return out
}

/**
 * Whole-context and computed-index uses of `secrets` inside ONE expression
 * body, as finding ids: 'secrets-tojson' (toJson(secrets)),
 * 'secrets-dynamic-index' (secrets[<anything but one quoted literal>]) or
 * 'secrets-context' (the whole context used any other way — bare, passed to
 * a function, `secrets.*`). A named access (`secrets.NAME`,
 * `secrets['NAME']`) is left to SECRET_REF_RE. A property that merely has
 * the name `secrets` on another context (`inputs.secrets`) is not the
 * secrets context and is skipped. Case-insensitive throughout.
 */
export function scanExpressionForSecrets(body) {
  const out = []
  for (const m of body.matchAll(SECRETS_WORD_RE)) {
    const before = body.slice(0, m.index)
    if (/\.\s*$/.test(before)) continue // `<ctx>.secrets` — a property of something else
    const rest = body.slice(m.index + m[0].length)
    if (/^\s*\.\s*[A-Za-z_][A-Za-z0-9_]*/.test(rest)) continue // secrets.NAME
    if (/^\s*\[\s*(['"])[A-Za-z0-9_]+\1\s*\]/.test(rest)) continue // secrets['NAME']
    if (/^\s*\[/.test(rest)) {
      out.push('secrets-dynamic-index')
      continue
    }
    out.push(/toJSON\s*\(\s*$/i.test(before) && /^\s*\)/.test(rest) ? 'secrets-tojson' : 'secrets-context')
  }
  return out
}

/**
 * True if `repoRoot` exists on disk as a directory. MEDIUM fix:
 * `listWorkflowFiles` used to catch EVERY `readdirSync` error (including
 * `repoRoot` itself not existing) and return `[]`, which `evaluateRepo` then
 * read as "no workflows" — a clean, vacuous PASS. Proven: `node
 * runner-policy.mjs --repo does-not-exist` printed "OK across 1 repo(s) - 0
 * unwaived findings" and exited 0. A missing (or non-directory) repo root
 * must be reported as its own failure instead, never silently folded into
 * "nothing to check here".
 */
export function repoRootExists(repoRoot) {
  try {
    return statSync(repoRoot).isDirectory()
  } catch {
    return false
  }
}

/**
 * Every `.github/workflows/*.yml` (and `.yaml`) file, repo-relative POSIX
 * paths. Only ENOENT on the `.github/workflows` directory itself is treated
 * as "no workflows" (a real, valid state for a repo root that legitimately
 * has none) — every other `readdirSync` error (permission denied, a file
 * where a directory was expected, …) propagates, since it means something
 * other than "no workflows" is wrong and must not be swallowed into a PASS.
 * Callers that need to tell "repo root missing" apart from "repo root valid,
 * no workflows dir" call `repoRootExists` first (see `evaluateRepo`).
 */
export function listWorkflowFiles(repoRoot) {
  const dir = join(repoRoot, '.github', 'workflows')
  let entries
  try {
    entries = readdirSync(dir)
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  return entries
    .filter((f) => /\.ya?ml$/i.test(f))
    .sort()
    .map((f) => `.github/workflows/${f}`)
}

/**
 * Findings in one workflow file's text: `{ rule, detail }[]`.
 * rule is 'self-hosted', 'sensitive-secret' or 'unparseable'.
 *
 * Structural, not line-oriented: the file is parsed with `yaml` and every
 * check below walks the parsed tree. A workflow that fails to parse is its
 * own (fail-closed) finding and nothing further is checked — an unparseable
 * file is never a vacuous PASS.
 */
export function checkWorkflowText(text) {
  const findings = []
  let doc
  try {
    doc = parseDocument(text, { strict: true })
  } catch (err) {
    return [{ rule: 'unparseable', id: 'unparseable', detail: `workflow YAML failed to parse (${err.message}) — failing closed` }]
  }
  if (doc.errors.length > 0) {
    return [
      {
        rule: 'unparseable',
        id: 'unparseable',
        detail: `workflow YAML failed to parse (${doc.errors.map((e) => e.message.split('\n')[0]).join('; ')}) — failing closed`,
      },
    ]
  }
  let parsed
  try {
    parsed = doc.toJS()
  } catch (err) {
    return [{ rule: 'unparseable', id: 'unparseable', detail: `workflow YAML could not be resolved (${err.message}) — failing closed` }]
  }

  const jobsObj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.jobs : undefined
  const reasons = []
  if (jobsObj !== undefined && (jobsObj === null || typeof jobsObj !== 'object' || Array.isArray(jobsObj))) {
    reasons.push(`'jobs' is not a mapping (${JSON.stringify(jobsObj)}) — failing closed`)
  } else if (jobsObj) {
    for (const [jobName, jobBody] of Object.entries(jobsObj)) {
      if (jobBody === null || typeof jobBody !== 'object' || Array.isArray(jobBody)) {
        reasons.push(`job '${jobName}': body is not a mapping — failing closed`)
        continue
      }
      if (!('runs-on' in jobBody)) continue // no runner declared here (e.g. a reusable-workflow `uses:` call)
      if (!isSafeRunsOn(jobBody['runs-on'], jobBody)) {
        reasons.push(`job '${jobName}': runs-on ${JSON.stringify(jobBody['runs-on'])} does not resolve to a known GitHub-hosted runner — failing closed`)
      }
    }
  }
  if (reasons.length > 0) {
    findings.push({ rule: 'self-hosted', id: 'self-hosted', detail: reasons.join('; ') })
  }

  // Secret references: scan every parsed STRING VALUE (never a comment,
  // never a key), so a hit can only come from something the workflow will
  // actually evaluate at run time.
  const seen = new Set()
  for (const s of collectStrings(parsed)) {
    for (const m of s.matchAll(SECRET_REF_RE)) {
      // GitHub secret names are case-insensitive: one id per name, however spelled.
      const name = (m[1] ?? m[2]).toUpperCase()
      if (seen.has(`secret:${name}`)) continue
      if (SENSITIVE_SECRET_NAME_RE.test(name)) {
        seen.add(`secret:${name}`)
        findings.push({ rule: 'sensitive-secret', id: `secret:${name}`, detail: `references secrets.${name} (signing/age/SSH/deploy)` })
      }
    }
    if (SECRETS_TOJSON_RE.test(s)) addWholeContext('secrets-tojson')
  }
  for (const body of collectExpressionBodies(parsed)) {
    for (const id of scanExpressionForSecrets(body)) addWholeContext(id)
  }
  function addWholeContext(id) {
    if (seen.has(id)) return
    seen.add(id)
    findings.push({ rule: 'sensitive-secret', id, detail: WHOLE_CONTEXT_DETAIL[id] })
  }
  // `secrets: inherit` is a structural key/value pair on a reusable-workflow
  // CALL job, not a text pattern — checked directly against the parsed job
  // bodies rather than re-scanning strings for the substring "inherit".
  if (jobsObj && typeof jobsObj === 'object' && !Array.isArray(jobsObj)) {
    for (const jobBody of Object.values(jobsObj)) {
      if (jobBody && typeof jobBody === 'object' && jobBody.secrets === 'inherit' && !seen.has('secrets-inherit')) {
        seen.add('secrets-inherit')
        findings.push({ rule: 'sensitive-secret', id: 'secrets-inherit', detail: 'secrets: inherit passes every secret to a reusable workflow — treated as sensitive, fail closed' })
      }
    }
  }
  return findings
}

/** Today (or an injected clock) as YYYY-MM-DD, for waiver-expiry comparison. */
export function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10)
}

/**
 * @param waivers      [{repo, file, owner, expiresOn, reason}]. `repo` is
 *                     matched EXACTLY (e.g. "kernel" or "vertical") and
 *                     `file` against the workflow's basename (e.g.
 *                     "deploy.yml"). A waiver missing `repo` never matches —
 *                     see the header comment on why repo-scoping matters.
 * @param repoLabel    the repo this evaluation is for.
 * @param fileBasename the workflow file's basename.
 * @returns the active (non-expired) waiver for `repoLabel`/`fileBasename`, or undefined.
 */
export function activeWaiver(waivers, repoLabel, fileBasename, today) {
  const w = waivers.find((x) => x.repo === repoLabel && x.file === fileBasename)
  if (!w) return undefined
  if (waiverProblem(w)) return undefined // malformed — fails closed, never an open-ended waiver
  if (w.expiresOn < today) return undefined // expired — the guard must still fail
  return w
}

/**
 * Why a waiver entry is unusable, or undefined when it is well-formed.
 * MEDIUM fix: `undefined < '2026-09-25'` is false, so an entry with no
 * expiresOn (or a non-ISO one like '2026-9-1', which also compares
 * wrongly as a string) used to stay live forever. And a waiver used to mute
 * EVERY finding in its file, so a later `runs-on: self-hosted` or
 * SIGNING_KEY added to the waived file passed silently. A waiver must now
 * name a real calendar date and the exact finding ids it covers (`covers`,
 * e.g. "secret:DEPLOY_SSH_KEY"); anything else in the file still fails.
 */
export function waiverProblem(w) {
  const m = typeof w.expiresOn === 'string' ? w.expiresOn.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null
  if (!m) return `expiresOn ${JSON.stringify(w.expiresOn)} is not a YYYY-MM-DD date`
  const d = new Date(`${w.expiresOn}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== w.expiresOn) return `expiresOn '${w.expiresOn}' is not a real calendar date`
  if (!Array.isArray(w.covers) || w.covers.length === 0 || !w.covers.every((c) => typeof c === 'string' && c.length > 0)) {
    return 'covers must list the exact finding ids this waiver mutes (e.g. "secret:DEPLOY_SSH_KEY")'
  }
  return undefined
}

/**
 * Evaluate one repo. Returns `{ path, findings }[]` — one entry per workflow
 * file that has an unwaived (or waiver-expired) finding. A file fully covered
 * by a live waiver is omitted, but its waiver use is reported separately so
 * an ever-growing waiver list is visible (see `report()`).
 *
 * `repoLabel` scopes waiver matching (a waiver is `{repo, file}`, not
 * `{file}` alone) — a waiver committed for one repo's `deploy.yml` must
 * never silently cover the OTHER repo's same-named file. This is why
 * `repoLabel` is REQUIRED (no default): a caller that cannot name which repo
 * it is evaluating should not be evaluating waivers at all.
 */
export function evaluateRepo(repoLabel, repoRoot, waivers, today = todayIso()) {
  // MEDIUM fix: a repo root that does not exist (or is not a directory) is
  // its own failure, reported the same shape as any other unwaived finding —
  // never silently read as "no workflows found, PASS".
  if (!repoRootExists(repoRoot)) {
    return [
      {
        path: '(repo root)',
        findings: [
          {
            rule: 'invalid-repo',
            id: 'invalid-repo',
            detail: `repo root '${repoRoot}' does not exist (or is not a directory) — refusing to report a vacuous "no workflows" pass`,
          },
        ],
        waiver: undefined,
        waived: false,
        waivedFindings: [],
      },
    ]
  }
  const files = listWorkflowFiles(repoRoot)
  const perFile = []
  for (const relPath of files) {
    const basename = relPath.split('/').pop()
    const text = readFileSync(join(repoRoot, relPath), 'utf8')
    const findings = checkWorkflowText(text)
    if (findings.length === 0) continue
    const waiver = activeWaiver(waivers, repoLabel, basename, today)
    if (!waiver) {
      perFile.push({ path: relPath, findings, waiver: undefined, waived: false, waivedFindings: [] })
      continue
    }
    // A live waiver mutes only the finding ids it names. Anything else in
    // the same file — a new self-hosted runner, a new signing secret — is
    // still a failure (see waiverProblem).
    const covered = new Set(waiver.covers)
    const waivedFindings = findings.filter((f) => covered.has(f.id))
    const uncovered = findings.filter((f) => !covered.has(f.id))
    if (uncovered.length === 0) {
      perFile.push({ path: relPath, findings, waiver, waived: true, waivedFindings })
    } else {
      perFile.push({ path: relPath, findings: uncovered, waiver, waived: false, waivedFindings })
    }
  }
  return perFile
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argValues(argv, flag) {
  const out = []
  for (let i = 0; i < argv.length; i++) if (argv[i] === flag) out.push(argv[i + 1])
  return out
}
function argValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i === -1 ? null : argv[i + 1]
}

/**
 * LOW fix: a waivers.json that is valid JSON but not an array (e.g. `{}`)
 * used to parse without error and be returned as-is, and every caller
 * treats the result as an array (`waivers.find`, `.some`, spreading into
 * `evaluateRepo`'s loop) — an uncaught `TypeError` crashed guards.mjs's
 * runRunnerPolicyArm BEFORE the dated JSON result was ever written
 * (TASK-012 acceptance item 5: "any failing guard ... writes a dated
 * JSON result", which a crash defeats). A missing file (no `path`, or
 * ENOENT) is still the one case that legitimately means "no waivers" and
 * returns `[]`; every other failure — invalid JSON syntax, or valid JSON
 * that is not an array — now THROWS instead of being silently swallowed,
 * so callers (guards.mjs's runRunnerPolicyArm, this file's own `main`) can
 * turn it into an explicit, reported FAIL rather than a crash or a silent
 * "no waivers" that would have widened what counts as unwaived anyway.
 */
export function loadWaivers(path) {
  if (!path) return []
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  const parsed = JSON.parse(text)
  if (!Array.isArray(parsed)) {
    throw new Error(`waivers file '${path}' must be a JSON array, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`)
  }
  return parsed
}

export function main(argv = process.argv.slice(2)) {
  // { label, path }[] — `label` is what waivers.json's `repo` field matches
  // against. A bare --repo has no name of its own, so it is labelled by its
  // own path: distinct from every other repo (including another --repo), so
  // it can never accidentally share a waiver with one it is not.
  const repos = [
    ...argValues(argv, '--repo').map((path) => ({ label: path, path })),
    ...(argValue(argv, '--kernel') ? [{ label: 'kernel', path: argValue(argv, '--kernel') }] : []),
    ...(argValue(argv, '--vertical') ? [{ label: 'vertical', path: argValue(argv, '--vertical') }] : []),
  ]
  if (repos.length === 0) {
    console.error('runner-policy: no --repo (or --kernel/--vertical) given')
    process.exitCode = 1
    return
  }
  let waivers
  try {
    waivers = loadWaivers(argValue(argv, '--waivers'))
  } catch (err) {
    // LOW fix: a malformed --waivers file (bad JSON, or valid JSON that is
    // not an array) is a clean, reported failure — never an uncaught throw
    // that would exit this CLI with a raw stack trace and no dated-result
    // guarantee from a caller like guards.mjs.
    console.error(`runner-policy: could not load --waivers: ${err.message}`)
    process.exitCode = 1
    return
  }
  const today = todayIso()

  let failures = 0
  let waivedCount = 0
  for (const { label, path: repoRoot } of repos) {
    const perFile = evaluateRepo(label, repoRoot, waivers, today)
    for (const entry of perFile) {
      if (entry.waived) {
        waivedCount++
        console.log(
          `runner-policy: ${repoRoot}/${entry.path} — WAIVED (owner ${entry.waiver.owner}, expires ${entry.waiver.expiresOn}): ${entry.findings.map((f) => f.detail).join('; ')}`,
        )
        continue
      }
      failures++
      const expired = waivers.some((w) => w.repo === label && w.file === entry.path.split('/').pop() && w.expiresOn < today)
      console.error(`\nRUNNER-POLICY GUARD FAILED — ${repoRoot}/${entry.path}${expired ? ' (waiver EXPIRED)' : ''}:`)
      for (const f of entry.findings) console.error(`  [${f.rule}] ${f.detail}`)
    }
  }

  if (failures > 0) {
    console.error(`\nrunner-policy: ${failures} unwaived finding(s), ${waivedCount} waived.\n`)
    process.exitCode = 1
    return
  }
  console.log(`runner-policy: OK across ${repos.length} repo(s) — 0 unwaived findings, ${waivedCount} waived`)
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('runner-policy.mjs')) {
  main()
}
