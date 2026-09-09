import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname, relative, sep } from 'node:path'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..') // gremion-ui/src
// Carve note: routes/finance was git-rm'd with the finance module, so it is no
// longer scanned here; the remaining kernel authz surfaces stay covered.
const ROOTS = ['lib/auth', 'lib/components', 'lib/modules']
const GROUP_LITERAL = /['"`]ref-finanzen(?:-[a-z]+)?['"`]/
const EXCLUDE = (rel: string) => {
  const p = rel.split(sep).join('/')
  return (
    // The finance module manifest is the canonical home for the ref-finanzen
    // group literals (Pillar-1 P0.1); capabilities.ts now only re-exports them.
    p.endsWith('manifests/finance.ts') ||
    // labels.ts was allowlisted here while it still carried four ref-finanzen*
    // GROUP_LABELS entries. The kernel is governance-only, so those entries were
    // stripped and the exemption with them — labels.ts is now held to the same
    // zero-literal rule as the rest of the authz surface.
    p.includes('member-view') ||
    p.endsWith('no-hardcoded-groups.test.ts') ||
    /\.test\.ts$/.test(p) ||
    /\.spec\.ts$/.test(p)
  )
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) walk(abs, acc)
    else if (/\.(ts|svelte)$/.test(e.name)) acc.push(abs)
  }
  return acc
}

describe('no hardcoded finance group literals outside capabilities.ts (#203)', () => {
  test('authz surface is clean', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      const rootDir = join(SRC, root)
      for (const abs of walk(rootDir)) {
        const rel = relative(SRC, abs)
        if (EXCLUDE(rel)) continue
        if (GROUP_LITERAL.test(readFileSync(abs, 'utf-8'))) {
          offenders.push(rel.split(sep).join('/'))
        }
      }
    }
    expect(
      offenders,
      `migrate these to $lib/auth/capabilities: ${offenders.join(', ')}`
    ).toEqual([])
  })
})
