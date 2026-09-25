#!/usr/bin/env node
// node --test suite: scripts/release/check-runner-scope.mjs — where a CI runner
// is used it carries no signing/age/deploy key and is not self-hosted,
// asserted from the GitHub API's view of the ACTUAL credential scope, never a
// workflow file (TASK-046, TRD-445, brief §1 bullet 7, Q6, §6 item 6).
//
// Fixtures under fixtures/runner-scope/ are API-SHAPED response bodies (see
// their $comment): the build sandbox's proxy refuses the Actions API, so none
// could be recorded live. The live run is a separate, dated evidence step.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { collectEvidence, checkEvidence, classifySecret, REPOS } from './check-runner-scope.mjs'

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/runner-scope')
const NOW = new Date('2026-09-26T00:00:00Z')

async function evidenceOf(name) {
  const f = JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))
  const get = async (path) => {
    if (!(path in f.responses)) throw Object.assign(new Error(`404 ${path}`), { status: 404 })
    return f.responses[path]
  }
  return collectEvidence(get, { fetchedAt: f.fetchedAt })
}
const codes = (r) => r.problems.map((p) => p.code).sort()

test('both project repositories are in scope', () => {
  assert.deepEqual(REPOS, ['Hello-N00del/gremion', 'Hello-N00del/StuRaOS'])
})

test('clean: Actions on, only registry tokens, no self-hosted runner -> pass', async () => {
  const r = checkEvidence(await evidenceOf('clean'), { now: NOW })
  assert.deepEqual(r.problems, [])
  assert.deepEqual(r.notes, [])
})

test('a key-class repository secret with Actions on -> FAIL', async () => {
  const r = checkEvidence(await evidenceOf('key-class-secret'), { now: NOW })
  assert.deepEqual(codes(r), ['key-class-secret'])
  assert.match(r.problems[0].message, /COSIGN_KEY/)
})

test('a key-class ENVIRONMENT secret with Actions on -> FAIL', async () => {
  const r = checkEvidence(await evidenceOf('env-key-class-secret'), { now: NOW })
  assert.deepEqual(codes(r), ['key-class-secret'])
  assert.match(r.problems[0].message, /environment production.*DEPLOY_SSH_KEY/)
})

test('a self-hosted runner with Actions on -> FAIL', async () => {
  const r = checkEvidence(await evidenceOf('self-hosted-runner'), { now: NOW })
  assert.deepEqual(codes(r), ['self-hosted-runner'])
})

test('Actions off: "no runner in use" recorded, dormant key-class secrets REPORTED (Q6), not failed', async () => {
  const r = checkEvidence(await evidenceOf('disabled-with-key'), { now: NOW })
  assert.deepEqual(r.problems, [])
  assert.ok(r.notes.some((n) => /Hello-N00del\/gremion: Actions disabled — no runner in use/.test(n)))
  assert.ok(r.notes.some((n) => /dormant key-class secret DEPLOY_SSH_KEY \(repository\)/.test(n)))
  assert.ok(r.notes.some((n) => /dormant key-class secret DEPLOY_SSH_KEY \(environment production\)/.test(n)))
  // …and the SAME secrets fail the moment Actions is re-enabled.
  const on = await evidenceOf('disabled-with-key')
  on.repos[0].actions.enabled = true
  assert.deepEqual(codes(checkEvidence(on, { now: NOW })), ['key-class-secret', 'key-class-secret'])
})

test('a repository the API did not answer for -> FAIL, never a pass on partial evidence', async () => {
  await assert.rejects(evidenceOf('missing-repo'), /404/)
})

test('evidence that is undated, stale, or not from the API (e.g. read from YAML) -> FAIL', async () => {
  const ev = await evidenceOf('clean')
  assert.deepEqual(codes(checkEvidence({ ...ev, fetchedAt: undefined }, { now: NOW })), ['evidence-undated'])
  assert.deepEqual(codes(checkEvidence(ev, { now: new Date('2026-10-30T00:00:00Z') })), ['evidence-stale'])
  assert.deepEqual(codes(checkEvidence({ ...ev, source: 'workflow-yaml' }, { now: NOW })), ['evidence-source'])
  assert.deepEqual(codes(checkEvidence({ ...ev, repos: ev.repos.slice(1) }, { now: NOW })), ['missing-repo'])
})

test('secret classes: registry tokens are allowed, everything else is key-class', () => {
  for (const n of ['GHCR_TOKEN', 'NPM_TOKEN', 'REGISTRY_TOKEN', 'DOCKERHUB_TOKEN']) assert.equal(classifySecret(n), 'registry', n)
  for (const n of ['DEPLOY_SSH_KEY', 'COSIGN_KEY', 'COSIGN_PASSWORD', 'SOPS_AGE_KEY', 'DEPLOY_HOST', 'ANY_OTHER']) {
    assert.equal(classifySecret(n), 'key-class', n)
  }
})

test('every fixture is exercised by this suite', () => {
  const names = readdirSync(FIX).map((f) => f.replace(/\.json$/, '')).sort()
  assert.deepEqual(names, ['clean', 'disabled-with-key', 'env-key-class-secret', 'key-class-secret', 'missing-repo', 'self-hosted-runner'])
})
