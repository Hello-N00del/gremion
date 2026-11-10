// BODY_SIZE_LIMIT is 100M for the Files upload; bodySizeGuard keeps every route
// that buffers its body (Auth.js sign-in, JSON endpoints) at 512 KiB, so an
// anonymous client cannot hold ~100 MiB per request in the shared app container.
import { describe, it, expect, vi } from 'vitest'
import { bodySizeGuard, BODY_SIZE_EXEMPTIONS, MAX_BUFFERED_BODY_BYTES } from './body-size-guard'

const ORIGIN = 'https://tenant-a.example.org'

function run(path: string, headers: Record<string, string>, method = 'POST') {
  const resolve = vi.fn(async () => new Response('ok'))
  const url = new URL(`${ORIGIN}${path}`)
  // The guard must decide from headers alone: a body that throws when read proves it.
  const body = new ReadableStream({
    pull() {
      throw new Error('body was read')
    },
  })
  const event = {
    url,
    request: { method, headers: new Headers(headers), body },
    locals: { decodedPath: decodeURI(url.pathname) },
  }
  return { resolve, res: bodySizeGuard({ event, resolve } as never) as Promise<Response> | Response }
}

const form = { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN }

describe('bodySizeGuard', () => {
  it('refuses an oversized urlencoded POST /auth/signin with 413 and never resolves', async () => {
    const { resolve, res } = run('/auth/signin', { ...form, 'content-length': String(99 * 1024 * 1024) })
    expect((await res).status).toBe(413)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('refuses a JSON API body above the cap', async () => {
    const { resolve, res } = run('/api/newsletter/unsubscribe', {
      'content-type': 'application/json',
      'content-length': String(MAX_BUFFERED_BODY_BYTES + 1),
    })
    expect((await res).status).toBe(413)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('refuses a chunked body (no Content-Length) on a buffering route', async () => {
    const { resolve, res } = run('/auth/signin', { ...form, 'transfer-encoding': 'chunked' })
    expect((await res).status).toBe(413)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('passes a body at exactly the cap', async () => {
    const { resolve, res } = run('/auth/signin', { ...form, 'content-length': String(MAX_BUFFERED_BODY_BYTES) })
    expect((await res).status).toBe(200)
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('passes a request with no body and no length (GET)', async () => {
    const { resolve, res } = run('/dashboard', {}, 'GET')
    expect((await res).status).toBe(200)
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('answers 400 for a malformed Content-Length', async () => {
    const { resolve, res } = run('/auth/signin', { ...form, 'content-length': '12abc' })
    expect((await res).status).toBe(400)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('leaves the streaming Files PUT at the adapter cap (100 MiB PUT passes)', async () => {
    const { resolve, res } = run('/api/files/docs/big.pdf', { 'content-length': String(100 * 1024 * 1024) }, 'PUT')
    expect((await res).status).toBe(200)
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('passes a 50 MiB PUT under /api/files/', async () => {
    const { resolve, res } = run('/api/files/docs/video.mp4', { 'content-length': String(50 * 1024 * 1024) }, 'PUT')
    expect((await res).status).toBe(200)
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('leaves a chunked Files PUT alone (streamed, bounded by the adapter)', async () => {
    const { resolve, res } = run('/api/files/docs/x.bin', { 'transfer-encoding': 'chunked' }, 'PUT')
    expect((await res).status).toBe(200)
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('leaves the streaming POST /api/files/upload-chunk alone', async () => {
    const { resolve, res } = run('/api/files/upload-chunk', { 'content-length': String(50 * 1024 * 1024) }, 'POST')
    expect((await res).status).toBe(200)
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('gives a buffering PATCH under /api/files/ the 512 KiB default (2 MiB -> 413)', async () => {
    const { resolve, res } = run('/api/files/docs/a.txt', { 'content-length': String(2 * 1024 * 1024) }, 'PATCH')
    expect((await res).status).toBe(413)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('gives a POST under /api/files/ (other than upload-chunk) the default cap', async () => {
    const { resolve, res } = run('/api/files/docs/a.txt', { 'content-length': String(2 * 1024 * 1024) }, 'POST')
    expect((await res).status).toBe(413)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('refuses a 1 MiB POST to /auth/signin (no exemption leaks to auth)', async () => {
    const { resolve, res } = run('/auth/signin', { ...form, 'content-length': String(1024 * 1024) })
    expect((await res).status).toBe(413)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('does not exempt a look-alike prefix', async () => {
    const { resolve, res } = run('/api/filesystem/x', { 'content-length': String(2 * 1024 * 1024) })
    expect((await res).status).toBe(413)
    expect(resolve).not.toHaveBeenCalled()
  })
})

const MIB = 1024 * 1024
const mediaPath = '/api/messages/rooms/!abc123:chat.example.org/media'
const mp = { 'content-type': 'multipart/form-data; boundary=x' }

describe('bodySizeGuard: chat media upload (handler cap 20 MiB)', () => {
  it('passes a 4 MiB chat image POST', async () => {
    const { resolve, res } = run(mediaPath, { ...mp, 'content-length': String(4 * MIB) })
    expect((await res).status).toBe(200)
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('passes a percent-encoded Matrix room id (the client encodes ! and :)', async () => {
    const { resolve, res } = run('/api/messages/rooms/%21abc123%3Achat.example.org/media', { ...mp, 'content-length': String(4 * MIB) })
    expect((await res).status).toBe(200)
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('passes a body at exactly the handler cap (20 MiB)', async () => {
    const { resolve, res } = run(mediaPath, { ...mp, 'content-length': String(20 * MIB) })
    expect((await res).status).toBe(200)
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('refuses a 25 MiB chat image POST with 413', async () => {
    const { resolve, res } = run(mediaPath, { ...mp, 'content-length': String(25 * MIB) })
    expect((await res).status).toBe(413)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('refuses a chunked chat upload (no Content-Length)', async () => {
    const { resolve, res } = run(mediaPath, { ...mp, 'transfer-encoding': 'chunked' })
    expect((await res).status).toBe(413)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('answers 400 for a malformed Content-Length on the chat route', async () => {
    const { resolve, res } = run(mediaPath, { ...mp, 'content-length': '4MiB' })
    expect((await res).status).toBe(400)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('the exemption is keyed on the method: a PUT to the media path gets the default cap', async () => {
    const { resolve, res } = run(mediaPath, { ...mp, 'content-length': String(4 * MIB) }, 'PUT')
    expect((await res).status).toBe(413)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('the exemption is keyed on the path: a sibling room route gets the default cap', async () => {
    const { resolve, res } = run('/api/messages/rooms/r1/messages', { 'content-type': 'application/json', 'content-length': String(4 * MIB) })
    expect((await res).status).toBe(413)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('does not match a nested or look-alike media path', async () => {
    for (const p of ['/api/messages/rooms/r1/media/extra', '/api/messages/rooms/r1/x/media', '/api/messages/rooms//media', '/api/messages/rooms/r1/mediax']) {
      const { resolve, res } = run(p, { ...mp, 'content-length': String(4 * MIB) })
      expect((await res).status, p).toBe(413)
      expect(resolve).not.toHaveBeenCalled()
    }
  })

  it('stays in step with the handler: its own cap is the exemption cap', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = dirname(fileURLToPath(import.meta.url))
    const handler = join(here, '..', '..', '..', '..', '..', 'modules', 'messaging', 'app', 'routes', 'api', 'messages', 'rooms', '[roomId]', 'media', '+server.ts')
    if (!existsSync(handler)) return // messaging module not in this tree
    expect(readFileSync(handler, 'utf8')).toMatch(/MAX_UPLOAD_BYTES = 20 \* 1024 \* 1024/)
    expect(BODY_SIZE_EXEMPTIONS.find((e) => e.name === 'chat-media')?.maxBytes).toBe(20 * MIB)
  })
})

describe('bodySizeGuard is wired into the handle chain', () => {
  it('hooks.server.ts puts it before tenantResolveHandle and the Auth.js handle', async () => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'hooks.server.ts'), 'utf8')
    const seq = src.slice(src.indexOf('export const handle = sequence('))
    const at = (n: string) => seq.indexOf(n)
    expect(at('bodySizeGuard')).toBeGreaterThan(-1)
    expect(at('bodySizeGuard')).toBeLessThan(at('tenantResolveHandle'))
    expect(at('bodySizeGuard')).toBeLessThan(at('authHandleUnlessExempt'))
  })
})
