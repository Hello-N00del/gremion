import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeEditor, editorTabHref, openedInOwnTab } from './editor-close'

function fakeWindow(opts: { opener?: unknown; search?: string; closesOnClose?: boolean }) {
  const win = {
    opener: opts.opener ?? null,
    closed: false,
    location: { search: opts.search ?? '' },
    close: vi.fn(() => {
      // A browser only honours close() for a tab it considers script-closable.
      if (opts.closesOnClose ?? true) win.closed = true
    })
  }
  return win
}

describe('editorTabHref', () => {
  it('marks the link as the app-opened editor tab and keeps the path as given', () => {
    expect(editorTabHref('/Protokolle/Sitzung%201.odt')).toBe('/files/edit/Protokolle/Sitzung%201.odt?tab=1')
  })
})

describe('openedInOwnTab', () => {
  it('is true with the tab marker (the link is noopener, so window.opener is null)', () => {
    expect(openedInOwnTab(fakeWindow({ search: '?tab=1' }))).toBe(true)
  })
  it('is true when the window has an opener', () => {
    expect(openedInOwnTab(fakeWindow({ opener: {} }))).toBe(true)
  })
  it('is false for a direct visit or a bookmark', () => {
    expect(openedInOwnTab(fakeWindow({}))).toBe(false)
    expect(openedInOwnTab(fakeWindow({ search: '?other=1' }))).toBe(false)
  })
})

describe('closeEditor', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('closes the tab it was opened in and does not navigate away', () => {
    const win = fakeWindow({ search: '?tab=1' })
    const navigate = vi.fn()
    closeEditor({ win, backPath: '/files/Protokolle', navigate })
    vi.runAllTimers()
    expect(win.close).toHaveBeenCalledTimes(1)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('goes back to the file folder when the tab was not opened by the app', () => {
    const win = fakeWindow({})
    const navigate = vi.fn()
    closeEditor({ win, backPath: '/files/Protokolle', navigate })
    vi.runAllTimers()
    expect(win.close).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/files/Protokolle')
  })

  it('falls back to the file folder when the browser refuses to close the tab', () => {
    const win = fakeWindow({ opener: {}, closesOnClose: false })
    const navigate = vi.fn()
    closeEditor({ win, backPath: '/files', navigate })
    expect(navigate).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(win.close).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/files')
  })
})
