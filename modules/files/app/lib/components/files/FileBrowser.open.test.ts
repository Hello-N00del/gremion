import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/svelte'

// The i18n store reads the browser at module load; resolve keys against the real German catalogue.
vi.mock('$lib/i18n', async () => {
  const { readable } = await import('svelte/store')
  const de = (await import('$lib/i18n/messages/de.json')).default as Record<string, string>
  return { t: readable((key: string) => de[key] ?? key), lang: readable('de') }
})
const goto = vi.hoisted(() => vi.fn())
vi.mock('$app/navigation', () => ({ goto }))

import FileBrowser from './FileBrowser.svelte'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  goto.mockReset()
})

const FILES = [
  { path: 'Protokolle/Sitzung 1.odt', name: 'Sitzung 1.odt', is_dir: false, etag: 'a', size: 2048, last_modified: '2026-11-01T10:00:00Z' },
  { path: 'Protokolle/Foto.png', name: 'Foto.png', is_dir: false, etag: 'b', size: 4096, last_modified: '2026-11-02T10:00:00Z' },
  { path: 'Protokolle/Archiv', name: 'Archiv', is_dir: true, etag: 'c', size: 0, last_modified: '2026-11-03T10:00:00Z' }
]

function stubListing() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ success: true, files: FILES })
    }))
  )
}

async function mount(readonly = false) {
  stubListing()
  const r = render(FileBrowser, { props: { rootPath: 'Protokolle', readonly } })
  await waitFor(() => expect(r.container.querySelectorAll('.fb-row').length).toBe(FILES.length))
  return r
}

function openLinkOf(container: HTMLElement, fileName: string) {
  const row = [...container.querySelectorAll('.fb-row')].find((r) => r.textContent?.includes(fileName)) as HTMLElement
  return row.querySelector('.fb-actions a') as HTMLAnchorElement | null
}

describe('FileBrowser Öffnen', () => {
  it('opens an editable file in a new tab: a noopener link to the editor route, never goto()', async () => {
    const { container } = await mount()
    const link = openLinkOf(container, 'Sitzung 1.odt')!
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('/files/edit/Protokolle/Sitzung 1.odt?tab=1')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(link.textContent).toContain('Öffnen')
    link.addEventListener('click', (e) => e.preventDefault())
    link.click()
    expect(goto).not.toHaveBeenCalled()
  })

  it('keeps the viewable-file link as it was (new tab, inline, noopener noreferrer)', async () => {
    const { container } = await mount()
    const link = openLinkOf(container, 'Foto.png')!
    expect(link.getAttribute('href')).toBe('/api/files/Protokolle/Foto.png?inline=1')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('offers no editor link for a folder, nor for an editable file in a read-only listing', async () => {
    const { container } = await mount(true)
    expect(openLinkOf(container, 'Archiv')).toBeNull()
    expect(openLinkOf(container, 'Sitzung 1.odt')).toBeNull()
  })
})
