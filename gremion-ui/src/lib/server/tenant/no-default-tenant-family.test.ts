// src/lib/server/tenant/no-default-tenant-family.test.ts
//
// TASK-042 (PRD-PLAT-012, TRD-075): the deletion assertion. The kernel boots
// with zero tenants, so nothing may remain of the env-derived `default` tenant
// family: no registerDefaultTenant / DEFAULT_TENANT / defaultTenantEnv
// identifier (T1), no branch on the literal slug or id 'default' (T2), no
// deployment.mode wizard gate (T3) and no `${slug}.${apexDomain}` host
// synthesis (T4).
//
// It scans the TRACKED files of the whole repository (git grep over the
// working tree, so an uncommitted edit counts and an untracked scratch file
// does not), never only `src`. Markdown, docs/** and the hash-locked
// migrations are out of scope; so are this file and its fixtures, which must
// name the patterns to prove them.
//
// Three properties keep the guard honest:
//   - vacuity: every family has a committed fixture under __fixtures__/ whose
//     every line the family's pattern must match, with the SAME git grep call;
//   - coverage: every family's scope lists a non-zero number of files and a
//     known carrier of that family's file type (zero files scanned fails);
//   - fail-closed: git grep exit 1 is "no match"; any other non-zero exit
//     throws instead of reading as clean.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..')
const SELF = 'gremion-ui/src/lib/server/tenant/no-default-tenant-family.test.ts'
const FIXTURE_DIR = 'gremion-ui/src/lib/server/tenant/__fixtures__/no-default-tenant-family'

/** Out of scope for every family (literal pathspecs, TASK-042 brief section 5). */
const BASE_EXCLUDES = [
  ':(exclude,glob)**/*.md',
  ':(exclude)*.md',
  ':(exclude)docs/**',
  ':(exclude,glob)**/migrations*/**',
  `:(exclude)${SELF}`,
  `:(exclude)${FIXTURE_DIR}/**`,
]

/** "Non-test" families also skip test sources. */
const TEST_EXCLUDES = [
  ':(exclude,glob)**/*.test.ts',
  ':(exclude,glob)**/*.test.mjs',
  ':(exclude,glob)**/*.spec.ts',
]

interface Family {
  id: string
  pattern: string
  /** Pathspecs the family scans (before BASE_EXCLUDES). */
  scope: string[]
  /** A tracked file the scope must list, so a broken pathspec cannot scan nothing. */
  sentinels: string[]
  /** Fixture files (under FIXTURE_DIR) whose every line the pattern must match. */
  fixtures: string[]
}

const T2_TYPES = [':(glob)**/*.ts', ':(glob)**/*.svelte', ':(glob)**/*.mjs', ':(glob)**/*.sh', ':(glob)**/*.bats']

export const FAMILIES: Family[] = [
  {
    id: 'T1 identifiers',
    pattern: String.raw`registerDefaultTenant|resolveDefaultTenantEnv|defaultTenantEnv|DEFAULT_TENANT|tenant/(register-default|default-tenant|default-env)`,
    scope: ['.'],
    sentinels: ['gremion-ui/src/hooks.server.ts', 'gremion-ui/scripts/run-migrations-verified.mjs', 'packages/storage/src/tenant.ts', 'scripts/check-realm-env.sh'],
    fixtures: ['t1-identifiers.txt'],
  },
  {
    id: 'T2 branches',
    pattern: [
      String.raw`(slug|id|tenantSlug)\s*[!=]==?\s*['"]default['"]`,
      String.raw`["']?\$\{?(slug|tenant_slug)\}?["']?\s*==?\s*["']default["']`,
      String.raw`BySlug\(\s*['"]default['"]`,
      String.raw`DEFAULT_SLUG`,
      String.raw`\bisDefault\b`,
      String.raw`\?\?\s*'default'`,
    ].join('|'),
    scope: [...T2_TYPES, ...TEST_EXCLUDES],
    sentinels: ['gremion-ui/src/lib/server/tenant/registry.ts', 'gremion-ui/scripts/run-migrations-verified.mjs', 'scripts/tenant-backup.sh', 'test/backup.bats', 'gremion-ui/src/routes/+layout.svelte'],
    fixtures: ['t2-branches.txt', 't2-shell.txt'],
  },
  {
    id: 'T3 gate',
    pattern: String.raw`deployment\.mode|deploymentMode|assertMultiTenantEnabled|loadDefaultConfig|wizard-gate`,
    scope: ['.'],
    sentinels: ['gremion-ui/src/lib/server/config.ts', 'gremion-ui/src/lib/server/tenant/provisioner/pipeline.ts'],
    fixtures: ['t3-gate.txt'],
  },
  {
    id: 'T4 synthesis',
    pattern: String.raw`\$\{[a-zA-Z.]*slug\}\.\$\{[a-zA-Z.]*apexDomain\}`,
    scope: ['.', ...TEST_EXCLUDES],
    sentinels: ['gremion-ui/src/lib/server/tenant/provisioner/pipeline.ts', 'gremion-ui/src/lib/server/tenant/provisioner/realm-doc.ts'],
    fixtures: ['t4-synthesis.txt'],
  },
]

