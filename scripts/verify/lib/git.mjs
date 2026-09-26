// TASK-045: the two git facts verify.mjs needs -- HEAD's sha (what the record
// is keyed on) and whether the tracked tree is dirty (Q5, recommended default
// applied: refuse to run on a dirty tree, so a record's sha always describes
// the exact tree that was tested -- a record from a since-edited tree would
// silently authorize merging bytes nobody gated).
import { run } from './proc.mjs'

export function headSha(cwd = process.cwd()) {
  const res = run('git', ['rev-parse', 'HEAD'], { cwd })
  if (res.code !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${res.stderr || res.error}`)
  }
  return res.stdout.trim()
}

/**
 * True if the tracked tree differs from HEAD (staged or unstaged changes),
 * OR a non-ignored file is untracked (a `??` entry). `git status --porcelain`
 * never lists gitignored files unless `--ignored` is explicitly passed, so
 * scripts/verify/out/*.json and the per-run docker-compose override -- both
 * gitignored -- are excluded for free and do NOT need `--untracked-files=no`
 * to stay excluded. That flag's actual effect was excluding every OTHER
 * untracked file too: a new, not-yet-`git add`ed .sql migration or manifest
 * entry changes what gets tested without ever making the tree "dirty".
 * Reproduced: committing HEAD without a migration file the manifest still
 * lists, then leaving that file on disk untracked (no env var involved) gave
 * "PASS migration-hash" -- a green record for a HEAD that is red. Forgetting
 * `git add` on a new file is the most common way this happens.
 */
export function isDirty(cwd = process.cwd()) {
  const res = run('git', ['status', '--porcelain'], { cwd })
  if (res.code !== 0) {
    throw new Error(`git status failed: ${res.stderr || res.error}`)
  }
  return res.stdout.trim().length > 0
}
