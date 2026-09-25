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
 * True if any TRACKED file differs from HEAD (staged or unstaged). Untracked
 * files are deliberately ignored -- scripts/verify/out/*.json and the
 * per-run docker-compose override are gitignored and untracked by
 * definition, and would otherwise make `verify` refuse to run against its
 * own output.
 */
export function isDirty(cwd = process.cwd()) {
  const res = run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd })
  if (res.code !== 0) {
    throw new Error(`git status failed: ${res.stderr || res.error}`)
  }
  return res.stdout.trim().length > 0
}
