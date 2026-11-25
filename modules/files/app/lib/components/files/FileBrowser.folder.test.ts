import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'

// The i18n store reads the browser at module load; resolve keys against the real German catalogue.
vi.mock('$lib/i18n', async () => {
  const { readable } = await import('svelte/store')
  const de = (await import('$lib/i18n/messages/de.json')).default as Record<string, string>
  return { t: readable((key: string) => de[key] ?? key), lang: readable('de') }
})
vi.mock('$app/navigation', () => ({ goto: vi.fn() }))

import FileBrowser from './FileBrowser.svelte'
import de from '$lib/i18n/messages/de.json'
import en from '$lib/i18n/messages/en.json'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function listing() {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ success: true, files: [] }),
  }
}

/** GET lists an empty folder; every other call is recorded and answered by `onWrite`. */
function stubFetch(onWrite: () => unknown = () => ({ ok: true, status: 201 })) {
  const calls: Array<{ url: string; method: string }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      return method === 'GET' ? listing() : onWrite()
    }),
  )
  return calls
}

async function openDialogAndType(name: string) {
  render(FileBrowser, { props: { rootPath: 'docs', readonly: false } })
  await fireEvent.click(screen.getByRole('button', { name: de['files.newFolder'] }))
  const input = screen.getByPlaceholderText(de['files.folderName']) as HTMLInputElement
  await fireEvent.input(input, { target: { value: name } })
  return input
}

const create = () => screen.getByRole('button', { name: de['files.create'] })
const writes = (calls: Array<{ method: string }>) => calls.filter((c) => c.method !== 'GET')

describe('FileBrowser new folder: a refused name says why', () => {
  it.each([
    ['a/b', 'files.folderNameSeparator'],
    ['../x', 'files.folderNameSeparator'],
    ['..', 'files.folderNameDots'],
    ['   ', 'files.folderNameEmpty'],
  ] as const)('%j: shows the reason, keeps the dialog open, creates nothing', async (name, key) => {
    const calls = stubFetch()
    await openDialogAndType(name)
    await fireEvent.click(create())
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(de[key])
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(writes(calls)).toHaveLength(0)
  })

  it('shows the reason on Enter as well', async () => {
    const calls = stubFetch()
    const input = await openDialogAndType('x/y')
    await fireEvent.keyDown(input, { key: 'Enter' })
    expect((await screen.findByRole('alert')).textContent).toContain(de['files.folderNameSeparator'])
    expect(writes(calls)).toHaveLength(0)
  })

  it('clears the reason as soon as the name is edited', async () => {
    stubFetch()
    const input = await openDialogAndType('x/y')
    await fireEvent.click(create())
    await screen.findByRole('alert')
    await fireEvent.input(input, { target: { value: 'xy' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not carry a reason over to the next time the dialog is opened', async () => {
    stubFetch()
    await openDialogAndType('x/y')
    await fireEvent.click(create())
    await screen.findByRole('alert')
    await fireEvent.click(screen.getByRole('button', { name: de['files.cancel'] }))
    await fireEvent.click(screen.getByRole('button', { name: de['files.newFolder'] }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('FileBrowser new folder: a valid name', () => {
  it('is created with one PUT and closes the dialog', async () => {
    const calls = stubFetch()
    await openDialogAndType('Protokolle')
    await fireEvent.click(create())
    await waitFor(() => expect(writes(calls)).toEqual([{ url: '/api/files/docs/Protokolle?mkdir=true', method: 'PUT' }]))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('keeps the dialog open with a message when the server refuses it', async () => {
    stubFetch(() => ({ ok: false, status: 400 }))
    await openDialogAndType('Protokolle')
    await fireEvent.click(create())
    expect((await screen.findByRole('alert')).textContent).toContain(de['files.folderCreateFailed'])
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

describe('the new messages exist in both catalogues', () => {
  it.each(['files.folderNameSeparator', 'files.folderNameDots', 'files.folderNameEmpty', 'files.folderNameCharacters', 'files.folderCreateFailed'])(
    '%s',
    (key) => {
      expect((de as Record<string, string>)[key]).toBeTruthy()
      expect((en as Record<string, string>)[key]).toBeTruthy()
    },
  )
})
