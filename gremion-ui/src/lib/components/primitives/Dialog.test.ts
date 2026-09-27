// primitives/Dialog.svelte: WAI-ARIA APG modal dialog pattern on Bits UI.
// TASK-082 brief section 6 item 4 (modal.ts is the parity bar).
import { describe, test, expect, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { tick } from 'svelte'

import DialogHost from './__tests__/DialogHost.svelte'
import { mainContentLockCount } from './scroll-lock'
import { installDomShims } from './__tests__/dom-shims'

installDomShims()

const DE = {
  title: 'Sitzung anlegen',
  description: 'Termin und Ort festlegen',
  closeLabel: 'Dialog schließen',
  triggerLabel: 'Neue Sitzung',
  confirmLabel: 'Speichern',
}

async function open(user: ReturnType<typeof userEvent.setup>, name = DE.triggerLabel) {
  const trigger = screen.getByRole('button', { name })
  await user.click(trigger)
  await waitFor(() => expect(screen.getAllByRole('dialog').length).toBeGreaterThan(0))
  return trigger
}

beforeEach(() => {
  // Bits UI restores <body> styles on a short timer after the last modal
  // unmounts; a test that starts inside that window would inherit
  // pointer-events: none from the previous test's dialog.
  document.body.style.pointerEvents = ''
  document.body.style.overflow = ''
})

describe('primitives/Dialog', () => {
  test('is a modal dialog named by its title and described by its description', async () => {
    const user = userEvent.setup()
    render(DialogHost, { props: DE })
    await open(user)
    const dialog = screen.getByRole('dialog', { name: DE.title })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const labelledby = dialog.getAttribute('aria-labelledby')
    expect(labelledby).toBeTruthy()
    expect(document.getElementById(labelledby as string)?.textContent).toBe(DE.title)
    const describedby = dialog.getAttribute('aria-describedby')
    expect(document.getElementById(describedby as string)?.textContent).toBe(DE.description)
  })

  test('moves focus inside on open and Tab / Shift+Tab cycle within the dialog', async () => {
    const user = userEvent.setup()
    render(DialogHost, { props: DE })
    await open(user)
    const dialog = screen.getByRole('dialog', { name: DE.title })
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    const seen = new Set<Element>()
    for (let i = 0; i < 6; i++) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
      seen.add(document.activeElement as Element)
    }
    // input, confirm button and the close button: the cycle wraps, never escapes.
    expect(seen.size).toBeGreaterThanOrEqual(3)
    for (let i = 0; i < 6; i++) {
      await user.tab({ shift: true })
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })

  test('Escape closes it and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    render(DialogHost, { props: DE })
    const trigger = await open(user)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  test('the close button carries the closeLabel prop as its accessible name and closes', async () => {
    const user = userEvent.setup()
    render(DialogHost, { props: DE })
    const trigger = await open(user)
    await user.click(screen.getByRole('button', { name: DE.closeLabel }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  test('#main-content stays scroll-locked until the last of two stacked dialogs closes', async () => {
    const user = userEvent.setup()
    render(DialogHost, {
      props: { ...DE, nested: { title: 'Bestätigen', closeLabel: 'Schließen', triggerLabel: 'Weiter' } },
    })
    const main = document.getElementById('main-content') as HTMLElement
    expect(main.style.overflow).toBe('auto')
    await open(user)
    expect(main.style.overflow).toBe('hidden')
    await user.click(screen.getByRole('button', { name: 'Weiter' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Bestätigen' })).toBeTruthy())
    expect(mainContentLockCount()).toBe(2)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Bestätigen' })).toBeNull())
    await tick()
    expect(screen.getByRole('dialog', { name: DE.title })).toBeTruthy()
    expect(main.style.overflow).toBe('hidden')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(mainContentLockCount()).toBe(0)
    expect(main.style.overflow).toBe('auto')
  })
})
