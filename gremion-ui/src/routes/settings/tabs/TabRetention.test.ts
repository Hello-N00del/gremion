import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/svelte'
import { RETENTION_CAVEATS, RETENTION_DEFAULTS, RETENTION_FIELDS } from '$lib/retention-tiers'
import TabRetention from './TabRetention.svelte'

// R29-RETENTION-30-K [D R29-I6]: a retention window no gremion-ui purge consumer
// enforces must be shown as configuration with a visible caveat, never as an
// enforced deletion period. The field block is the input's parent element.
describe('TabRetention.svelte', () => {
  const blockText = (container: HTMLElement, field: string): string => {
    const input = container.querySelector(`#${field}`)
    expect(input, `input #${field} missing`).not.toBeNull()
    return input!.parentElement!.textContent ?? ''
  }

  const UNENFORCED = RETENTION_FIELDS.filter((f) => RETENTION_CAVEATS[f] !== null)
  const ENFORCED = RETENTION_FIELDS.filter((f) => RETENTION_CAVEATS[f] === null)

  it.each(UNENFORCED)('%s: no purge consumer enforces the window, so the caveat is shown', (field) => {
    const { container } = render(TabRetention, { retention: { ...RETENTION_DEFAULTS } })
    expect(blockText(container, field)).toContain(String(RETENTION_CAVEATS[field]))
  })

  it.each(ENFORCED)('%s: a purge consumer enforces the window, so no caveat is shown', (field) => {
    const { container } = render(TabRetention, { retention: { ...RETENTION_DEFAULTS } })
    expect(blockText(container, field)).not.toContain('Konfigurationswert')
  })

  it('at least one tier is unenforced (the guard is not vacuous)', () => {
    expect(UNENFORCED.length).toBeGreaterThan(0)
  })

  it('the help text says which windows the application enforces itself', () => {
    const { container } = render(TabRetention, { retention: { ...RETENTION_DEFAULTS } })
    const help = container.querySelector('p')!.textContent ?? ''
    expect(help).toContain('Sicherheits-/Auditprotokolle')
    expect(help).toContain('nicht automatisch')
  })

  it('names the operator decision with its date, not a plan id', () => {
    const { container } = render(TabRetention, { retention: { ...RETENTION_DEFAULTS } })
    expect(container.textContent).toContain('Betreiberentscheidung vom 30.09.2026')
    expect(container.textContent).not.toMatch(/R29-I6|R31-I|TASK-\d/)
  })
})
