import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// D5 (design v11) — Kalender-Gremien-Filterchips, source-scan style.
// The finding was implemented on the LIVE /calendar page (+page.svelte), whose
// inline chip strip previously (a) showed abbr-only monograms — the "2-letter
// squeeze" the finding forbids — and (b) toggled a local `activeCommittees` Set
// that never filtered anything (calendarFilter was never written). This test
// pins the corrected contract on the real render path, not the orphaned
// CalendarFilters.svelte component (which has no importers).
describe('D5 — calendar committee filter: readable hue chips that actually filter', () => {
  const src = readFileSync(join(__dirname, '+page.svelte'), 'utf8')

  test('chips carry the committee org-hue via the OrgTree --c formula', () => {
    expect(src).toContain('--c: hsl(var(--c-hue, 252) 55% 45%)')
    expect(src).toContain('--on-c: #fff')
    expect(src).toContain('style="--c-hue: {c.hue};"')
    expect(src).toContain('<span class="com-chip-tile"')
  })

  test('chips render the readable committee name — never a 2-letter squeeze', () => {
    expect(src).toContain('<span class="com-chip-name">{c.label}</span>')
    // the old abbr monogram gutter is gone
    expect(src).not.toContain('com-chip-gutter')
    expect(src).not.toContain('{c.abbr}')
  })

  test('an "Alle" chip leads the group and clears the filter', () => {
    expect(src).toContain('onclick={() => setCommittee(null)}')
    expect(src).toContain('aria-pressed={$calendarFilter.committeeId === null}')
  })

  test('chips are single-select and write the shared calendarFilter store', () => {
    // no dead local Set — the store is the single source of truth
    expect(src).not.toContain('activeCommittees')
    expect(src).toContain('function setCommittee(id: string | null)')
    expect(src).toMatch(/calendarFilter\.update\(\(f\) => \(\{ \.\.\.f, committeeId: id \}\)\)/)
    expect(src).toContain('aria-pressed={active}')
    // toggling the active chip clears the filter
    expect(src).toContain('onclick={() => setCommittee(active ? null : c.key)}')
  })

  test('touch target ≥ 28px and wrap allowed', () => {
    expect(src).toContain('min-height: 28px')
    expect(src).toContain('flex-wrap: wrap')
  })
})
