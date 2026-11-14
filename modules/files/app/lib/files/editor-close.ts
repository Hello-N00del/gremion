/**
 * Opening and closing the document editor tab.
 *
 * "Öffnen" opens the editor in a NEW tab on every device, so the calendar and the chat stay where they were. The
 * link is `rel="noopener"`, which empties `window.opener` in the new tab; the `tab=1` query marks the tab as
 * app-opened instead. Closing it then means closing the tab. A tab that was not opened that way (a bookmark, a
 * pasted link) goes back to the file's folder.
 */

export const EDITOR_TAB_PARAM = 'tab'

/** The editor URL for a listing entry; `entryPath` is the path the files API returned (already percent-encoded). */
export function editorTabHref(entryPath: string): string {
  return '/files/edit/' + entryPath.replace(/^\/+/, '') + '?' + EDITOR_TAB_PARAM + '=1'
}

type CloseWindow = Pick<Window, 'opener' | 'closed' | 'close'> & { location: Pick<Location, 'search'> }

export function openedInOwnTab(win: Pick<CloseWindow, 'opener' | 'location'>): boolean {
  if (win.opener) return true
  return new URLSearchParams(win.location.search).get(EDITOR_TAB_PARAM) === '1'
}

/** How long to wait for window.close() to take effect before concluding the browser refused it. */
const CLOSE_GRACE_MS = 250

export function closeEditor(opts: { win: CloseWindow; backPath: string; navigate: (path: string) => void }): void {
  const { win, backPath, navigate } = opts
  if (!openedInOwnTab(win)) {
    navigate(backPath)
    return
  }
  win.close()
  // window.close() is ignored for a tab the browser does not count as script-closable (for instance once the tab
  // has more than one history entry). Never leave the person on a dead editor: fall back to the folder.
  setTimeout(() => {
    if (!win.closed) navigate(backPath)
  }, CLOSE_GRACE_MS)
}
