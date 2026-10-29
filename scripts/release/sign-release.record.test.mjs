#!/usr/bin/env node
// node --test suite: the sign-release.sh <-> check-record.mjs argv contract,
// against the REAL check-record.mjs.
//
// sign-release.test.mjs stubs check-record (it needs a registry, cosign and
// syft, so it cannot run everywhere). Its stub once accepted any argv, which is
// how `--commit <sha>` survived in sign-release.sh after check-record's strict
// parser started rejecting every flag but --allow-missing: the signer then
// refused every release with "no green check record" and no test noticed. This
// file needs none of that machinery. The script reaches the check-record step
// before it touches cosign/docker/jq beyond `command -v`, and it refuses a
// non-digest reference only AFTER check-record passed, so a bad reference is a
// probe that tells "check-record accepted the call" from "check-record refused".

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { REPO_ROOT } from './lib/harness.mjs'

let tmp, bin, keyFile
before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sign-record-'))
  // Presence-only stand-ins: sign-release.sh checks `command -v` for these
  // before check-record and never runs them on the paths exercised here.
  bin = join(tmp, 'bin')
  mkdirSync(bin)
  for (const tool of ['cosign', 'docker', 'jq']) {
    writeFileSync(join(bin, tool), '#!/bin/sh\nexit 99\n')
    chmodSync(join(bin, tool), 0o755)
  }
  keyFile = join(tmp, 'cosign.key') // outside the repo, or the key check refuses first
  writeFileSync(keyFile, 'not-a-real-key\n')
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts })
const git = (cwd, ...a) => run('git', ['-C', cwd, ...a])

let n = 0
/** A committed throwaway repo carrying the real sign-release.sh and the real scripts/verify tree. */
function repo() {
  n += 1
  const r = join(tmp, `repo-${n}`)
  mkdirSync(join(r, 'scripts/release'), { recursive: true })
  cpSync(join(REPO_ROOT, 'scripts/release/sign-release.sh'), join(r, 'scripts/release/sign-release.sh'))
  chmodSync(join(r, 'scripts/release/sign-release.sh'), 0o755)
  cpSync(join(REPO_ROOT, 'scripts/verify'), join(r, 'scripts/verify'), {
    recursive: true,
    filter: (src) => !/[\/]scripts[\/]verify[\/]out([\/]|$)/.test(src),
  })
  git(r, 'init', '-q')
  git(r, 'add', '-A')
  run('git', ['-C', r, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'fixture'])
  return { r, head: git(r, 'rev-parse', 'HEAD').stdout.trim() }
}

/** Writes scripts/verify/out/<head>.json (gitignored there, so the tree stays clean). */
function writeRecord(r, head, { failing = null } = {}) {
  const required = readFileSync(join(r, 'scripts/verify/required-suites.txt'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  const suites = Object.fromEntries(
    required.map((s) => [s, { status: s === failing ? 'fail' : 'pass', collected: 1, passed: 1, failed: 0, skipped: 0, reason: s === failing ? 'fixture' : null, durationMs: 1 }]),
  )
  mkdirSync(join(r, 'scripts/verify/out'), { recursive: true })
  writeFileSync(
    join(r, `scripts/verify/out/${head}.json`),
    JSON.stringify({ schemaVersion: 1, sha: head, only: null, partial: false, startedAt: 'x', finishedAt: 'y', deferred: [], suites, ok: !failing }),
  )
}

// A tag reference is refused by sign-release.sh AFTER the check-record step,
// so reaching this message proves check-record accepted the call.
const PROBE_REF = 'registry.example.invalid/gremion-ui:tag'
function sign(r) {
  const res = run('bash', [join(r, 'scripts/release/sign-release.sh'), '--key', keyFile, PROBE_REF], {
    cwd: r,
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
  })
  return { ...res, out: `${res.stdout}\n${res.stderr}` }
}

test('a complete green record for HEAD passes the real check-record.mjs: signing proceeds to the reference check', () => {
  const { r, head } = repo()
  writeRecord(r, head)
  const res = sign(r)
  assert.doesNotMatch(res.out, /usage error|no green check record/, res.out)
  assert.match(res.out, /\[check-record\] PASS/, res.out)
  assert.match(res.out, /not a digest reference/, res.out)
})

test('no record for HEAD is refused by the real check-record.mjs, with its own reason', () => {
  const { r } = repo()
  const res = sign(r)
  assert.notEqual(res.status, 0)
  assert.match(res.out, /no green check record for HEAD/, res.out)
  assert.match(res.out, /no result record for/, res.out)
  assert.doesNotMatch(res.out, /usage error/, res.out)
})

test('a record with a failing required suite is refused as not all-green', () => {
  const { r, head } = repo()
  writeRecord(r, head, { failing: 'unit' })
  const res = sign(r)
  assert.notEqual(res.status, 0)
  assert.match(res.out, /no green check record for HEAD/, res.out)
  assert.match(res.out, /not all-green/, res.out)
})
