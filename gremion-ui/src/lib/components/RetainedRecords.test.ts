import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import RetainedRecords from './RetainedRecords.svelte'

// Module Karenz (phase 2, Task 19): the sealed retained copies of a previous period, shown read-only on
// the module page after a fresh start. Counts and dates come only from the records.
const R1 = { id: '55555555-5555-4555-8555-555555555551', label: 'Wahlergebnisse', labelKey: 'settings.modules.karenz.retained.label.elections', createdAt: '2026-10-01T10:00:00.000Z', lineCount: 3, href: '/api/settings/modules/retained?id=55555555-5555-4555-8555-555555555551' }
const R2 = { id: '55555555-5555-4555-8555-555555555552', label: 'Wahlergebnisse', labelKey: 'settings.modules.karenz.retained.label.elections', createdAt: '2026-03-15T09:30:00.000Z', lineCount: 1, href: '/api/settings/modules/retained?id=55555555-5555-4555-8555-555555555552' }

describe('RetainedRecords.svelte', () => {
  it('lists each copy with its title, sealed date, line count and a download link', () => {
    render(RetainedRecords, { props: { records: [R1, R2], moduleLabel: 'Wahlen' } })
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain('Wahlergebnisse')
    expect(items[0]!.textContent).toContain('1. Oktober 2026')
    expect(items[0]!.textContent).toContain('3 Einträge')
    expect(items[1]!.textContent).toContain('15. März 2026')
    expect(items[1]!.textContent).toContain('1 Eintrag')
    expect(items[1]!.textContent).not.toContain('1 Einträge')
    const links = screen.getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).toEqual([R1.href, R2.href])
  })

  it('names the module and says the copies are read-only', () => {
    const { container } = render(RetainedRecords, { props: { records: [R1], moduleLabel: 'Wahlen' } })
    expect(container.textContent).toContain('Wahlen')
    expect(container.textContent).toContain('schreibgeschützt')
  })

  it('renders nothing for an empty list', () => {
    const { container } = render(RetainedRecords, { props: { records: [], moduleLabel: 'Wahlen' } })
    expect(container.textContent?.trim()).toBe('')
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByRole('heading')).toBeNull()
  })

  it('renders nothing, and does not throw, when the page hands it no list at all (a page whose data lacks the key)', () => {
    // the votes reflow browser test mounts the page with data that has no retainedRecords key
    const { container } = render(RetainedRecords, { props: { moduleLabel: 'Wahlen' } as never })
    expect(container.textContent?.trim()).toBe('')
  })

  it('shows the title from the message catalogue by labelKey, not the label text the record carries', () => {
    const { container } = render(RetainedRecords, { props: { records: [{ ...R1, label: 'API-ONLY-TEXT', labelKey: 'settings.modules.karenz.retained.label.votes' }], moduleLabel: 'Wahlen' } })
    expect(container.textContent).toContain('Umfrageergebnisse')
    expect(container.textContent).not.toContain('API-ONLY-TEXT')
    expect(screen.getByRole('link').getAttribute('aria-label')).toContain('Umfrageergebnisse')
  })

  it('has no edit or delete control: no button, form, input or editable element in the markup', () => {
    const { container } = render(RetainedRecords, { props: { records: [R1, R2], moduleLabel: 'Wahlen' } })
    expect(container.querySelectorAll('button, form, input, select, textarea, [contenteditable], [role="button"]')).toHaveLength(0)
    expect(container.textContent).not.toMatch(/löschen|bearbeiten|entfernen|delete|edit/i)
  })

  it('the component source has no event handler, form or fetch', () => {
    const src = readFileSync(join(import.meta.dirname, 'RetainedRecords.svelte'), 'utf8')
    expect(src).not.toMatch(/<button|<form|<input|onclick|onsubmit|fetch\(|method=|use:enhance/i)
  })

  it('shows no actor and no personal data: only title, date, count and link per record', () => {
    const { container } = render(RetainedRecords, { props: { records: [R1], moduleLabel: 'Wahlen' } })
    expect(container.innerHTML).not.toMatch(/@|actor|userId/i)
  })
})
