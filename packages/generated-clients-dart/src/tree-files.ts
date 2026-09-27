// packages/generated-clients-dart/src/tree-files.ts
//
// Which files count. The check compares, and the writer syncs, the
// COMMITTABLE files of a directory. In a git work tree that is
// `git ls-files --cached --others --exclude-standard`: tracked files (a
// force-added file under .dart_tool/ included) plus untracked files that are
// not ignored. Ignored local clutter (.DS_Store, build/, node_modules/) is
// neither flagged nor deleted. Outside git (unit fixtures) it is a filesystem
// walk that skips only .dart_tool/ at the walked root. A git failure throws:
// an empty list would read as "nothing there".
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Code-unit order, independent of the host locale. */
export function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function isGitWorkTree(repoRoot: string): boolean {
  return existsSync(join(repoRoot, '.git'))
}

/** Repo-relative, forward-slash paths of committable files matching the
 *  pathspecs, that exist on disk. */
export function gitListFiles(repoRoot: string, pathspecs: string[]): string[] {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspecs], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.error || r.status !== 0) throw new Error(`git ls-files failed (${r.error?.message ?? `exit ${r.status}`}): ${r.stderr}`)
  return [...new Set(r.stdout.split('\0').filter((f) => f.length > 0))].filter((f) => existsSync(join(repoRoot, f))).sort(byPath)
}

/** Every file under `dir` (dir-relative, forward-slash), skipping only
 *  `.dart_tool/` at its root. A symlink is listed as a file, never followed. */
export function listPackageFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs)) {
      if (rel === '' && name === '.dart_tool') continue
      const childAbs = join(abs, name)
      const childRel = rel === '' ? name : `${rel}/${name}`
      if (lstatSync(childAbs).isDirectory()) walk(childAbs, childRel)
      else out.push(childRel)
    }
  }
  walk(dir, '')
  return out.sort(byPath)
}

/** Committable files under repo-relative `relDir`, relative to it. */
export function listCommittable(repoRoot: string, relDir: string): string[] {
  if (!existsSync(join(repoRoot, relDir))) return []
  if (!isGitWorkTree(repoRoot)) return listPackageFiles(join(repoRoot, relDir))
  const prefix = `${relDir}/`
  return gitListFiles(repoRoot, [relDir]).filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length))
}
