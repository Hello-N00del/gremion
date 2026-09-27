// Time-bound test for news-posts-public-grant-proof.sh (TASK-200 Q9, r3).
//
// Every `docker exec` in the proof must be bounded: a hung exec (seen on
// Docker Desktop for Windows, where `docker exec -i` can fail to see stdin EOF)
// must end the proof with a NAMED failure, never an open-ended wait. A fake
// `docker` on PATH answers `run`/`rm` and the readiness probes, and hangs on
// every other exec; the proof must exit non-zero within a bound and say which
// step timed out.
//
// Run: node --test modules/content/app/scripts/news-posts-public-grant-proof.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROOF = join(HERE, 'news-posts-public-grant-proof.sh')
const REPO_ROOT = join(HERE, '..', '..', '..', '..')

// The fake answers the lifecycle and readiness calls and hangs on the rest.
// `exec sleep` so the process the proof's timeout kills IS the sleeper.
const FAKE_DOCKER = `#!/usr/bin/env bash
case "$1" in
  run) echo fakecontainerid; exit 0 ;;
  rm) exit 0 ;;
  exec)
    case "$*" in
      *pg_isready*|*"SELECT 1"*) exit 0 ;;
    esac
    exec sleep 300 ;;
esac
exit 0
`

function fakeDockerDir() {
  const base = join(REPO_ROOT, '.scratch')
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'proof-test-'))
  const docker = join(dir, 'docker')
  writeFileSync(docker, FAKE_DOCKER)
  chmodSync(docker, 0o755)
  return dir
}

test('a hung docker exec ends the proof with a named timeout, within a bound', () => {
  const dir = fakeDockerDir()
  try {
    const started = Date.now()
    const res = spawnSync('bash', [PROOF], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PROOF_EXEC_TIMEOUT: '3' },
      encoding: 'utf8',
      timeout: 90_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const elapsed = Date.now() - started
    assert.equal(res.error, undefined, `the proof did not end on its own within 90s (${res.error?.message})`)
    assert.notEqual(res.status, 0, 'a timed-out exec must fail the proof')
    assert.match(res.stderr, /RESULT: FAIL .*timed out after 3s/, `stderr: ${res.stderr}`)
    assert.ok(elapsed < 90_000, `took ${elapsed}ms`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the proof refuses a non-numeric exec timeout instead of running unbounded', () => {
  const dir = fakeDockerDir()
  try {
    const res = spawnSync('bash', [PROOF], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PROOF_EXEC_TIMEOUT: 'forever' },
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.equal(res.error, undefined, `the proof did not end on its own within 30s (${res.error?.message})`)
    assert.equal(res.status, 2, `stderr: ${res.stderr}`)
    assert.match(res.stderr, /PROOF_EXEC_TIMEOUT/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
