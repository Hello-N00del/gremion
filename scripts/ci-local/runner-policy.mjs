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

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SELF_HOSTED_RE = /runs-on:\s*(\[[^\]]*\bself-hosted\b[^\]]*\]|['"]?self-hosted['"]?\s*$)/im
const SECRET_REF_RE = /secrets\.([A-Za-z0-9_]+)/g
const SENSITIVE_SECRET_NAME_RE = /DEPLOY|SIGN(ING)?|SSH|AGE_KEY|GPG|SOPS/i

/** Every `.github/workflows/*.yml` (and `.yaml`) file, repo-relative POSIX paths. */
export function listWorkflowFiles(repoRoot) {
  const dir = join(repoRoot, '.github', 'workflows')
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return []
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
  if (SELF_HOSTED_RE.test(text)) {
    findings.push({ rule: 'self-hosted', detail: 'runs-on names a self-hosted runner' })
  }
  const seen = new Set()
  for (const m of text.matchAll(SECRET_REF_RE)) {
    const name = m[1]
    if (seen.has(name)) continue
    if (SENSITIVE_SECRET_NAME_RE.test(name)) {
      seen.add(name)
      findings.push({ rule: 'sensitive-secret', detail: `references secrets.${name} (signing/age/SSH/deploy)` })
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
  if (w.expiresOn < today) return undefined // expired — the guard must still fail
  return w
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
  const files = listWorkflowFiles(repoRoot)
  const perFile = []
  for (const relPath of files) {
    const basename = relPath.split('/').pop()
    const text = readFileSync(join(repoRoot, relPath), 'utf8')
    const findings = checkWorkflowText(text)
    if (findings.length === 0) continue
    const waiver = activeWaiver(waivers, repoLabel, basename, today)
    perFile.push({ path: relPath, findings, waiver, waived: Boolean(waiver) })
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
