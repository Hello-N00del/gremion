import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/svelte'
import { RETENTION_CAVEATS, RETENTION_DEFAULTS, RETENTION_FIELDS } from '$lib/retention-tiers'
import TabRetention from './TabRetention.svelte'

// TASK-033-a (Q6): the tab shows the fixed windows and cannot change them. A window
// no application purge enforces still carries its visible caveat (R29-RETENTION-30-K).
describe('TabRetention.svelte', () => {
  const blockText = (container: HTMLElement, field: string): string => {
    const block = container.querySelector(`[data-retention-field="${field}"]`)
    expect(block, `block ${field} missing`).not.toBeNull()
    return block!.textContent ?? ''
  }

  it('is read-only: no input, no button, no save', () => {
    const { container } = render(TabRetention)
    expect(container.querySelectorAll('input, button, select, textarea')).toHaveLength(0)
    expect(container.textContent).not.toContain('Speichern')
  })

  it.each(RETENTION_FIELDS)('%s: shows the enforced window from the tier module', (field) => {
    const { container } = render(TabRetention)
    expect(blockText(container, field)).toContain(`${RETENTION_DEFAULTS[field]} Tage`)
  })

  it.each(RETENTION_FIELDS.filter((f) => RETENTION_CAVEATS[f] !== null))('%s: a window the application does not delete itself carries its caveat', (field) => {
    const { container } = render(TabRetention)
    expect(blockText(container, field)).toContain(String(RETENTION_CAVEATS[field]))
  })

  it.each(RETENTION_FIELDS.filter((f) => RETENTION_CAVEATS[f] === null))('%s: an enforced window shows no caveat', (field) => {
    const { container } = render(TabRetention)
    expect(blockText(container, field)).not.toContain('Konfigurationswert')
  })

  it('the help text says the windows are fixed and that the audit table is a governance record no timer deletes', () => {
    const { container } = render(TabRetention)
    const help = container.querySelector('p')!.textContent ?? ''
    expect(help).toContain('fest vorgegeben')
    expect(help).toContain('Audit-Tabelle')
    expect(help).toContain('RC-GOV-CHAIN')
    expect(help).toContain('keinem Zeitgeber')
    expect(help).not.toContain('täglich automatisch gelöscht')
    expect(help).not.toContain('Sicherheits-/Auditprotokolle')
  })

  it('names the operator decision with its date, not a plan id', () => {
    const { container } = render(TabRetention)
    expect(container.textContent).toContain('Betreiberentscheidung vom 30.09.2026')
    expect(container.textContent).not.toMatch(/R29-I6|R31-I|TASK-\d/)
  })
})
