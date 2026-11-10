// BODY_SIZE_LIMIT is 100M for the Files upload; bodySizeGuard keeps every route
// that buffers its body (Auth.js sign-in, JSON endpoints) at 512 KiB, so an
// anonymous client cannot hold ~100 MiB per request in the shared app container.
import { describe, it, expect, vi } from 'vitest'
import { bodySizeGuard, MAX_BUFFERED_BODY_BYTES } from './body-size-guard'

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

  it('leaves the streaming Files upload at the adapter cap (100 MiB PUT passes)', async () => {
    const { resolve, res } = run('/api/files/docs/big.pdf', { 'content-length': String(100 * 1024 * 1024) }, 'PUT')
    expect((await res).status).toBe(200)
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('leaves a chunked Files upload-chunk alone', async () => {
    const { resolve, res } = run('/api/files/upload-chunk', { 'transfer-encoding': 'chunked' }, 'PUT')
    expect((await res).status).toBe(200)
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('does not exempt a look-alike prefix', async () => {
    const { resolve, res } = run('/api/filesystem/x', { 'content-length': String(2 * 1024 * 1024) })
    expect((await res).status).toBe(413)
    expect(resolve).not.toHaveBeenCalled()
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
