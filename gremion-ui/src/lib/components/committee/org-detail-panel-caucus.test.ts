import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// D6 (design v11) — Fraktions-Panel + Interpunkt, source-scan style (like
// chrome-notifications.test.ts). The caucus block must stay gated on the
// tenant term-map ('fraktionen' — kommunales Vokabular darf nicht in den
// StuRa-Mandanten lecken) and the member counts must render with real spaces
// around the interpunct.
describe('D6 — caucus panel is term-gated', () => {
  const src = readFileSync(join(__dirname, 'OrgDetailPanel.svelte'), 'utf8')

  test("the panel renders only when the tenant defines the 'fraktionen' term", () => {
    expect(src).toContain("termFor(terms ?? undefined, 'fraktionen', null)")
    expect(src).toMatch(/\{#if caucusTerm\}[\s\S]*?class="caucus-composition disabled"[\s\S]*?\{\/if\}/)
  })

  test('the term itself is the heading — the municipal literal is gone', () => {
    expect(src).toContain('<h4 class="cc-head mono">{caucusTerm}</h4>')
    // no hardcoded caucus vocabulary anywhere in the markup
    expect(src).not.toContain('>Fraktionszusammensetzung<')
  })

  test('the committees page hands the tenant term-map to the panel', () => {
    const page = readFileSync(
      join(__dirname, '../../../routes/committees/+page.svelte'),
      'utf8',
    )
    expect(page).toContain('<OrgDetailPanel node={selected} isAdmin={data.isAdmin} {terms} />')
  })
})

describe('D6 — member-count interpunct keeps its spaces', () => {
  const src = readFileSync(join(__dirname, 'OrgDetailPanel.svelte'), 'utf8')

  test('both counts live inside ONE block branch ("10 · 32 inkl. Untereinheiten")', () => {
    expect(src).toContain('{node.memberCount} · {node.rollupCount} inkl. Untereinheiten')
    // the old shape put the counts on opposite sides of the {#if} boundary,
    // which let Svelte trim the leading space → "10· 32"
    expect(src).not.toContain('{node.memberCount}{#if')
  })
})
