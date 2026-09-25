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

// Inline forms only: a scalar (`runs-on: self-hosted`), an inline list
// (`runs-on: [self-hosted, ...]`) or an inline flow map
// (`runs-on: {labels: self-hosted}`) — all on the SAME line as `runs-on:`.
// Block forms (a YAML list or map on the following, more-indented lines) are
// not regex-shaped at all; `detectSelfHostedRunner` below handles those by
// scanning indentation instead of trying to extend this regex.
const SELF_HOSTED_INLINE_RE = /runs-on:\s*(\[[^\]]*\bself-hosted\b[^\]]*\]|\{[^}]*\bself-hosted\b[^}]*\}|['"]?self-hosted['"]?\s*$)/im
const MATRIX_RUNS_ON_RE = /runs-on:\s*\$\{\{\s*matrix\./i
const SECRET_REF_RE = /secrets(?:\.([A-Za-z0-9_]+)|\[\s*['"]([A-Za-z0-9_]+)['"]\s*\])/g
const SECRETS_TOJSON_RE = /toJSON\(\s*secrets\s*\)/
const SECRETS_INHERIT_RE = /secrets:\s*inherit\b/
// Bounded so a name that merely CONTAINS "age" (STAGE_ENV_NAME, MESSAGE_ID)
// never false-positives: AGE must stand alone between start/end and `_`.
const SENSITIVE_SECRET_NAME_RE = /DEPLOY|SIGN(ING)?|SSH|GPG|SOPS|COSIGN|KEYSTORE|PRIVATE_KEY|HOST_KEY|(?:^|_)AGE(?:_|$)/i

/**
 * `runs-on:` beyond the inline forms `SELF_HOSTED_INLINE_RE` already covers:
 *  - a YAML BLOCK list (`runs-on:` with no value, then indented `- item`
 *    lines below it) or a block flow map (indented `key: value` lines) —
 *    found by scanning lines more-indented than `runs-on:` itself, stopping
 *    at the first line that is not (dedent = end of this block).
 *  - a MATRIX-supplied runner (`runs-on: ${{ matrix.os }}`) — this file
 *    never resolves what matrix.os expands to at any given run, so it fails
 *    CLOSED: if the word `self-hosted` appears anywhere in the file (in
 *    practice, in that same job's `strategy.matrix` values), the runner is
 *    treated as possibly self-hosted.
 */
export function detectSelfHostedRunner(text) {
  if (SELF_HOSTED_INLINE_RE.test(text)) return true
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)runs-on:\s*(.*)$/)
    if (!m) continue
    const [, indentStr, rest] = m
    const indent = indentStr.length
    if (rest.trim() === '') {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '') continue
        const lineIndent = lines[j].match(/^(\s*)/)[1].length
        if (lineIndent <= indent) break
        if (/self-hosted/i.test(lines[j])) return true
      }
    } else if (MATRIX_RUNS_ON_RE.test(lines[i]) && /self-hosted/i.test(text)) {
      return true
    }
  }
  return false
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
 * rule is 'self-hosted' or 'sensitive-secret'.
 */
export function checkWorkflowText(text) {
  const findings = []
  if (detectSelfHostedRunner(text)) {
    findings.push({ rule: 'self-hosted', id: 'self-hosted', detail: 'runs-on names (or may resolve to) a self-hosted runner' })
  }
  const seen = new Set()
  for (const m of text.matchAll(SECRET_REF_RE)) {
    const name = m[1] ?? m[2]
    if (seen.has(name)) continue
    if (SENSITIVE_SECRET_NAME_RE.test(name)) {
      seen.add(name)
      findings.push({ rule: 'sensitive-secret', id: `secret:${name}`, detail: `references secrets.${name} (signing/age/SSH/deploy)` })
    }
  }
  if (SECRETS_TOJSON_RE.test(text)) {
    findings.push({ rule: 'sensitive-secret', id: 'secrets-tojson', detail: 'toJSON(secrets) serializes the entire secrets context — treated as sensitive, fail closed' })
  }
  if (SECRETS_INHERIT_RE.test(text)) {
    findings.push({ rule: 'sensitive-secret', id: 'secrets-inherit', detail: 'secrets: inherit passes every secret to a reusable workflow — treated as sensitive, fail closed' })
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

export function loadWaivers(path) {
  if (!path) return []
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
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
  const waivers = loadWaivers(argValue(argv, '--waivers'))
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