export interface GitResult {
  status: number | null
  stdout: string
  stderr: string
}

export type GitRunner = (args: string[]) => GitResult

const runGit: GitRunner = (args) => {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw r.error
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/**
 * `git grep` that is only ever "clean" on exit 1. Exit 0 returns the hit
 * lines; exit 1 returns []; anything else (a bad pattern, a bad pathspec, a
 * missing git) throws, so a broken scan can never pass as an empty one.
 */
export function gitGrep(pattern: string, pathspecs: string[], opts: { untracked?: boolean } = {}, git: GitRunner = runGit): string[] {
  const args = ['grep', '-n', '-I', '-E', ...(opts.untracked ? ['--untracked'] : []), '-e', pattern, '--', ...pathspecs]
  const r = git(args)
  if (r.status === 1 && r.stdout.trim() === '') return []
  if (r.status === 0) return r.stdout.split('\n').filter((l) => l.trim() !== '')
  throw new Error(`git grep failed (exit ${r.status}): ${r.stderr.trim() || r.stdout.trim()}`)
}

function listScope(pathspecs: string[]): string[] {
  const r = runGit(['ls-files', '--', ...pathspecs])
  if (r.status !== 0) throw new Error(`git ls-files failed (exit ${r.status}): ${r.stderr.trim()}`)
  return r.stdout.split('\n').filter((l) => l.trim() !== '')
}

function readFixtureLines(file: string): string[] {
  const full = resolve(REPO_ROOT, FIXTURE_DIR, file)
  if (!existsSync(full)) throw new Error(`vacuity fixture missing: ${FIXTURE_DIR}/${file}`)
  return readFileSync(full, 'utf-8').split(/\r?\n/).filter((l) => l.trim() !== '')
}

describe('the default-tenant family is gone from the tracked tree (TASK-042 deletion assertion)', () => {
  for (const fam of FAMILIES) {
    describe(`${fam.id}`, () => {
      const pathspecs = [...fam.scope, ...BASE_EXCLUDES]

      it('scans a non-empty scope that lists its sentinel carriers and no markdown', () => {
        const files = listScope(pathspecs)
        expect(files.length).toBeGreaterThan(0)
        for (const s of fam.sentinels) expect(files).toContain(s)
        expect(files.filter((f) => f.endsWith('.md'))).toEqual([])
        expect(files.filter((f) => f.startsWith(`${FIXTURE_DIR}/`) || f === SELF)).toEqual([])
      })

      it('matches every line of its committed vacuity fixture (the pattern is not dead)', () => {
        for (const fixture of fam.fixtures) {
          const lines = readFixtureLines(fixture)
          expect(lines.length).toBeGreaterThan(0)
          const hits = gitGrep(fam.pattern, [`${FIXTURE_DIR}/${fixture}`], { untracked: true })
          expect(hits.length, `${fixture}: every fixture line must match ${fam.id}`).toBe(lines.length)
        }
      })

      it('finds no carrier in scope', () => {
        expect(gitGrep(fam.pattern, pathspecs)).toEqual([])
      })
    })
  }
})

describe('the scan itself is fail-closed', () => {
  it('a top-level markdown file (KNOWN_ISSUES.md) is outside every scope', () => {
    const all = listScope(['.'])
    expect(all).toContain('KNOWN_ISSUES.md')
    for (const fam of FAMILIES) {
      expect(listScope([...fam.scope, ...BASE_EXCLUDES])).not.toContain('KNOWN_ISSUES.md')
    }
  })

  it('a git grep that fails (exit other than 0/1) throws instead of reading as clean', () => {
    // An unbalanced group is a fatal pattern error in git grep (exit 128).
    expect(() => gitGrep('(', ['.'])).toThrow(/git grep failed/)
    // Any non-0/1 status, e.g. a forced exit 2, is a failure too.
    const forced: GitRunner = () => ({ status: 2, stdout: '', stderr: 'forced' })
    expect(() => gitGrep('x', ['.'], {}, forced)).toThrow(/exit 2/)
    // Exit 1 WITH output is not a clean result either.
    const odd: GitRunner = () => ({ status: 1, stdout: 'a:1:x\n', stderr: '' })
    expect(() => gitGrep('x', ['.'], {}, odd)).toThrow(/git grep failed/)
  })
})
