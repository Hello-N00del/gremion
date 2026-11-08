import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import ModuleSwitchNotice from './ModuleSwitchNotice.svelte'

// Karenz phase 1, Task 12: the post-switch notice. Phase 1 never claims a mail was sent.
const base = { moduleLabel: 'Abstimmungen', action: 'enable' as const, outcome: null }

describe('ModuleSwitchNotice.svelte', () => {
  it.each(['queued', 'succeeded', 'applying'] as const)('%s reads "Anfrage wird ausgeführt" and is not a success', (state) => {
    const { container } = render(ModuleSwitchNotice, { props: { ...base, state } })
    expect(container.textContent).toContain('Anfrage wird ausgeführt')
    expect(container.textContent).not.toContain('ist eingeschaltet')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('an applying request with an error text shows that text in role=alert next to the running line', () => {
    render(ModuleSwitchNotice, { props: { ...base, state: 'applying', outcome: 'config.json not writable' } })
    expect(screen.getByRole('status').textContent).toContain('Anfrage wird ausgeführt')
    expect(screen.getByRole('alert').textContent).toContain('config.json not writable')
  })

  it('applied enable: "Modul Abstimmungen ist eingeschaltet" in role=status', () => {
    render(ModuleSwitchNotice, { props: { ...base, state: 'applied' } })
    expect(screen.getByRole('status').textContent).toContain('Modul Abstimmungen ist eingeschaltet')
  })

  it('applied disable: "ist ausgeschaltet"', () => {
    render(ModuleSwitchNotice, { props: { ...base, action: 'disable', state: 'applied' } })
    expect(screen.getByRole('status').textContent).toContain('Modul Abstimmungen ist ausgeschaltet')
  })

  it.each(['failed', 'refused', 'expired', 'dead'] as const)('%s shows the outcome text in role=alert with "nicht ausgeführt"', (state) => {
    render(ModuleSwitchNotice, { props: { ...base, state, outcome: 'DPIA gate refused: NO_DPIA_DECISION' } })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('nicht ausgeführt')
    expect(alert.textContent).toContain('DPIA gate refused: NO_DPIA_DECISION')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('a failure without an outcome text still says it was not executed', () => {
    render(ModuleSwitchNotice, { props: { ...base, state: 'failed' } })
    expect(screen.getByRole('alert').textContent).toContain('nicht ausgeführt')
  })

  it('claims no mail unless a mailLine is given', () => {
    const { container } = render(ModuleSwitchNotice, { props: { ...base, state: 'applied' } })
    expect(container.textContent).not.toMatch(/Mail/)
  })

  it('shows the mailLine when a caller supplies one (phase 2)', () => {
    const { container } = render(ModuleSwitchNotice, { props: { ...base, state: 'applied', mailLine: 'Info-Mail verschickt.' } })
    expect(container.textContent).toContain('Info-Mail verschickt.')
  })

  it('shows a mailAlert in role=alert when a caller supplies one, next to the switched notice', () => {
    render(ModuleSwitchNotice, { props: { ...base, action: 'disable', state: 'applied', mailAlert: 'Die Info-Mail konnte noch nicht zugestellt werden.' } })
    expect(screen.getByRole('alert').textContent).toContain('Die Info-Mail konnte noch nicht zugestellt werden.')
    expect(screen.getByRole('status').textContent).toContain('ausgeschaltet')
  })

  it('shows no mailAlert unless one is given', () => {
    render(ModuleSwitchNotice, { props: { ...base, state: 'applied' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
