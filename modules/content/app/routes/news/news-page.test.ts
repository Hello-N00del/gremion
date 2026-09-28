import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'

// The create dialog (NewPostDialog) pulls in the i18n store, which reads
// localStorage at module load — unavailable in this environment. Mock the
// store to resolve keys against the real German dictionary so the rendered
// button labels ("Beitrag anlegen") match the assertions below.
vi.mock('$lib/i18n', async () => {
  const { readable } = await import('svelte/store')
  const de = (await import('$lib/i18n/de')).default
  return { t: readable((key: string) => de[key] ?? key), lang: readable('de') }
})

import Page from './+page.svelte'

afterEach(() => { vi.unstubAllGlobals() })

// The create flow now opens a dialog (NewPostDialog) instead of a native
// prompt(): click "Beitrag" -> enter a title -> submit. Error feedback (#183)
// must still surface on a failed / throwing POST.
describe('Veröffentlichungen — createPost error feedback (#183)', () => {
  it('surfaces an error when POST /api/news fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    const { getByRole, findByText } = render(Page, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      props: { data: { posts: [] } } as any,
    })
    await fireEvent.click(getByRole('button', { name: 'Beitrag' }))
    await fireEvent.input(getByRole('textbox'), { target: { value: 'Mein Beitrag' } })
    await fireEvent.click(getByRole('button', { name: 'Beitrag anlegen' }))
    expect(await findByText('Beitrag konnte nicht erstellt werden.')).toBeTruthy()
  })

  it('surfaces a connection error when the request throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const { getByRole, findByText } = render(Page, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      props: { data: { posts: [] } } as any,
    })
    await fireEvent.click(getByRole('button', { name: 'Beitrag' }))
    await fireEvent.input(getByRole('textbox'), { target: { value: 'Mein Beitrag' } })
    await fireEvent.click(getByRole('button', { name: 'Beitrag anlegen' }))
    expect(await findByText('Verbindungsfehler. Bitte erneut versuchen.')).toBeTruthy()
  })
})
