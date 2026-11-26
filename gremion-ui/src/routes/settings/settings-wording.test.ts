// German interface wording: no English or internal terms on the settings pages. The form of address
// (du/Sie) is deliberately not touched here.
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/svelte'
import de from '$lib/i18n/messages/de.json'
import TabServices from './tabs/TabServices.svelte'

describe('settings wording (German)', () => {
  it('Dienste & Portal: the help text carries no issue reference', () => {
    const { container } = render(TabServices, { props: { org: { name: 'Studierendenrat', domain: 'x.example.org', logo_path: null } } })
    const text = container.textContent ?? ''
    expect(text).toContain('Einzige Quelle')
    expect(text).not.toMatch(/#\d+/)
  })

  it('the German catalogue says DSFA, never DPIA, and names the organisation block in German', () => {
    const msgs = de as Record<string, string>
    expect(Object.entries(msgs).filter(([, v]) => /DPIA/.test(v)).map(([k]) => k)).toEqual([])
    expect(msgs['settings.org.branding.title']).toBe('Name und Erscheinungsbild')
  })
})
