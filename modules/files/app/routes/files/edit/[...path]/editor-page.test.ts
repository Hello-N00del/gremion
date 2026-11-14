import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte'

const goto = vi.hoisted(() => vi.fn())
vi.mock('$app/navigation', () => ({ goto }))

import Page from './+page.svelte'

const COLLABORA = 'https://office.example.test'

function data(over: Record<string, unknown> = {}) {
  return {
    editorUrl: `${COLLABORA}/browser/abc/cool.html?WOPISrc=wopi&access_token=tok`,
    tokenTtl: Math.floor(Date.now() / 1000) + 3600,
    fileName: 'Sitzung.odt',
    backPath: '/files/Protokolle',
    paramPath: 'Protokolle/Sitzung.odt',
    ...over
  }
}

function mount(over: Record<string, unknown> = {}) {
  return render(Page, { props: { data: data(over) } as never })
}

function collaboraSays(message: Record<string, unknown>, origin = COLLABORA) {
  window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message), origin }))
}

beforeEach(() => {
  goto.mockReset()
  window.history.replaceState({}, '', '/files/edit/Protokolle/Sitzung.odt')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('document editor page', () => {
  it('fills the viewport with a thin bar (file name, Schließen) and the Collabora iframe', () => {
    const { container, getByRole, getByTestId } = mount()
    const bar = getByTestId('editor-bar')
    expect(bar.textContent).toContain('Sitzung.odt')
    expect(getByRole('button', { name: 'Schließen' })).toBeTruthy()
    const frame = container.querySelector('iframe') as HTMLIFrameElement
    expect(frame.getAttribute('src')).toContain('closebutton=1')
    // Dynamic viewport height: 100vh is taller than the visible area behind a phone's address bar.
    const root = getByTestId('editor-root')
    expect(root.getAttribute('style')).toContain('100dvh')
    expect(root.getAttribute('style')).not.toContain('100vh')
  })

  it('closes its own tab on Schließen when the app opened it', () => {
    window.history.replaceState({}, '', '/files/edit/Protokolle/Sitzung.odt?tab=1')
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})
    const { getByRole } = mount()
    getByRole('button', { name: 'Schließen' }).click()
    expect(close).toHaveBeenCalledTimes(1)
    expect(goto).not.toHaveBeenCalled()
  })

  it('goes to the file folder on Schließen when the tab was not opened by the app', () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})
    const { getByRole } = mount()
    getByRole('button', { name: 'Schließen' }).click()
    expect(close).not.toHaveBeenCalled()
    expect(goto).toHaveBeenCalledExactlyOnceWith('/files/Protokolle')
  })

  it("treats Collabora's own close button like Schließen", () => {
    window.history.replaceState({}, '', '/files/edit/Protokolle/Sitzung.odt?tab=1')
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})
    mount()
    collaboraSays({ MessageId: 'App_Close_Requested' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('goes to the file folder on the Collabora close request in a tab the app did not open', () => {
    mount()
    collaboraSays({ MessageId: 'App_Close_Requested' })
    expect(goto).toHaveBeenCalledExactlyOnceWith('/files/Protokolle')
  })

  it('closes once when Schließen and the Collabora close request both fire', () => {
    window.history.replaceState({}, '', '/files/edit/Protokolle/Sitzung.odt?tab=1')
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})
    const { getByRole } = mount()
    getByRole('button', { name: 'Schließen' }).click()
    collaboraSays({ MessageId: 'App_Close_Requested' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('Schließen works again when the browser did not close the tab (an interrupted close, a refused window.close)', () => {
    vi.useFakeTimers()
    try {
      window.history.replaceState({}, '', '/files/edit/Protokolle/Sitzung.odt?tab=1')
      const close = vi.spyOn(window, 'close').mockImplementation(() => {})
      const { getByRole } = mount()
      getByRole('button', { name: 'Schließen' }).click()
      expect(close).toHaveBeenCalledTimes(1)
      // The tab is still open a moment later: the person is not left with an inert button.
      vi.advanceTimersByTime(5000)
      getByRole('button', { name: 'Schließen' }).click()
      expect(close).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a close request from any other origin', () => {
    mount()
    collaboraSays({ MessageId: 'App_Close_Requested' }, 'https://evil.example.test')
    expect(goto).not.toHaveBeenCalled()
  })

  it('keeps the save-error banner and lets the person dismiss it', async () => {
    const { findByText, getByRole, queryByText } = mount()
    collaboraSays({ MessageId: 'Action_Save_Resp', Values: { success: false, result: 'Speichern fehlgeschlagen' } })
    expect(await findByText('Speichern fehlgeschlagen')).toBeTruthy()
    await fireEvent.click(getByRole('button', { name: 'Hinweis ausblenden' }))
    await waitFor(() => expect(queryByText('Speichern fehlgeschlagen')).toBeNull())
  })
})
