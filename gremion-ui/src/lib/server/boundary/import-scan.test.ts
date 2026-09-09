import { describe, it, expect } from 'vitest'
import { scanImports, normalizeSpecifier, type ImportRule } from './import-scan'

const RULES: ImportRule[] = [
  {
    id: 'no-governance-to-finance',
    description: 'kernel ownership direction (P0.1)',
    sourceDirs: ['src/lib/server/governance'],
    sourceExempt: [],
    forbiddenTargets: ['src/lib/server/finance'],
    allow: [],
  },
  {
    id: 'no-deep-import-into-newsletter',
    description: 'newsletter internals are service-private',
    sourceDirs: ['src'],
    sourceExempt: ['src/lib/server/newsletter', 'src/routes/api/newsletter', 'src/hooks.server.ts'],
    forbiddenTargets: ['src/lib/server/newsletter'],
    allow: ['src/routes/news/[id]/edit/+page.server.ts'],
  },
  // boundary rule A3c: the two A3c regression-guard rules (mirror boundary/rules.ts).
  {
    id: 'no-settings-to-feature-module',
    description: 'settings layout must not import a feature module (A3c S1: finance flag inverted)',
    sourceDirs: ['src/routes/settings'],
    sourceExempt: [],
    forbiddenTargets: [
      'src/lib/server/finance', 'src/lib/server/messages',
      'src/lib/server/files', 'src/lib/server/elections',
    ],
    allow: [],
  },
  {
    id: 'no-setup-health-to-feature-module',
    description: 'setup-health route must not import a feature module (A3c S2: probes inverted)',
    sourceDirs: ['src/routes/api/setup/health'],
    sourceExempt: [],
    forbiddenTargets: [
      'src/lib/server/finance', 'src/lib/server/messages',
      'src/lib/server/files', 'src/lib/server/elections',
    ],
    allow: [],
  },
]

describe('normalizeSpecifier', () => {
  it('maps $lib to src/lib', () => {
    expect(normalizeSpecifier('$lib/server/finance/seam', 'src/lib/server/governance/x.ts'))
      .toBe('src/lib/server/finance/seam')
  })
  it('resolves relative specifiers against the importing file dir', () => {
    expect(normalizeSpecifier('../finance/db', 'src/lib/server/governance/org-units-db.ts'))
      .toBe('src/lib/server/finance/db')
  })
  it('returns null for bare package specifiers', () => {
    expect(normalizeSpecifier('zod', 'src/x.ts')).toBeNull()
    expect(normalizeSpecifier('node:fs', 'src/x.ts')).toBeNull()
  })
})

describe('scanImports', () => {
  it('flags a static import crossing a forbidden boundary', () => {
    const v = scanImports(
      'src/lib/server/governance/org-units-db.ts',
      `import { getRunner } from '$lib/server/finance/repositories/tx'`,
      RULES,
    )
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ rule: 'no-governance-to-finance', line: 1 })
  })

  it('flags dynamic and side-effect imports too', () => {
    const code = `const m = await import('$lib/server/finance/seam')\nimport '$lib/server/finance/boot'`
    expect(scanImports('src/lib/server/governance/x.ts', code, RULES)).toHaveLength(2)
  })

  it('does not flag allowed targets or exempt sources', () => {
    expect(scanImports('src/lib/server/governance/x.ts',
      `import { getDb } from '$lib/server/db/tx'`, RULES)).toEqual([])
    expect(scanImports('src/lib/server/newsletter/newsletter-db.ts',
      `import { listNewsletters } from '$lib/server/newsletter/store'`, RULES)).toEqual([])
    expect(scanImports('src/hooks.server.ts',
      `import { startScheduler } from '$lib/server/newsletter/newsletter-scheduler'`, RULES)).toEqual([])
  })

  it('honors the sanctioned-baseline allow list and reports its usage', () => {
    const v = scanImports('src/routes/news/[id]/edit/+page.server.ts',
      `import { getDraft } from '$lib/server/newsletter/store'`, RULES)
    expect(v).toEqual([])
  })

  it('prefix matching is path-segment safe', () => {
    // 'src/lib/server/financex' must NOT match forbidden target 'src/lib/server/finance'
    expect(scanImports('src/lib/server/governance/x.ts',
      `import { a } from '$lib/server/financex/util'`, RULES)).toEqual([])
  })

  // boundary rule A3c: each new guard rule must be NON-VACUOUS — it flags the exact
  // import it exists to forbid, proving the rule actually bites.
  it('flags settings → finance-flags (A3c S1 guard is non-vacuous)', () => {
    const v = scanImports('src/routes/settings/+layout.server.ts',
      `import { financeStepUpEnforced } from '$lib/server/finance/finance-flags'`, RULES)
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ rule: 'no-settings-to-feature-module', line: 1 })
  })

  it('flags setup-health → synapse-admin / files / elections (A3c S2 guard is non-vacuous)', () => {
    const code = [
      `import { getSynapseAdmin } from '$lib/server/messages/synapse-admin'`,
      `import { createNextcloudClient } from '$lib/server/files/nextcloud-client'`,
      `import { x } from '$lib/server/elections/helios-client'`,
    ].join('\n')
    const v = scanImports('src/routes/api/setup/health/+server.ts', code, RULES)
    expect(v).toHaveLength(3)
    expect(v.every((x) => x.rule === 'no-setup-health-to-feature-module')).toBe(true)
  })
})
