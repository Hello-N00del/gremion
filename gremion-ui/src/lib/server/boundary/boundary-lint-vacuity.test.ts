// G-053-boundary-lint-vacuity (TASK-053, B32 Task 9; TRD-444): a full-tree
// boundary-lint run that scanned nothing is not a pass. Before the refusal,
// `boundary-lint.ts --all` printed `OK (0 file(s) checked, mode --all)` and
// exited 0 over an empty tree. These run the REAL CLI (post-condition: exit
// code AND the printed count), the way contracts-gate-runs.test.ts does.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const gremionUiRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..') // …/gremion-ui
const repoRoot = join(gremionUiRoot, '..')
// Never the OS tmpdir (TASK-053 rules): scripts/verify/out/ is gitignored.
const emptyRoot = join(repoRoot, 'scripts', 'verify', 'out', `boundary-lint-vacuity-empty-${process.pid}`)

function lint(...args: string[]) {
  const res = spawnSync('node', ['--import', 'tsx', join(gremionUiRoot, 'scripts/boundary-lint.ts'), ...args], {
    cwd: gremionUiRoot,
    encoding: 'utf8',
  })
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

beforeAll(() => {
  mkdirSync(emptyRoot, { recursive: true })
})
afterAll(() => {
  rmSync(emptyRoot, { recursive: true, force: true })
})

describe('boundary-lint --all vacuity refusal', () => {
  it('scans the real tree: more than 0 (and more than the 300 floor) files, exit 0', () => {
    const { status, out } = lint('--all', '--min-files', '300')
    expect(status, out).toBe(0)
    const m = out.match(/\[boundary-lint\] OK \((\d+) file\(s\) checked, mode --all\)/)
    expect(m, `no OK count line:\n${out}`).not.toBeNull()
    expect(Number(m![1])).toBeGreaterThan(300)
  }, 120_000)

  it('--root <empty dir> exits 1 with "scanned 0 file(s)" and never prints OK', () => {
    const { status, out } = lint('--all', '--root', emptyRoot)
    expect(status, out).toBe(1)
    expect(out).toContain('[boundary-lint] scanned 0 file(s)')
    expect(out).not.toContain('[boundary-lint] OK')
    // The refusal comes before runBoundaryLint: no allowlist output at all.
    expect(out).not.toContain('stale allowlist entry')
  }, 120_000)

  it('--min-files 100000 over the real tree exits 1 (below the floor)', () => {
    const { status, out } = lint('--all', '--min-files', '100000')
    expect(status, out).toBe(1)
    expect(out).toMatch(/\[boundary-lint\] scanned \d+ file\(s\) .*below the floor of 100000/)
  }, 120_000)
})
