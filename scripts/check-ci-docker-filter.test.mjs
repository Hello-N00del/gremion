#!/usr/bin/env node
// node --test suite for the pull-request docker path filter in
// .github/workflows/ci.yml (the `changes` job) and the `docker-build` job it
// gates.
//
// The filter is shell inside YAML, so the suite runs the REAL `run:` block of
// the `changes` job's filter step under bash against a throwaway git
// repository and asserts the POST-CONDITION (what the step wrote to
// $GITHUB_OUTPUT), never the exit code: the failure this closes exits 0.
//
// The failure: under `set -o pipefail`, `echo "$changed" | grep -Eq ...` makes
// grep exit on the first match; once the list is bigger than the pipe buffer
// echo takes SIGPIPE, the pipeline returns 141, the `if` takes its else branch
// and the step reports docker=false -- the image matrix is skipped with
// nothing red on the PR, on exactly the large PRs (a carve, a mass rename)
// most likely to break an image.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW = parse(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8'))

const filterStep = WORKFLOW.jobs.changes.steps.find((s) => s.id === 'filter')
const dockerBuild = WORKFLOW.jobs['docker-build']

// Dockerfiles that are deliberately not in the image matrix, each with the
// reason. Anything else that is a tracked Dockerfile must be built.
const NOT_BUILT = {
  'docker/vector/Dockerfile': 'clones and compiles ipcrypt2: not worth a per-commit gate',
  'scripts/verify/bats-runner/Dockerfile': 'test-runner image, not shipped',
  'test/host/runner/Dockerfile': 'test-runner image, not shipped',
}

function git(cwd, args, input) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 1 << 28 })
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

// One commit made with `git fast-import` (no working-tree files: thousands of
// paths in a second, and the same on Windows and Linux).
function commit(cwd, ref, parent, paths) {
  const msg = 'x'
  let s = `commit refs/heads/${ref}\ncommitter t <t@t> 1700000000 +0000\ndata ${msg.length}\n${msg}\n`
  if (parent) s += `from ${parent}\n`
  for (const p of paths) s += `M 100644 inline ${p}\ndata 1\nx\n`
  s += '\n'
  git(cwd, ['fast-import', '--quiet'], s)
  return git(cwd, ['rev-parse', ref])
}

// Run the real filter step; returns the value written for `docker`.
function runFilter(changedPaths) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-docker-filter-'))
  try {
    git(dir, ['init', '--quiet', '-b', 'main'])
    const base = commit(dir, 'main', null, ['README.md'])
    const head = commit(dir, 'pr', base, changedPaths)
    const out = join(dir, '.git', 'gh-output')
    writeFileSync(out, '')
    const script = join(dir, '.git', 'step.sh')
    writeFileSync(script, filterStep.run)
    const r = spawnSync('bash', [script], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      env: { ...process.env, BASE_SHA: base, HEAD_SHA: head, GITHUB_OUTPUT: out },
    })
    const written = readFileSync(out, 'utf8')
    const m = written.match(/^docker=(true|false)$/m)
    return { value: m ? m[1] : null, written, status: r.status, stderr: r.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the filter step is found and runs under bash with pipefail on', () => {
  assert.ok(filterStep, 'changes job has a step with id: filter')
  assert.match(filterStep.run, /set -euo pipefail/)
})

test('a docs-only change set reports docker=false', () => {
  const r = runFilter(['docs/a.md', 'docs/b.md', 'README.md'])
  assert.equal(r.value, 'false', r.written + r.stderr)
})

for (const path of [
  'services/kernel-api/Dockerfile',
  'packages/retention/src/index.ts',
  'pnpm-lock.yaml',
  '.github/workflows/ci.yml',
  'docker/legal/Dockerfile',
  'docker/fallback/index.html',
  'docker/fallback/Dockerfile',
  'verticals/vertical-x/blueprint.json',
  'LICENSE',
  'NOTICE',
  'scripts/migrations/ranges.json',
]) {
  test(`a change to ${path} reports docker=true`, () => {
    const r = runFilter([path, 'docs/unrelated.md'])
    assert.equal(r.value, 'true', r.written + r.stderr)
  })
}

// The regression. The first sorted entry matches, and the list is far larger
// than any pipe buffer (64 KiB on Linux), so a `echo | grep -q` pipeline under
// pipefail returns 141 and the step reports false.
test('a very large change set whose first entry is a docker input reports docker=true', () => {
  const paths = ['pnpm-lock.yaml']
  for (let i = 0; i < 6000; i++) paths.push(`zdocs/section-${String(i).padStart(5, '0')}/a-fairly-long-document-name-to-fill-the-buffer.md`)
  const bytes = paths.join('\n').length
  assert.ok(bytes > 400 * 1024, `the list must dwarf the pipe buffer, got ${bytes} bytes`)
  const r = runFilter(paths)
  assert.equal(r.value, 'true', `${r.written}${r.stderr.slice(0, 500)}`)
})

test('a very large change set with no docker input still reports docker=false', () => {
  const paths = []
  for (let i = 0; i < 6000; i++) paths.push(`zdocs/section-${String(i).padStart(5, '0')}/a-fairly-long-document-name-to-fill-the-buffer.md`)
  const r = runFilter(paths)
  assert.equal(r.value, 'false', `${r.written}${r.stderr.slice(0, 500)}`)
})

test('the filter source never pipes a producer into grep -q', () => {
  assert.doesNotMatch(filterStep.run, /\|\s*grep\s+-[A-Za-z]*q/, 'a producer piped into grep -q dies of SIGPIPE under pipefail')
})

test('a failed `changes` job forces the image build instead of skipping it', () => {
  const cond = String(dockerBuild.if)
  assert.match(cond, /needs\.changes\.result == 'failure'/)
  // On a pull request a failed filter must build; lint must still gate.
  assert.match(cond, /needs\.lint\.result == 'success'/)
})

test('docker-build needs both lint and changes', () => {
  assert.deepEqual([...dockerBuild.needs].sort(), ['changes', 'lint'])
})

test('every tracked Dockerfile is in the image matrix or has a stated reason not to be', () => {
  const tracked = git(ROOT, ['ls-files'])
    .split('\n')
    .filter((p) => /(^|\/)(Dockerfile|Containerfile)(\.[^/]*)?$/.test(p))
  const matrix = dockerBuild.strategy.matrix.include.map((e) => e.dockerfile)
  const missing = tracked.filter((p) => !matrix.includes(p) && !(p in NOT_BUILT))
  assert.deepEqual(missing, [], 'Dockerfiles neither built by the matrix nor listed with a reason')
  for (const p of Object.keys(NOT_BUILT)) assert.ok(tracked.includes(p), `NOT_BUILT names ${p}, which is not a tracked Dockerfile`)
  for (const p of matrix) assert.ok(existsSync(join(ROOT, p)), `matrix names ${p}, which does not exist`)
})

test('the matrix builds the fallback and synapse images', () => {
  const byName = Object.fromEntries(dockerBuild.strategy.matrix.include.map((e) => [e.name, e]))
  assert.equal(byName.fallback?.dockerfile, 'docker/fallback/Dockerfile')
  assert.equal(byName.fallback?.context, 'docker/fallback/')
  assert.equal(byName.synapse?.dockerfile, 'modules/messaging/synapse/Dockerfile')
  assert.equal(byName.synapse?.context, 'modules/messaging/synapse/')
})
