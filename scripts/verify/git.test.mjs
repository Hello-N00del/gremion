// TASK-045 (Q5): unit tests for lib/git.mjs's isDirty. Uses a real scratch
// git repo (node:test's own t.mock is not enough here -- the bug this guards
// is specific to `git status`'s actual porcelain output for an untracked vs.
// an ignored file, which only a real `git status` call can prove).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { isDirty } from './lib/git.mjs'
import { run } from './lib/proc.mjs'

function initScratchRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-git-test-'))
  run('git', ['init', '-q'], { cwd: dir })
  run('git', ['config', 'user.email', 'verify-test@example.invalid'], { cwd: dir })
  run('git', ['config', 'user.name', 'verify test'], { cwd: dir })
  writeFileSync(path.join(dir, '.gitignore'), 'ignored.*\n')
  writeFileSync(path.join(dir, 'tracked.txt'), 'v1\n')
  run('git', ['add', '.'], { cwd: dir })
  run('git', ['commit', '-q', '-m', 'initial'], { cwd: dir })
  return dir
}

test('a clean scratch repo is not dirty', () => {
  const dir = initScratchRepo()
  try {
    assert.equal(isDirty(dir), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unstaged edit to a tracked file is dirty', () => {
  const dir = initScratchRepo()
  try {
    writeFileSync(path.join(dir, 'tracked.txt'), 'v2\n')
    assert.equal(isDirty(dir), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a new file that is untracked but NOT gitignored is dirty -- the forgotten `git add` case', () => {
  // Reproduces the real defect: a new migration/manifest file left on disk
  // without `git add` changes what gets tested without making the tree
  // "dirty" under the old --untracked-files=no flag.
  const dir = initScratchRepo()
  try {
    writeFileSync(path.join(dir, 'new-not-yet-added.sql'), 'select 1;\n')
    assert.equal(isDirty(dir), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a new file that IS gitignored is not dirty -- out/*.json and similar must stay excluded', () => {
  const dir = initScratchRepo()
  try {
    writeFileSync(path.join(dir, 'ignored.json'), '{}\n')
    assert.equal(isDirty(dir), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
