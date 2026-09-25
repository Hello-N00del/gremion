import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { isDirty, headInfo, isGitRepo } from './git.mjs'

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ci-local-git-'))
  const run = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  run(['init', '-q', '-b', 'main'])
  run(['config', 'user.email', 'ci-local-test@example.invalid'])
  run(['config', 'user.name', 'ci-local-test'])
  writeFileSync(join(root, 'a.txt'), 'one\n')
  run(['add', 'a.txt'])
  run(['commit', '-q', '-m', 'first'])
  return root
}

test('isDirty is false on a freshly committed clean repo', () => {
  const root = makeRepo()
  try {
    assert.equal(isDirty(root), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isDirty goes RED (true) on an unstaged edit', () => {
  const root = makeRepo()
  try {
    appendFileSync(join(root, 'a.txt'), 'two\n')
    assert.equal(isDirty(root), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isDirty goes RED (true) on an untracked file — a snapshot must not run next to an untracked fixture', () => {
  const root = makeRepo()
  try {
    writeFileSync(join(root, 'untracked.txt'), 'surprise\n')
    assert.equal(isDirty(root), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('headInfo reports a 40-char sha, its 7-char prefix, and the branch name', () => {
  const root = makeRepo()
  try {
    const info = headInfo(root)
    assert.equal(info.sha.length, 40)
    assert.equal(info.shortSha, info.sha.slice(0, 7))
    assert.equal(info.branch, 'main')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isGitRepo is true for a real repo and false for a plain directory', () => {
  const repo = makeRepo()
  const plain = mkdtempSync(join(tmpdir(), 'ci-local-notgit-'))
  // LOW fix: this assertion depends on its environment — it went RED
  // whenever os.tmpdir() itself sits inside a git work tree (e.g. TMP
  // pointed at a worktree's own .scratch dir), because git's normal upward
  // search from `plain` then finds that ANCESTOR .git and reports it as
  // "inside a work tree" too. GIT_CEILING_DIRECTORIES tells git never to
  // search above tmpdir(), so `plain` (which has no .git of its own) is
  // judged on its own merits regardless of what encloses the temp dir on
  // this machine.
  const savedCeiling = process.env.GIT_CEILING_DIRECTORIES
  process.env.GIT_CEILING_DIRECTORIES = tmpdir()
  try {
    assert.equal(isGitRepo(repo), true)
    assert.equal(isGitRepo(plain), false)
  } finally {
    if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES
    else process.env.GIT_CEILING_DIRECTORIES = savedCeiling
    rmSync(repo, { recursive: true, force: true })
    rmSync(plain, { recursive: true, force: true })
  }
})

test('headInfo reports a detached HEAD as "(detached)", not the literal "HEAD" git prints for it', () => {
  const root = makeRepo()
  try {
    const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    execFileSync('git', ['-C', root, 'checkout', '-q', '--detach', sha])
    assert.equal(headInfo(root).branch, '(detached)')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
