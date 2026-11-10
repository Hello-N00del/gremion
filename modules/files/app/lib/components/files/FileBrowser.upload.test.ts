import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte'

// The i18n store reads the browser at module load; resolve keys against the real German catalogue.
vi.mock('$lib/i18n', async () => {
  const { readable } = await import('svelte/store')
  const de = (await import('$lib/i18n/messages/de.json')).default as Record<string, string>
  return { t: readable((key: string) => de[key] ?? key), lang: readable('de') }
})
vi.mock('$app/navigation', () => ({ goto: vi.fn() }))

import FileBrowser from './FileBrowser.svelte'
import de from '$lib/i18n/messages/de.json'

const MIB = 1024 * 1024

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function fileOfSize(name: string, bytes: number): File {
  const f = new File(['x'], name, { type: 'application/pdf' })
  Object.defineProperty(f, 'size', { value: bytes })
  return f
}

function listing() {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ success: true, files: [] })
  }
}

/** A fetch stub: GET lists an empty folder, every other call goes to `onWrite`. */
function stubFetch(onWrite: (url: string, init: RequestInit) => unknown) {
  const calls: Array<{ url: string; method: string }> = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    if (method === 'GET') return listing()
    return onWrite(url, init as RequestInit)
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

async function pick(container: HTMLElement, files: File[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  await fireEvent.change(input, { target: { files } })
  return input
}

describe('FileBrowser upload', () => {
  it('sends a file above 5 MiB as one PUT to /api/files/, never to the chunk route', async () => {
    const calls = stubFetch(() => ({ ok: true, status: 201 }))
    const { container } = render(FileBrowser, { props: { rootPath: 'docs', readonly: false } })
    await pick(container, [fileOfSize('scan.pdf', 12 * MIB)])
    await waitFor(() => expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(1))
    const writes = calls.filter((c) => c.method !== 'GET')
    expect(writes[0]).toEqual({ url: '/api/files/docs/scan.pdf', method: 'PUT' })
    expect(calls.some((c) => c.url.includes('upload-chunk'))).toBe(false)
  })

  it('encodes each path segment: a # or ? in the name stays in the path, never becomes a fragment or a query', async () => {
    const calls = stubFetch(() => ({ ok: true, status: 201 }))
    const { container } = render(FileBrowser, { props: { rootPath: 'docs/Sitzung 1', readonly: false } })
    await pick(container, [fileOfSize('Protokoll #3.pdf', 1 * MIB), fileOfSize('a?b.pdf', 1 * MIB)])
    await waitFor(() => expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(2))
    const urls = calls.filter((c) => c.method !== 'GET').map((c) => c.url)
    expect(urls).toEqual(['/api/files/docs/Sitzung%201/Protokoll%20%233.pdf', '/api/files/docs/Sitzung%201/a%3Fb.pdf'])
    for (const u of urls) {
      const parsed = new URL(u, 'https://example.test')
      expect(parsed.hash).toBe('')
      expect(parsed.search).toBe('')
    }
  })

  it('refuses a file above 100 MiB: no request leaves, the German too-large message shows', async () => {
    const calls = stubFetch(() => ({ ok: true, status: 201 }))
    const { container, findByText } = render(FileBrowser, { props: { rootPath: '', readonly: false } })
    await pick(container, [fileOfSize('huge.bin', 100 * MIB + 1)])
    expect(await findByText(new RegExp(de['files.uploadTooLarge'].slice(0, 30)))).toBeTruthy()
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
  })

  it('checks the whole selection before the first PUT and names the oversized file', async () => {
    const calls = stubFetch(() => ({ ok: true, status: 201 }))
    const { container, findByText } = render(FileBrowser, { props: { rootPath: '', readonly: false } })
    await pick(container, [fileOfSize('small.pdf', 1 * MIB), fileOfSize('huge.bin', 101 * MIB)])
    expect(await findByText(/huge\.bin/)).toBeTruthy()
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
  })

  it('shows an uploading status and disables the picker while a PUT is in flight', async () => {
    let finish: (v: unknown) => void = () => {}
    const pending = new Promise((resolve) => (finish = resolve))
    stubFetch(() => pending)
    const { container, findByText, queryByText } = render(FileBrowser, { props: { rootPath: '', readonly: false } })
    const input = await pick(container, [fileOfSize('scan.pdf', 12 * MIB)])
    expect(await findByText(/scan\.pdf/)).toBeTruthy()
    expect(input.disabled).toBe(true)
    finish({ ok: true, status: 201 })
    await waitFor(() => expect(queryByText(/scan\.pdf/)).toBeNull())
    expect(input.disabled).toBe(false)
  })
})
