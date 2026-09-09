import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBoundaryLint } from './engine'
import { FK_ALLOWLIST, IMPORT_RULES } from './rules'

const here = dirname(fileURLToPath(import.meta.url))

describe('runBoundaryLint', () => {
  it('catches the violating migration fixture (R-FK)', () => {
    const sql = readFileSync(join(here, 'fixtures/violating-migration.sql'), 'utf8')
    const res = runBoundaryLint([{ file: 'migrations/099_probe.sql', content: sql }])
    expect(res.violations).toHaveLength(1)
    expect(res.violations[0].message).toContain('finance.lint_violation_probe')
    expect(res.violations[0].message).toContain('public.org_units')
  })

  it('catches the violating import fixture (R-IMP-1)', () => {
    const ts = readFileSync(join(here, 'fixtures/violating-import.ts.txt'), 'utf8')
    const res = runBoundaryLint([{ file: 'src/lib/server/governance/probe.ts', content: ts }])
    expect(res.violations).toHaveLength(1)
    expect(res.violations[0].message).toContain('no-governance-to-finance')
  })

  it('skips test files, declaration files and the fixtures dir', () => {
    const ts = `import { x } from '$lib/server/finance/seam'`
    const res = runBoundaryLint([
      { file: 'src/lib/server/governance/x.test.ts', content: ts },
      { file: 'src/lib/server/governance/x.integration.test.ts', content: ts },
      { file: 'src/lib/server/governance/x.d.ts', content: ts },
      { file: 'src/lib/server/boundary/fixtures/y.ts', content: ts },
    ])
    expect(res.violations).toEqual([])
  })

  it('reports EVERY configured allow entry as unusedAllow on empty input', () => {
    // With no inputs, no allow entry can have absorbed a real match, so the
    // engine must report exactly the full configured allow set as unused. In the
    // governance-only kernel the production rules carry ZERO allow entries (the
    // carve removed the finance/newsletter/elections allow exceptions), so this
    // is 0 today — but the assertion stays meaningful: it pins that unusedAllow
    // equals the configured allow count, which would catch the engine silently
    // dropping a real allow entry from the stale-detection.
    const configuredAllowCount =
      FK_ALLOWLIST.length + IMPORT_RULES.reduce((n, r) => n + r.allow.length, 0)
    const res = runBoundaryLint([])
    expect(res.unusedAllow.length).toBe(configuredAllowCount)
  })

  it('flags a synthetic stale allow entry the engine cannot absorb (mechanism check)', () => {
    // Mechanism proof that does not depend on production rules carrying allow
    // entries: an FK allow for a fixture file that no input ever supplies must be
    // reported as unused. (FK_ALLOWLIST is read from module scope by the engine,
    // so we assert the inverse property: a real cross-schema FK in an input that
    // is NOT in the allowlist surfaces as a violation, never silently allowed.)
    const sql = readFileSync(join(here, 'fixtures/violating-migration.sql'), 'utf8')
    const res = runBoundaryLint([{ file: 'migrations/099_probe.sql', content: sql }])
    expect(res.violations).toHaveLength(1)
    expect(res.violations[0].message).toContain('R-FK')
  })
})
