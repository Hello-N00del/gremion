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
// The same step also decides the health census (`census=`, read by the verify-census
// job): the second half of the suite runs the real step against the same throwaway
// repositories and asserts that output.
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

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CI_YML = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')

// This suite stays dependency-free on purpose: it imports only node: built-ins, so
// it needs no install and can be proved to run with nothing but itself and ci.yml
// in an empty directory (see the inCheckout note below). It guards the job that gates
// the image matrix, and a guard that needs a working node_modules is one more way
// for that job never to run. The pieces of ci.yml it asserts on are therefore pulled
// out with a small text extractor that
// understands exactly the shapes this workflow uses: block-scalar `run: |`,
// folded `if: >-`, an inline `needs: [a, b]` and one-line `- { k: v, ... }`
// matrix entries. A shape it does not understand yields undefined/empty and the
// assertions below fail loudly rather than pass vacuously.
const indentOf = (l) => l.match(/^ */)[0].length
const isBlank = (l) => l.trim() === ''

// Lines of one top-level job (`  name:` under `jobs:`).
function jobLines(text, job) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trimEnd() === `  ${job}:`)
  if (start < 0) return []
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (isBlank(l)) continue
    const ind = indentOf(l)
    if (ind < 2 || (ind === 2 && !l.trimStart().startsWith('#'))) {
      end = i
      break
    }
  }
  return lines.slice(start, end)
}

// The body of the block scalar whose key is on lines[i]: every following line
// that is blank or indented deeper than the key.
function blockBody(lines, i) {
  const keyIndent = indentOf(lines[i])
  const body = []
  for (let j = i + 1; j < lines.length; j++) {
    if (!isBlank(lines[j]) && indentOf(lines[j]) <= keyIndent) break
    body.push(lines[j])
  }
  while (body.length && isBlank(body[body.length - 1])) body.pop()
  return body
}

function literalScalar(lines, keyRe) {
  const i = lines.findIndex((l) => keyRe.test(l))
  if (i < 0) return undefined
  const body = blockBody(lines, i)
  const strip = Math.min(...body.filter((l) => !isBlank(l)).map(indentOf))
  return body.map((l) => l.slice(strip)).join('\n') + '\n'
}

function foldedScalar(lines, keyRe) {
  const i = lines.findIndex((l) => keyRe.test(l))
  if (i < 0) return undefined
  return blockBody(lines, i)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
}

// The `run:` block of the step whose `id:` is stepId inside the given job lines.
function stepRun(lines, stepId) {
  const idAt = lines.findIndex((l) => new RegExp(`^\\s+id:\\s*${stepId}\\s*$`).test(l))
  if (idAt < 0) return undefined
  const dashIndent = indentOf(lines[idAt]) - 2
  const isDash = (l) => indentOf(l) === dashIndent && l.trimStart().startsWith('- ')
  let s = idAt
  while (s > 0 && !isDash(lines[s])) s--
  let e = idAt + 1
  while (e < lines.length && !isDash(lines[e])) e++
  return literalScalar(lines.slice(s, e), /^\s+run:\s*\|\s*$/)
}

function parseInlineList(lines, keyRe) {
  const m = lines.map((l) => l.match(keyRe)).find(Boolean)
  return m ? m[1].split(',').map((x) => x.trim()).filter(Boolean) : undefined
}

function parseMatrixInclude(lines) {
  const at = lines.findIndex((l) => /^\s+include:\s*$/.test(l))
  if (at < 0) return []
  const out = []
  for (let i = at + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s+-\s*\{(.*)\}\s*$/)
    if (!m) {
      if (isBlank(lines[i])) continue
      break
    }
    const entry = {}
    for (const kv of m[1].split(',')) {
      const k = kv.indexOf(':')
      entry[kv.slice(0, k).trim()] = kv.slice(k + 1).trim()
    }
    out.push(entry)
  }
  return out
}

const changesLines = jobLines(CI_YML, 'changes')
const dockerBuildLines = jobLines(CI_YML, 'docker-build')
const censusLines = jobLines(CI_YML, 'verify-census')

