// packages/generated-clients-dart/src/repo-root.ts (copied from the TS sibling: read the pattern, never import it — brief §3)
//
// Every module in this package reads real files under contracts/ at the
// repository root. `process.cwd()` is NOT that root reliably — `pnpm --filter`
// runs a package's scripts with cwd set to the PACKAGE directory, and a test
// runner invoked from the repo root behaves differently again. Walk up from
// this file's own location (stable under both bundler and nodenext resolution)
// until a directory carries `pnpm-workspace.yaml`, the one file that names the
// workspace root and nothing else in the tree does.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function findRepoRoot(startDir: string): string {
  let dir = startDir
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`could not find repository root (pnpm-workspace.yaml) walking up from ${startDir}`)
}

/** The repository root, resolved once from this module's own file location. */
export const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)))
