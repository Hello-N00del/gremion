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

const SUFFIX = ' (1efb7da1c9)'

function stubListing(files: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ success: true, files })
    }))
  )
}

const dir = (path: string, name: string) => ({ path, name, is_dir: true, etag: 'e', size: 0, last_modified: '2026-11-03T10:00:00Z' })

describe('FileBrowser shows the plain unit name, not the namespaced mount point', () => {
  it('at the root the group folders are listed by the unit name; the link still goes to the real mount point', async () => {
    stubListing([dir(`Vorstand${SUFFIX}`, `Vorstand${SUFFIX}`), dir('Persönlich', 'Persönlich')])
    const { container } = render(FileBrowser, { props: { rootPath: '', readonly: false, mountSuffix: SUFFIX } })
    await waitFor(() => expect(container.querySelectorAll('.fb-row').length).toBe(2))
    const rows = [...container.querySelectorAll('.fb-row')].map((r) => r.textContent ?? '')
    expect(rows[0]).toContain('Vorstand')
    expect(rows[0]).not.toContain('1efb7da1c9')
    expect(rows[1]).toContain('Persönlich')
  })

  it('the breadcrumb of a folder below a group folder shows the plain name, and keeps the real path for navigation', async () => {
    stubListing([dir(`Vorstand${SUFFIX}/Protokolle`, 'Protokolle')])
    const { container } = render(FileBrowser, { props: { rootPath: `Vorstand${SUFFIX}`, readonly: false, mountSuffix: SUFFIX } })
    await waitFor(() => expect(container.querySelectorAll('.fb-row').length).toBe(1))
    const crumbs = [...container.querySelectorAll('.fb-crumb')]
    expect(crumbs).toHaveLength(2)
    expect(crumbs[1].textContent?.trim()).toBe('Vorstand')
    ;(crumbs[1] as HTMLElement).click()
    expect(goto).toHaveBeenCalledWith(`/files/Vorstand${SUFFIX}`)
  })

  it('without a suffix (an install of one customer, or a folder made before the namespace) nothing changes', async () => {
    stubListing([dir('Vorstand', 'Vorstand')])
    const { container } = render(FileBrowser, { props: { rootPath: '', readonly: false } })
    await waitFor(() => expect(container.querySelectorAll('.fb-row').length).toBe(1))
    expect(container.querySelector('.fb-row')?.textContent).toContain('Vorstand')
  })
})
