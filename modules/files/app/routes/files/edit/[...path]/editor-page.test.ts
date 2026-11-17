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

  it('goes to the file folder 250 ms after Schließen when the browser did not close the tab', () => {
    vi.useFakeTimers()
    try {
      window.history.replaceState({}, '', '/files/edit/Protokolle/Sitzung.odt?tab=1')
      const close = vi.spyOn(window, 'close').mockImplementation(() => {})
      const { getByRole } = mount()
      getByRole('button', { name: 'Schließen' }).click()
      expect(close).toHaveBeenCalledTimes(1)
      expect(goto).not.toHaveBeenCalled()
      vi.advanceTimersByTime(249)
      expect(goto).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(goto).toHaveBeenCalledExactlyOnceWith('/files/Protokolle')
      // Nothing more happens by itself afterwards.
      vi.advanceTimersByTime(5000)
      expect(goto).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Schließen is usable again after the debounce when the page is still there (navigation interrupted)', () => {
    vi.useFakeTimers()
    try {
      window.history.replaceState({}, '', '/files/edit/Protokolle/Sitzung.odt?tab=1')
      const close = vi.spyOn(window, 'close').mockImplementation(() => {})
      const { getByRole } = mount()
      getByRole('button', { name: 'Schließen' }).click()
      vi.advanceTimersByTime(250)
      expect(goto).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(5000)
      getByRole('button', { name: 'Schließen' }).click()
      expect(close).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(250)
      expect(goto).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows a readable file name in the header, not the URL-encoded one', () => {
    const { getByTestId, container } = mount({ fileName: 'Protokoll%20Sitzung.docx', paramPath: 'Protokolle/Protokoll%20Sitzung.docx' })
    expect(getByTestId('editor-bar').textContent).toContain('Protokoll Sitzung.docx')
    expect(getByTestId('editor-bar').textContent).not.toContain('%20')
    expect((container.querySelector('iframe') as HTMLIFrameElement).getAttribute('title')).toBe('Protokoll Sitzung.docx')
    expect(document.title).toContain('Protokoll Sitzung.docx')
    expect(document.title).not.toContain('%20')
  })

  it('shows a malformed escape unchanged', () => {
    const { getByTestId } = mount({ fileName: '100%.docx' })
    expect(getByTestId('editor-bar').textContent).toContain('100%.docx')
  })

  it('renders the file name as text, never as HTML', () => {
    const { getByTestId } = mount({ fileName: '%3Cb%3Efett%3C%2Fb%3E.odt' })
    const bar = getByTestId('editor-bar')
    expect(bar.textContent).toContain('<b>fett</b>.odt')
    expect(bar.querySelector('b')).toBeNull()
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
