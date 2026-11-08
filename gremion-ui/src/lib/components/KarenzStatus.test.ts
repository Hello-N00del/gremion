import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/svelte'
import type { KarenzView } from '$lib/modules/switch-preview'
import KarenzStatus from './KarenzStatus.svelte'

// Module Karenz (phase 2, Task 17): what the settings page shows of one module in its 30 days. Days left,
// the restore button, problems in role=alert, the sealed copies as downloads and the backup link. The view
// is data from the server; nothing here may name the person who switched the module off.
const view = (over: Partial<KarenzView> = {}): KarenzView => ({
  karenzId: '55555555-5555-4555-8555-555555555555',
  state: 'open',
  switchedOffAt: '2026-11-05T09:00:00.000Z',
  finalAt: '2026-12-05T09:00:00.000Z',
  daysLeft: 25,
  canRestore: true,
  mail: { recipients: 2, failed: 0, skippedHolders: 0 },
  mailFailed: false,
  problems: [],
  retained: [],
  backupHref: '/settings/sicherungen',
  ...over,
})

const props = (k: KarenzView, extra: Record<string, unknown> = {}) => ({ karenz: k, busy: false, error: null, onrestore: vi.fn(), ...extra })

describe('KarenzStatus.svelte', () => {
  it('shows the days left and the final date', () => {
    const { container } = render(KarenzStatus, { props: props(view()) })
    const text = container.textContent ?? ''
    expect(text).toContain('Noch 25 Tage')
    expect(text).toContain('5. Dezember 2026')
  })

  it('says "1 Tag" for one day and names the day itself when none is left', () => {
    const one = render(KarenzStatus, { props: props(view({ daysLeft: 1 })) })
    expect(one.container.textContent).toContain('Noch 1 Tag ')
    one.unmount()
    const today = render(KarenzStatus, { props: props(view({ daysLeft: 0 })) })
    expect(today.container.textContent).toContain('heute')
  })

  it('the restore button calls onrestore; busy disables it', async () => {
    const p = props(view())
    const { unmount } = render(KarenzStatus, { props: p })
    await fireEvent.click(screen.getByRole('button', { name: 'Modul wieder einschalten' }))
    expect(p.onrestore).toHaveBeenCalledTimes(1)
    unmount()
    render(KarenzStatus, { props: props(view(), { busy: true }) })
    expect((screen.getByRole('button', { name: 'Modul wieder einschalten' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('without canRestore (restoring, finalizing) there is no restore button and the state is said in words', () => {
    const restoring = render(KarenzStatus, { props: props(view({ state: 'restoring', canRestore: false })) })
    expect(screen.queryByRole('button', { name: 'Modul wieder einschalten' })).toBeNull()
    expect(restoring.container.textContent).toContain('wird wiederhergestellt')
    restoring.unmount()
    const finalizing = render(KarenzStatus, { props: props(view({ state: 'finalizing', canRestore: false })) })
    expect(screen.queryByRole('button', { name: 'Modul wieder einschalten' })).toBeNull()
    expect(finalizing.container.textContent).toContain('endgültige Löschung läuft')
  })

  it('problems render in role=alert, one entry each', () => {
    render(KarenzStatus, { props: props(view({ problems: ['Schritt participant:votes:switchoff fehlgeschlagen: KarenzPartialError (2 item(s))', 'poll 42: Sperre abgelehnt'] })) })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('participant:votes:switchoff')
    expect(alert.textContent).toContain('poll 42')
    expect(alert.querySelectorAll('li')).toHaveLength(2)
  })

  it('no problems, no alert', () => {
    render(KarenzStatus, { props: props(view()) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('an error from a restore attempt is shown in role=alert too', () => {
    render(KarenzStatus, { props: props(view(), { error: 'Die Anfrage wurde nicht ausgeführt.' }) })
    expect(screen.getByRole('alert').textContent).toContain('Die Anfrage wurde nicht ausgeführt.')
  })

  it('retained downloads link to /api/settings/modules/retained?id= with the line count; the backup link is always there', () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000001'
    render(
      KarenzStatus,
      { props: props(view({ retained: [{ id, label: 'Beschlüsse und Abstimmungsergebnisse', lineCount: 7, href: `/api/settings/modules/retained?id=${id}` }] })) },
    )
    const link = screen.getByRole('link', { name: /Beschlüsse und Abstimmungsergebnisse/ })
    expect(link.getAttribute('href')).toBe(`/api/settings/modules/retained?id=${id}`)
    expect(link.textContent).toContain('7 Einträge')
    expect(screen.getByRole('link', { name: /Datensicherung/ }).getAttribute('href')).toBe('/settings/sicherungen')
  })

  it('names the holders who could not be mailed as a number, never by name', () => {
    const { container } = render(KarenzStatus, { props: props(view({ mail: { recipients: 1, failed: 0, skippedHolders: 3 } })) })
    expect(container.textContent).toContain('3 Personen')
  })

  it('no actor, no personal data in the rendered HTML (no address, no id other than the download links)', () => {
    const { container } = render(KarenzStatus, { props: props(view({ mail: { recipients: 2, failed: 1, skippedHolders: 1 } })) })
    const html = container.innerHTML
    expect(html).not.toMatch(/@/)
    expect(html).not.toMatch(/actor/i)
    expect(html).not.toContain('55555555-5555-4555-8555-555555555555')
  })
})