const filterStep = { run: stepRun(changesLines, 'filter') }
const verifyCensus = {
  if: foldedScalar(censusLines, /^\s+if:\s*>-?\s*$/),
  needs: parseInlineList(censusLines, /^\s+needs:\s*\[(.*)\]\s*$/),
}
const dockerBuild = {
  if: foldedScalar(dockerBuildLines, /^\s+if:\s*>-?\s*$/),
  needs: parseInlineList(dockerBuildLines, /^\s+needs:\s*\[(.*)\]\s*$/),
  strategy: { matrix: { include: parseMatrixInclude(dockerBuildLines) } },
}

// Dockerfiles that are deliberately not in the image matrix, each with the
// reason. Anything else that is a tracked Dockerfile must be built.
const NOT_BUILT = {
  'docker/vector/Dockerfile': 'clones and compiles ipcrypt2: not worth a per-commit gate',
  'scripts/verify/bats-runner/Dockerfile': 'test-runner image, not shipped',
  'test/host/runner/Dockerfile': 'test-runner image, not shipped',
}

function git(cwd, args, input) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 1 << 28 })
  // A spawn failure (no git, bad cwd) leaves status null and stderr null: say why.
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.error?.message ?? r.stderr}`)
  return r.stdout.trim()
}

// One commit made with `git fast-import` (no working-tree files: thousands of
// paths in a second, and the same on Windows and Linux).
function commit(cwd, ref, parent, paths, renames = []) {
  const msg = 'x'
  let s = `commit refs/heads/${ref}\ncommitter t <t@t> 1700000000 +0000\ndata ${msg.length}\n${msg}\n`
  if (parent) s += `from ${parent}\n`
  for (const p of paths) s += `M 100644 inline ${p}\ndata 1\nx\n`
  for (const [from, to] of renames) s += `R ${from} ${to}\n`
  s += '\n'
  git(cwd, ['-c', 'core.protectNTFS=false', 'fast-import', '--quiet'], s)
  return git(cwd, ['rev-parse', ref])
}

// Run the real filter step; returns the value written for `docker`.
// `moves` is [[from, to], ...]: files that exist at the base and are renamed in the PR.
function runFilter(changedPaths, moves = []) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-docker-filter-'))
  try {
    git(dir, ['init', '--quiet', '-b', 'main'])
    const base = commit(dir, 'main', null, ['README.md', ...moves.map(([from]) => from)])
    const head = commit(dir, 'pr', base, changedPaths, moves)
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
    const c = written.match(/^census=(true|false)$/m)
    // r.error is set when bash itself could not be spawned (stderr is then null).
    return { value: m ? m[1] : null, census: c ? c[1] : null, written, status: r.status, stderr: r.error?.message ?? r.stderr, stdout: r.stdout ?? '' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the extractor found the pieces of ci.yml the suite asserts on', () => {
  assert.ok(filterStep.run && filterStep.run.length > 200, 'changes job has a step with id: filter and a run block')
  assert.ok(dockerBuild.if, 'docker-build has a folded if:')
  assert.ok(dockerBuild.needs, 'docker-build has an inline needs: list')
  assert.ok(dockerBuild.strategy.matrix.include.length >= 10, 'docker-build matrix has its include entries')
})

test('the filter step runs under bash with pipefail on', () => {
  assert.match(filterStep.run, /set -euo pipefail/)
})

test('a docs-only change set reports docker=false', () => {
  const r = runFilter(['docs/a.md', 'docs/b.md', 'README.md'])
  assert.equal(r.value, 'false', r.written + r.stderr)
})

// One test, a loop inside it: scripts/verify/suites/unit.mjs compares node's collected
// count with the number of `test(` declarations, and a `test(` inside a loop declares 1
// and collects N (judged unparseable). The message names the path that failed.
test('a change to any docker build input reports docker=true', () => {
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
    const r = runFilter([path, 'docs/unrelated.md'])
    assert.equal(r.value, 'true', `${path}: ${r.written}${r.stderr}`)
  }
})

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

// With rename detection `git diff --name-only` prints only the DESTINATION of a
// move, so taking a docker input out of a build tree looked like a docs change.
test('moving a docker input out of its build tree reports docker=true', () => {
  const r = runFilter([], [['packages/x/a.ts', 'docs/x/a.ts']])
  assert.equal(r.value, 'true', r.written + r.stderr)
})

test('moving a file between two non-input trees still reports docker=false', () => {
  const r = runFilter([], [['docs/x/a.md', 'notes/x/a.md']])
  assert.equal(r.value, 'false', r.written + r.stderr)
})

// The runner interprets `::command::` at the start of a log line, and a PR
// controls its file names: echoing them raw is workflow-command injection.
test('the step never writes PR-controlled file names to the log', () => {
  // A name that STARTS with `::` is the real exploit; Git for Windows refuses to
  // store one, so it is only exercised where it can exist.
  const names = ['docs/::error::injected.md', 'docs/::stop-commands::x.md']
  if (process.platform !== 'win32') names.push('::error::top-level.md')
  const r = runFilter(names)
  assert.equal(r.value, 'false', r.written + r.stderr)
  assert.doesNotMatch(r.stdout, /^::/m, 'a log line must not start with a workflow command')
  for (const n of names) assert.ok(!r.stdout.includes(n), `the log must not echo ${n}`)
  assert.match(r.stdout, new RegExp(`Changed files in this PR: ${names.length}\\b`), 'the count of changed files is still reported')
})

// A producer piped into a grep that quits at its first match: `-q` alone, a
// cluster that contains q (`-Eq`), q as its own flag after others (`-E -q`), or
// the long forms. Whole-line comments are not code and are dropped first.
const QUIET_GREP_PIPE = /\|\s*grep\b[^|\n]*\s(-[A-Za-z]*q[A-Za-z]*|--quiet|--silent)\b/
const pipesIntoQuietGrep = (src) =>
  QUIET_GREP_PIPE.test(
    src
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n'),
  )

test('the filter source never pipes a producer into a quiet grep', () => {
  assert.equal(pipesIntoQuietGrep(filterStep.run), false, 'a producer piped into a quiet grep dies of SIGPIPE under pipefail')
})

test('the quiet-grep detector flags every quiet spelling', () => {
  for (const spelling of [
    'grep -q x',
    'grep -Eq x',
    'grep -qE x',
    'grep -E -q x',
    'grep -E "$pattern" -q',
    'grep -i -E -q x',
    'grep --quiet x',
    'grep -E --silent x',
  ]) {
    assert.equal(pipesIntoQuietGrep(`printf '%s\\n' "$changed" | ${spelling}`), true, `| ${spelling}`)
  }
})

test('the quiet-grep detector allows the counting spellings', () => {
  for (const ok of ['grep -c x', 'grep -Ec "$pattern"', 'grep -E -c x', 'grep -e quux', 'grep --count x']) {
    assert.equal(pipesIntoQuietGrep(`printf '%s\\n' "$changed" | ${ok}`), false, `| ${ok}`)
  }
})

test('the quiet-grep detector ignores whole-line comments', () => {
  assert.equal(pipesIntoQuietGrep('# echo "$x" | grep -q y\ngrep -c y file'), false)
})

test('a failed `changes` job forces the image build instead of skipping it', () => {
  const cond = String(dockerBuild.if)
  assert.match(cond, /needs\.changes\.result == 'failure'/)
  // On a pull request a failed filter must build; lint must still gate.
  assert.match(cond, /needs\.lint\.result == 'success'/)
})

test('docker-build needs both lint and changes', () => {
  assert.deepEqual([...dockerBuild.needs].sort(byCodeUnit), ['changes', 'lint'])
})

// The next test reads the repository (git ls-files, the Dockerfiles on disk). It
// is skipped, visibly, only when this file runs outside a checkout -- which is how
// the dependency-free property is proved (the test and ci.yml alone in an empty
// directory); in CI the checkout is a git work tree and the test always runs.
const inCheckout = (() => {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8' })
  return r.status === 0 && existsSync(join(ROOT, 'Makefile'))
})()

test('every tracked Dockerfile is in the image matrix or has a stated reason not to be', { skip: !inCheckout && 'not inside a repository checkout' }, () => {
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

// ── the health census output (`census=`, read by verify-census) ──────────────

test('the filter step writes a census output next to docker, and the job exposes it', () => {
  const r = runFilter(['docs/a.md'])
  assert.equal(r.census, 'false', r.written + r.stderr)
  assert.match(CI_YML, /^\s+census: \$\{\{ steps\.filter\.outputs\.census \}\}$/m, 'the changes job does not expose the census output')
})

test('a docs-only change set reports census=false', () => {
  const r = runFilter(['docs/a.md', 'docs/b.md', 'README.md'])
  assert.equal(r.census, 'false', r.written + r.stderr)
})

test('a change to any census input reports census=true', () => {
  for (const path of [
    'services/kernel-api/Dockerfile',
    'docker/legal/Dockerfile',
    'docker-compose.app.yml',
    'docker-compose.state-pins.yml',
    'infra/host/mail/docker-compose.yml',
    'compose/observability/docker-compose.yml',
    'infra/host/templates/env/state.env.tmpl',
    'scripts/verify/census/census.mjs',
    'scripts/verify/census/render.env',
    'scripts/verify/lib/proc.mjs',
    'scripts/verify/verify.mjs',
    'docker/nats/nats.conf',
    '.github/workflows/ci.yml',
    'modules/board/.dockerignore',
  ]) {
    const r = runFilter([path, 'docs/unrelated.md'])
    assert.equal(r.census, 'true', `${path}: ${r.written}${r.stderr}`)
  }
})

// The census reads compose files and Dockerfiles, not application source: an ordinary
// source change builds the images (docker=true) but cannot move a healthcheck census.
test('a change to application source alone reports docker=true and census=false', () => {
  const r = runFilter(['packages/retention/src/index.ts', 'gremion-ui/src/routes/+page.svelte', 'pnpm-lock.yaml'])
  assert.equal(r.value, 'true', r.written + r.stderr)
  assert.equal(r.census, 'false', r.written + r.stderr)
})

// The SIGPIPE regression, for the census count: the first sorted entry is a census input and the
// list is far larger than any pipe buffer.
test('a very large change set whose first entry is a census input reports census=true', () => {
  const paths = ['compose/x.yml']
  for (let i = 0; i < 6000; i++) paths.push(`zdocs/section-${String(i).padStart(5, '0')}/a-fairly-long-document-name-to-fill-the-buffer.md`)
  const r = runFilter(paths)
  assert.equal(r.census, 'true', `${r.written}${r.stderr.slice(0, 500)}`)
})

test('a very large change set with no census input still reports census=false', () => {
  const paths = []
  for (let i = 0; i < 6000; i++) paths.push(`zdocs/section-${String(i).padStart(5, '0')}/a-fairly-long-document-name-to-fill-the-buffer.md`)
  const r = runFilter(paths)
  assert.equal(r.census, 'false', `${r.written}${r.stderr.slice(0, 500)}`)
})

test('moving a census input out of its tree reports census=true', () => {
  const r = runFilter([], [['compose/observability/a.yml', 'docs/x/a.yml']])
  assert.equal(r.census, 'true', r.written + r.stderr)
})

test('verify-census runs on pushes, and on a pull request only for a census input or a failed filter', () => {
  const cond = String(verifyCensus.if)
  assert.match(cond, /github\.event_name != 'pull_request'/)
  assert.match(cond, /needs\.changes\.outputs\.census == 'true'/)
  assert.match(cond, /needs\.changes\.result == 'failure'/)
  // lint must still gate it, and a cancelled run must not start it.
  assert.match(cond, /needs\.lint\.result == 'success'/)
  assert.match(cond, /!cancelled\(\)/)
})

test('verify-census needs both lint and changes', () => {
  assert.deepEqual([...(verifyCensus.needs ?? [])].sort(byCodeUnit), ['changes', 'lint'])
})
