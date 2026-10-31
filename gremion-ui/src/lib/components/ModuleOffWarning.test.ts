import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/svelte'
import type { ModuleDeletionPreview } from '$lib/modules/switch-preview'
import ModuleOffWarning from './ModuleOffWarning.svelte'

// Karenz phase 1, Task 12: the red typed-name warning before a module is switched OFF. Built and tested
// now, reachable only once phase 2 flips COUNCIL_DISABLE_ALLOWED (graceDays null renders a neutral
// "not yet available" notice and NO confirm button, never a sentence that promises removal).
const preview = (over: Partial<ModuleDeletionPreview> = {}): ModuleDeletionPreview => ({
  moduleId: 'votes',
  moduleLabel: 'Abstimmungen',
  confirmPhrase: 'Abstimmungen',
  deletes: [
    { key: 'open', label: 'Offene Abstimmungen', count: 3, unit: 'Abstimmungen' },
    { key: 'archive', label: 'Archiv', count: null, unit: '' },
  ],
  retained: [],
  graceDays: 30,
  finalDeletionAt: '2026-12-01',
  recoverable: true,
  ...over,
})

const props = (p: ModuleDeletionPreview, extra: Record<string, unknown> = {}) => ({
  preview: p,
  busy: false,
  error: null,
  onconfirm: vi.fn(),
  oncancel: vi.fn(),
  ...extra,
})

const confirmButton = () => screen.queryByRole('button', { name: 'Modul ausschalten' }) as HTMLButtonElement | null
const typeInto = async (value: string) => fireEvent.input(screen.getByLabelText(/Namen des Moduls/), { target: { value } })

describe('ModuleOffWarning.svelte', () => {
  it('with graceDays 30 renders the module label, every deletes item and the grace sentence', () => {
    const { container } = render(ModuleOffWarning, { props: props(preview()) })
    const text = container.textContent ?? ''
    expect(text).toContain('Abstimmungen')
    expect(text).toContain('Offene Abstimmungen')
    expect(text).toContain('3 Abstimmungen')
    expect(text).toContain('Archiv')
    expect(text).toMatch(/nach 30 Tagen/)
    expect(text).toMatch(/wieder eingeschaltet/)
  })

  it('with graceDays null renders the not-yet-available notice, NO confirm button and no sentence that promises removal', () => {
    const { container } = render(ModuleOffWarning, { props: props(preview({ graceDays: null, finalDeletionAt: null, recoverable: false })) })
    expect(container.textContent).toContain('Das Ausschalten von Modulen ist noch nicht freigegeben')
    expect(confirmButton()).toBeNull()
    expect(container.querySelector('input')).toBeNull()
    expect(container.textContent).not.toMatch(/gelöscht|Tagen/)
  })

  it('the confirm button stays disabled for "", "abstimmungen", " Abstimmungen " and a Cyrillic look-alike, and enables for the exact label', async () => {
    render(ModuleOffWarning, { props: props(preview()) })
    expect(confirmButton()!.disabled).toBe(true)
    for (const wrong of ['', 'abstimmungen', ' Abstimmungen ', 'Abstimmungеn' /* Cyrillic e */, 'Abstimmung']) {
      await typeInto(wrong)
      expect(confirmButton()!.disabled, JSON.stringify(wrong)).toBe(true)
    }
    await typeInto('Abstimmungen')
    expect(confirmButton()!.disabled).toBe(false)
  })

  it('a decomposed-umlaut input enables the button for a composed label (NFC), and not for a different one', async () => {
    render(ModuleOffWarning, { props: props(preview({ moduleLabel: 'Übersicht', confirmPhrase: 'Übersicht' })) })
    await typeInto('Übersicht')
    expect(confirmButton()!.disabled).toBe(false)
    await typeInto('Ubersicht')
    expect(confirmButton()!.disabled).toBe(true)
  })

  it('confirming hands the typed text to onconfirm; cancelling calls oncancel', async () => {
    const p = props(preview())
    render(ModuleOffWarning, { props: p })
    await typeInto('Abstimmungen')
    await fireEvent.click(confirmButton()!)
    expect(p.onconfirm).toHaveBeenCalledWith('Abstimmungen')
    await fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }))
    expect(p.oncancel).toHaveBeenCalledTimes(1)
  })

  it('busy disables the confirm button even with the right text; an error is shown in role=alert', async () => {
    render(ModuleOffWarning, { props: props(preview(), { busy: true, error: 'Anfrage abgelehnt' }) })
    await typeInto('Abstimmungen')
    expect(confirmButton()!.disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('Anfrage abgelehnt')
  })

  it('a null count renders "alle Daten", a retained list is shown when non-empty', () => {
    const { container } = render(ModuleOffWarning, {
      props: props(preview({ retained: [{ key: 'minutes', label: 'Protokolle', basis: 'gesetzliche Aufbewahrung' }] })),
    })
    expect(container.textContent).toContain('alle Daten')
    expect(container.textContent).toContain('Protokolle')
    expect(container.textContent).toContain('gesetzliche Aufbewahrung')
  })

  it('has a labelled alertdialog region and the input is reachable by its label', () => {
    render(ModuleOffWarning, { props: props(preview()) })
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent).toContain('Abstimmungen')
    expect(screen.getByLabelText(/Namen des Moduls/)).toBeTruthy()
  })

  it('uses the red (rust) error tokens of the design system, no new colour', () => {
    const { container } = render(ModuleOffWarning, { props: props(preview()) })
    const cls = container.querySelector('[role="alertdialog"]')!.className
    expect(cls).toMatch(/rust/)
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,6}|rgb\(/)
  })
})
