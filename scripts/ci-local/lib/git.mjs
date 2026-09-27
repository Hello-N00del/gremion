// Thin git wrappers. Every function takes a repo root and shells out with
// `-C <root>`, so callers can point at a real worktree OR a scratch clone —
// this file never assumes it is running inside the repo it inspects, which is
// exactly what guard-efficacy scratch clones and the StuRaOS read-only path
// both need.

import { execFileSync } from 'node:child_process'

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

/**
 * True if the working tree at `root` has any uncommitted change — staged,
 * unstaged, or untracked. `--porcelain` with no `-uno` deliberately includes
 * untracked files: a snapshot taken next to an untracked secret fixture is
 * exactly the "dirty tree" TASK-012 must refuse.
 */
export function isDirty(root) {
  const out = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' })
  return out.trim().length > 0
}

/** { sha, shortSha, branch } for HEAD at `root`. */
export function headInfo(root) {
  const sha = git(root, ['rev-parse', 'HEAD'])
  const shortSha = sha.slice(0, 7)
  let branch
  try {
    branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  } catch {
    branch = '(detached)'
  }
  // `rev-parse --abbrev-ref HEAD` prints the literal "HEAD" (and exits 0)
  // on a detached HEAD, so the catch above never sees that case.
  if (branch === 'HEAD') branch = '(detached)'
  return { sha, shortSha, branch }
}

/** True if `root` is inside a git working tree at all (vs. a plain directory). */
export function isGitRepo(root) {
  try {
    git(root, ['rev-parse', '--is-inside-work-tree'])
    return true
  } catch {
    return false
  }
}
