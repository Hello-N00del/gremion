// A failed chunk PUT or assembly MOVE used to be answered with the first 200 characters
// of the Nextcloud response body, which can echo the internal DAV path and the user's
// Nextcloud id. The caller gets a plain German sentence; the detail goes to the server log.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../nextcloud-client', () => ({ createNextcloudClient: () => ({}) }))
vi.mock('$lib/server/env/service-env', () => ({
  serviceEnv: (name: string) =>
    ({ NEXTCLOUD_URL: 'http://nc.test', NEXTCLOUD_ADMIN_USER: 'admin', NEXTCLOUD_ADMIN_PASSWORD: 'pw' })[name],
}))

import { InprocessFilesClient } from './inprocess-client'

const UID = '3f0c9c1e-6a53-4f6e-9a3b-2f4a1c7d8e90'
const SABRE = `<d:error><s:message>File /remote.php/dav/uploads/${UID}/up1/.file not found</s:message></d:error>`

function input(chunkIndex: number, totalChunks: number) {
  return {
    userId: UID,
    uploadId: 'up1',
    chunkIndex,
    totalChunks,
    body: new Uint8Array([1]),
    sanitizedPath: 'Docs/a.odt',
    totalSize: '1',
  } as never
}

async function failure(run: () => Promise<unknown>): Promise<{ status: number; text: string }> {
  try {
    await run()
  } catch (e) {
    const err = e as { status?: number; body?: unknown }
    return { status: err.status ?? 0, text: JSON.stringify(err.body ?? {}) }
  }
  throw new Error('did not fail')
}

function expectClean(text: string) {
  expect(text).not.toContain('remote.php')
  expect(text).not.toContain(UID)
  expect(text).not.toContain('sabre')
  expect(text).not.toContain('not found')
}

let log: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('chunked upload failures', () => {
  test('a refused chunk answers 502 without the Nextcloud response body, and logs it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(SABRE, { status: 409 })))
    const out = await failure(() => new InprocessFilesClient().uploadChunk(input(0, 2)))
    expect(out.status).toBe(502)
    expect(out.text).toContain('Dokumentenspeicher')
    expectClean(out.text)
    expect(JSON.stringify(log.mock.calls)).toContain('remote.php')
  })

  test('a failed assembly answers 502 without the Nextcloud response body, and logs it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { method: string }) =>
        init.method === 'MOVE' ? new Response(SABRE, { status: 404 }) : new Response(null, { status: 201 }),
      ),
    )
    const out = await failure(() => new InprocessFilesClient().uploadChunk(input(1, 2)))
    expect(out.status).toBe(502)
    expect(out.text).toContain('Dokumentenspeicher')
    expectClean(out.text)
    expect(JSON.stringify(log.mock.calls)).toContain('remote.php')
  })
})
