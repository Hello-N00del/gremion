#!/usr/bin/env node
// node --test suite for scripts/check-workflow-hygiene.mjs: the guard passes on the
// real workflows and fails on a copy with one violation planted per test. Every test
// is its own top-level `test(`: the Makefile compares declared and collected counts.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkWorkflows, MIN_WORKFLOWS, readWorkflows, yamlUnavailableReason } from './check-workflow-hygiene.mjs'

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'check-workflow-hygiene.mjs')
const REAL = readWorkflows()

/** The real workflows with `from` replaced in `name`, asserting it occurs exactly once. */
function plant(name, from, to) {
  const file = REAL.find((f) => f.name === name)
  assert.ok(file, `no workflow named ${name}`)
  const n = file.text.split(from).length - 1
  assert.equal(n, 1, `the plant target must occur exactly once in ${name}, found ${n}: ${from.slice(0, 80)}`)
  return REAL.map((f) => (f === file ? { name, text: f.text.replace(from, () => to) } : f))
}

const joined = (files) => checkWorkflows(files).problems.join('\n')
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1  # v7.0.1\n'

test('the real workflows pass, and ci.yml is left to its own guard', () => {
  assert.equal(yamlUnavailableReason(), undefined, 'this suite needs the yaml package (pnpm install)')
  const r = checkWorkflows(REAL)
  assert.deepEqual(r.problems, [])
  assert.ok(r.workflows >= MIN_WORKFLOWS)
  assert.ok(r.jobs >= 7, `only ${r.jobs} jobs`)
  assert.ok(!REAL.some((f) => f.name === 'ci.yml'))
})

test('a scan of too few workflows fails closed', () => {
  assert.match(joined(REAL.slice(0, 1)), /fewer than the floor/)
})

test('a job without timeout-minutes is reported, naming the workflow and job', () => {
  const p = joined(plant('semgrep.yml', 'name: Semgrep static analysis\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n', 'name: Semgrep static analysis\n    runs-on: ubuntu-latest\n'))
  assert.match(p, /semgrep\.yml: semgrep has no timeout-minutes/)
})

test('a checkout that keeps its credentials is reported', () => {
  const p = joined(plant('release-npm.yml', `${CHECKOUT}        with:\n          persist-credentials: false\n`, CHECKOUT))
  assert.match(p, /release-npm\.yml: publish step 1: actions\/checkout does not set persist-credentials: false/)
})

test('a write scope moved back to the workflow root is reported', () => {
  const p = joined(plant('release-images.yml', 'permissions:\n  contents: read\n\n# One release build', 'permissions:\n  contents: read\n  packages: write\n\n# One release build'))
  assert.match(p, /release-images\.yml: the workflow root grants packages: write/)
})

test('id-token: write stays allowed at the root of release-npm.yml only', () => {
  assert.doesNotMatch(joined(REAL), /id-token/)
  const p = joined(plant('dependency-audit.yml', 'permissions:\n  contents: read\n\nconcurrency:', 'permissions:\n  contents: read\n  id-token: write\n\nconcurrency:'))
  assert.match(p, /dependency-audit\.yml: the workflow root grants id-token: write/)
})

test('a workflow with no root permissions is reported', () => {
  const p = joined(plant('dependency-audit.yml', 'permissions:\n  contents: read\n\nconcurrency:', 'concurrency:'))
  assert.match(p, /dependency-audit\.yml: the workflow root must set read-only permissions/)
})

test('an expression expanded inside run: is reported', () => {
  const p = joined(plant('release-npm.yml', 'd="${PKG_DIR}/dist"', 'd="${{ matrix.dir }}/dist"'))
  assert.match(p, /release-npm\.yml: publish step \d+ \(Assert the build emitted JS and declarations\): a \$\{\{ \}\} expression/)
})

test('a floating npm@latest is reported', () => {
  const p = joined(plant('release-npm.yml', 'npm install -g npm@11.21.1', 'npm install -g npm@latest'))
  assert.match(p, /global npm package npm@latest is not pinned/)
})

test('the -g flag is found wherever it sits in the npm command', () => {
  const p = joined(plant('release-npm.yml', 'npm install -g npm@11.21.1', 'npm install --no-audit -g npm'))
  assert.match(p, /global npm package npm is not pinned/)
})

test('a tag check narrowed back to pushes is reported', () => {
  const p = joined(plant('release-npm.yml', "if: github.event_name == 'push' || inputs.dry_run != true", "if: github.event_name == 'push'"))
  assert.match(p, /the tag check has `if: github\.event_name == 'push'`/)
})

test('a removed tag check is reported', () => {
  const p = joined(plant('release-npm.yml', 'name: Tag and manifest must agree', 'name: Compare versions'))
  assert.match(p, /the tag check step is gone/)
})

test('a Semgrep group that cancels pushes is reported', () => {
  const p = joined(plant('semgrep.yml', "cancel-in-progress: ${{ github.event_name == 'pull_request' }}", 'cancel-in-progress: true'))
  assert.match(p, /semgrep\.yml: cancel-in-progress must be/)
})

test('a Semgrep scan that writes no report is reported', () => {
  const p = joined(plant('semgrep.yml', '            --json-output=semgrep-report.json \\\n', ''))
  assert.match(p, /the scan does not write semgrep-report\.json/)
})

test('a Semgrep job with no scanned-files assertion is reported', () => {
  const p = joined(plant('semgrep.yml', "['paths']['scanned']", "['paths']"))
  assert.match(p, /no step asserts the number of scanned files/)
})

test('a Semgrep report job that stops being weekly-only is reported', () => {
  const p = joined(plant('semgrep.yml', " && github.event_name == 'schedule'", ''))
  assert.match(p, /no report job opens an issue when the weekly run fails/)
})

test('a Semgrep report job with a wider token is reported', () => {
  const p = joined(plant('semgrep.yml', '      issues: write\n', '      issues: write\n      contents: write\n'))
  assert.match(p, /the report job must hold exactly issues: write/)
})

test('an expression inside a shell comment is reported: GitHub expands it anyway', () => {
  const tag = '          tag="${GITHUB_REF_NAME#v}"\n'
  const p = joined(plant('release-npm.yml', tag, `          # \${{ github.event_name }}\n${tag}`))
  assert.match(p, /Tag and manifest must agree\): a \$\{\{ \}\} expression/)
})

test('an unpinned pip package is reported', () => {
  const p = joined(plant('dependency-audit.yml', 'pnpm install --frozen-lockfile --ignore-scripts > /dev/null', 'pip install foo'))
  assert.match(p, /pip package foo is not pinned/)
})

test('a pip package pinned to an exact version passes', () => {
  const p = joined(plant('dependency-audit.yml', 'pnpm install --frozen-lockfile --ignore-scripts > /dev/null', 'pip install foo==1.2.3'))
  assert.doesNotMatch(p, /pip package/)
})

test('a Semgrep report job that runs an action is reported', () => {
  const steps = '      issues: write\n    steps:\n'
  const p = joined(plant('semgrep.yml', steps, `${steps}      - uses: example/action@v1\n`))
  assert.match(p, /the report job must run no action/)
})

test('the CLI exits 1 on a violation and names it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-hygiene-'))
  try {
    for (const f of plant('semgrep.yml', '    timeout-minutes: 5\n', '')) writeFileSync(join(dir, f.name), f.text)
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const r = spawnSync(process.execPath, [GUARD, '--dir', dir], { encoding: 'utf8', env })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /semgrep\.yml: report has no timeout-minutes/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
