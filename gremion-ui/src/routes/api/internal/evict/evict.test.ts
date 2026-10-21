// /api/internal/evict — gremion-switch / gremion-deploy evict fan-out target.
// POST only, Bearer INTERNAL_PUSH_SECRET (constant time, fail closed), 204 on
// success after clearing this process's tenant runtime caches.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const SECRET = 'test-secret-32-bytes-of-padding-xxx'
const envBox = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }))
vi.mock('$env/dynamic/private', () => envBox)
const { evictAll } = vi.hoisted(() => ({ evictAll: vi.fn() }))
vi.mock('$lib/server/tenant/registry', () => ({ evictAllTenantRuntimes: evictAll }))

import * as route from './+server'

const call = (headers: Record<string, string> = {}, method = 'POST') =>
  (route as unknown as Record<string, (e: { request: Request }) => Response>)[method]({
    request: new Request('http://gremion-ui:3000/api/internal/evict', { method, headers }),
  })

beforeEach(() => {
  evictAll.mockReset()
  envBox.env.INTERNAL_PUSH_SECRET = SECRET
  delete process.env.INTERNAL_PUSH_SECRET
})

describe('POST /api/internal/evict', () => {
  it('correct Bearer -> 204 empty body and the tenant runtime cache is cleared once', async () => {
    const res = call({ authorization: `Bearer ${SECRET}` })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect(evictAll).toHaveBeenCalledTimes(1)
  })
  it('wrong secret -> 401, nothing cleared', () => {
    expect(call({ authorization: 'Bearer wrong-secret-wrong-secret-wrong-xx' }).status).toBe(401)
    expect(evictAll).not.toHaveBeenCalled()
  })
  it('missing Authorization -> 401, nothing cleared', () => {
    expect(call().status).toBe(401)
    expect(evictAll).not.toHaveBeenCalled()
  })
  it('secret unset -> 401 even for an empty/any bearer (fail closed)', () => {
    envBox.env.INTERNAL_PUSH_SECRET = undefined
    expect(call({ authorization: 'Bearer ' }).status).toBe(401)
    expect(call({ authorization: 'Bearer anything-at-all-anything-at-all' }).status).toBe(401)
    expect(evictAll).not.toHaveBeenCalled()
  })
  it('secret too short -> 401 (fail closed)', () => {
    envBox.env.INTERNAL_PUSH_SECRET = 'short'
    expect(call({ authorization: 'Bearer short' }).status).toBe(401)
    expect(evictAll).not.toHaveBeenCalled()
  })
  it('exports POST only (GET/PUT/DELETE are 405 from SvelteKit)', () => {
    expect(Object.keys(route).sort()).toEqual(['POST'])
  })
})
