#!/usr/bin/env node
// check-runner-scope — the ACTUAL credential scope of CI runners (TASK-046,
// TRD-445/364, D R19-D17): ephemeral, keyless, registry-only.
//
// Evidence comes from the GitHub REST API, never from workflow YAML (the
// config-level runner-policy guard is TASK-012's, in scripts/ci-local/; this
// one asserts what the repository can actually hand a runner). Per repository
// (both project repos, brief §1):
//   GET /repos/{r}/actions/permissions            Actions enabled?
//   GET /repos/{r}/actions/secrets                 repository secret NAMES
//   GET /repos/{r}/environments                    environments
//   GET /repos/{r}/environments/{e}/secrets        environment secret NAMES
//   GET /repos/{r}/actions/runners                 self-hosted runners
//   GET /repos/{r}/dependabot/secrets              Dependabot secret NAMES
//   GET /users/{owner} -> type; for an Organization also
//   GET /repos/{r}/actions/organization-secrets    org secrets visible to the repo
// Every list must carry its array and be complete (length == total_count);
// a permissions answer without a boolean `enabled` is an error.
//
// Verdict:
//   Actions ON  -> FAIL on any key-class secret (repository or environment)
//                  and on any self-hosted runner. Registry tokens are the only
//                  secrets a runner may reach.
//   Actions OFF -> "no runner in use" is recorded; dormant key-class secrets
//                  and runners are REPORTED (Q6: removal is the operator's
//                  action), and fail the moment Actions is re-enabled.
//   Evidence that is undated, older than 7 days, from any source but the API,
//   or missing a repository -> FAIL. An API error is a FAIL, never a partial pass.
//
// Run (live, read-only; needs GH_TOKEN with admin read on both repos):
//   node scripts/release/check-runner-scope.mjs --live [--out evidence.json]
// Re-check a saved evidence file:
//   node scripts/release/check-runner-scope.mjs --evidence evidence.json
// Test: node --test scripts/release/check-runner-scope.test.mjs

import { writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const REPOS = ['Hello-N00del/gremion', 'Hello-N00del/StuRaOS']
export const MAX_AGE_DAYS = 7
// Exact registry-token names only: a free-form middle would admit
// GHCR_DEPLOY_SSH_PRIVATE_KEY_TOKEN as a "registry token".
const REGISTRY_RE = /^(GHCR|NPM|PNPM|REGISTRY|DOCKERHUB)(_(READ|PULL|PUSH|PUBLISH))?_TOKEN$/

export function classifySecret(name) {
  return REGISTRY_RE.test(name) ? 'registry' : 'key-class'
}

/** Evidence from a `get(path) -> json` function (live fetch or recorded map). Throws on any API error. */
/** The `key` array of a list answer, complete, or throw. */
async function list(get, path, key) {
  const body = await get(path)
  const arr = body?.[key]
  if (!Array.isArray(arr)) throw new Error(`GET ${path}: answer has no ${key} array`)
  if (typeof body.total_count === 'number' && body.total_count !== arr.length) {
    throw new Error(`GET ${path}: truncated — ${arr.length} of total_count ${body.total_count} ${key}`)
  }
  return arr
}

export async function collectEvidence(get, { fetchedAt = new Date().toISOString(), repos = REPOS } = {}) {
  const out = { source: 'github-api', fetchedAt, repos: [] }
  for (const repo of repos) {
    const base = `/repos/${repo}`
    const owner = await get(`/users/${repo.split('/')[0]}`)
    if (owner?.type !== 'User' && owner?.type !== 'Organization') throw new Error(`GET /users/${repo.split('/')[0]}: unknown owner type`)
    const perms = await get(`${base}/actions/permissions`)
    if (typeof perms?.enabled !== 'boolean') throw new Error(`GET ${base}/actions/permissions: no boolean enabled field`)
    const names = (a) => a.map((s) => s.name)
    const secrets = names(await list(get, `${base}/actions/secrets`, 'secrets'))
    const dependabot = names(await list(get, `${base}/dependabot/secrets`, 'secrets'))
    const organization = owner.type === 'Organization' ? names(await list(get, `${base}/actions/organization-secrets`, 'secrets')) : []
    const environments = []
    for (const e of await list(get, `${base}/environments`, 'environments')) {
      environments.push({ name: e.name, secrets: names(await list(get, `${base}/environments/${encodeURIComponent(e.name)}/secrets`, 'secrets')) })
    }
    const runners = (await list(get, `${base}/actions/runners`, 'runners')).map((r) => ({
      name: r.name,
      os: r.os,
      labels: (r.labels ?? []).map((l) => l.name),
    }))
    out.repos.push({ repo, ownerType: owner.type, actions: { enabled: perms.enabled }, secrets, dependabot, organization, environments, runners })
  }
  return out
}

export function checkEvidence(ev, { now = new Date(), repos = REPOS } = {}) {
  const problems = []
  const notes = []
  const add = (code, message) => problems.push({ code, message })
  if (ev?.source !== 'github-api') {
    add('evidence-source', `evidence source is ${JSON.stringify(ev?.source)}; only the GitHub API counts (never YAML)`)
    return { problems, notes }
  }
  const at = Date.parse(ev.fetchedAt ?? '')
  if (Number.isNaN(at)) {
    add('evidence-undated', 'evidence carries no fetchedAt date')
    return { problems, notes }
  }
  if (at - now.getTime() > 5 * 60e3) {
    add('evidence-future', `evidence is dated ${ev.fetchedAt}, in the future`)
    return { problems, notes }
  }
  if (now.getTime() - at > MAX_AGE_DAYS * 86400e3) {
    add('evidence-stale', `evidence from ${ev.fetchedAt} is older than ${MAX_AGE_DAYS} days`)
    return { problems, notes }
  }
  for (const want of repos) {
    const r = (ev.repos ?? []).find((x) => x.repo === want)
    if (!r) {
      add('missing-repo', `no evidence for ${want}`)
      continue
    }
    // A saved file is re-checked as strictly as a live read: a missing or
    // non-boolean `enabled` must never read as "Actions off".
    const arrays = ['secrets', 'dependabot', 'organization', 'environments', 'runners']
    if (typeof r.actions?.enabled !== 'boolean' || arrays.some((k) => !Array.isArray(r[k])) ||
        r.environments.some((e) => !Array.isArray(e?.secrets))) {
      add('evidence-malformed', `${want}: evidence lacks a boolean actions.enabled or one of ${arrays.join('/')} arrays`)
      continue
    }
    const scoped = [
      ...r.secrets.map((s) => ({ s, where: 'repository' })),
      ...r.dependabot.map((s) => ({ s, where: 'dependabot' })),
      ...r.organization.map((s) => ({ s, where: 'organization' })),
      ...r.environments.flatMap((e) => e.secrets.map((s) => ({ s, where: `environment ${e.name}` }))),
    ].filter((x) => classifySecret(x.s) === 'key-class')
    if (r.actions.enabled) {
      for (const x of scoped) add('key-class-secret', `${want}: Actions enabled and ${x.where} secret ${x.s} is not a registry token`)
      for (const run of r.runners) add('self-hosted-runner', `${want}: Actions enabled with self-hosted runner ${run.name} [${run.labels.join(',')}]`)
    } else {
      notes.push(`${want}: Actions disabled — no runner in use`)
      for (const x of scoped) notes.push(`${want}: dormant key-class secret ${x.s} (${x.where}) — operator removal recommended (Q6)`)
      for (const run of r.runners) notes.push(`${want}: dormant self-hosted runner ${run.name} registered`)
    }
  }
  return { problems, notes }
}

async function liveGet(path) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token) throw new Error('no GH_TOKEN/GITHUB_TOKEN in the environment')
  const res = await fetch(`https://api.github.com${path}?per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  })
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200)
    throw Object.assign(new Error(`GitHub API ${res.status} on GET ${path}: ${body}`), { status: res.status })
  }
  const body = await res.json()
  // Follow rel="next" and merge the list, so collectEvidence's total_count
  // check sees the whole list (it throws on anything shorter).
  let next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1]
  const key = Object.keys(body).find((k) => Array.isArray(body[k]))
  while (next && key) {
    const more = await fetch(next, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } })
    if (!more.ok) throw Object.assign(new Error(`GitHub API ${more.status} on ${next}`), { status: more.status })
    body[key].push(...((await more.json())[key] ?? []))
    next = /<([^>]+)>;\s*rel="next"/.exec(more.headers.get('link') ?? '')?.[1]
  }
  return body
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (f) => {
    const i = process.argv.indexOf(f)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  const outFile = arg('--out')
  let ev
  if (process.argv.includes('--live')) {
    try {
      ev = await collectEvidence(liveGet)
    } catch (e) {
      const record = { source: 'github-api', attemptedAt: new Date().toISOString(), obtained: false, reason: e.message }
      if (outFile) writeFileSync(outFile, JSON.stringify(record, null, 2) + '\n')
      console.error(`check-runner-scope: FAIL no-live-evidence: ${e.message}`)
      process.exit(1)
    }
    if (outFile) writeFileSync(outFile, JSON.stringify(ev, null, 2) + '\n')
  } else if (arg('--evidence')) {
    ev = JSON.parse(readFileSync(arg('--evidence'), 'utf8'))
  } else {
    console.error('usage: check-runner-scope.mjs --live [--out FILE] | --evidence FILE')
    process.exit(2)
  }
  const r = checkEvidence(ev)
  for (const n of r.notes) console.log(`check-runner-scope: NOTE ${n}`)
  for (const p of r.problems) console.error(`check-runner-scope: FAIL ${p.code}: ${p.message}`)
  console.log(`check-runner-scope: evidence ${ev.fetchedAt}, ${r.problems.length} problem(s)`)
  process.exit(r.problems.length ? 1 : 0)
}
