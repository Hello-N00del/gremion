import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock $env/dynamic/private BEFORE the SUT is imported. Vitest hoists
// `vi.mock` calls to the top of the file, but we keep this explicit so the
// dependency is obvious.
vi.mock('$env/dynamic/private', () => ({
  env: {
    INTERNAL_PUSH_SECRET: 'test-secret-32-bytes-of-padding-xxx',
    PUBLIC_BASE_URL: 'http://stura.test:3000',
    INTERNAL_BASE_URL: undefined,
  },
}))

import {
  constantTimeEqual,
  internalFetch,
  isInternalBearerRequest,
  readInternalPushSecret,
} from './internal-fetch'

describe('constantTimeEqual', () => {
  it('returns true for equal strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
  })

  it('returns false for different equal-length strings', () => {
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
  })

  it('returns false for different-length strings (length leak guard)', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
    expect(constantTimeEqual('abcd', 'abc')).toBe(false)
  })

  it('returns false for non-string inputs', () => {
    // @ts-expect-error - exercising the runtime guard
    expect(constantTimeEqual(123, 'abc')).toBe(false)
    // @ts-expect-error - exercising the runtime guard
    expect(constantTimeEqual('abc', null)).toBe(false)
  })

  it('handles empty strings', () => {
    expect(constantTimeEqual('', '')).toBe(true)
    expect(constantTimeEqual('a', '')).toBe(false)
  })
})

describe('readInternalPushSecret', () => {
  it('returns the mocked secret', () => {
    expect(readInternalPushSecret()).toBe('test-secret-32-bytes-of-padding-xxx')
  })
})

// typescript(no-base-to-string): RequestInfo includes Request, whose
// String() coercion falls back to Object.prototype.toString ('[object
// Request]'), not its .url. internalFetch never passes a Request today, but
// this keeps the recorded lastCall.url meaningful if it ever does.
function urlOf(input: RequestInfo | URL): string {
  if (input instanceof URL) return input.href
  if (typeof input === 'string') return input
  return input.url
}

describe('internalFetch', () => {
  const originalFetch = globalThis.fetch
  let lastCall: { url: string; init: RequestInit } | null = null

  beforeEach(() => {
    lastCall = null
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      lastCall = { url: urlOf(input), init: init ?? {} }
      return new Response('ok', { status: 200 })
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('rejects paths that do not start with /api/', async () => {
    await expect(internalFetch('/foo')).rejects.toThrow(/must start with \/api\//)
    await expect(internalFetch('https://evil.example.com/api/x')).rejects.toThrow(
      /must start with \/api\//,
    )
  })

  it('attaches Authorization: Bearer <secret> and no Cookie header', async () => {
    await internalFetch('/api/calendar/automations/minutes', {
      method: 'POST',
      body: JSON.stringify({ text: 'hello' }),
    })
    expect(lastCall).not.toBeNull()
    const headers = lastCall!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-secret-32-bytes-of-padding-xxx')
    expect(headers['Content-Type']).toBe('application/json')
    // CRITICAL: this is the load-bearing assertion for G-075.
    expect(headers.Cookie).toBeUndefined()
    expect(headers.cookie).toBeUndefined()
  })

  // F1-FIX-03 / S1a#24: the PUBLIC_BASE_URL fallback sent the internal trust
  // secret through the public edge (and the edge picks the tenant there). With
  // INTERNAL_BASE_URL unset, a production process now refuses the call; a dev
  // or test process targets the local dev server. PUBLIC_BASE_URL is never used.
  it('in production, refuses to call when INTERNAL_BASE_URL is unset, and sends nothing', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    try {
      await expect(
        internalFetch('/api/news/1', { method: 'PATCH', body: '{}' }),
      ).rejects.toThrow(/INTERNAL_BASE_URL/)
      expect(lastCall).toBeNull()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('outside production, falls back to the local dev server, never to PUBLIC_BASE_URL', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    try {
      await internalFetch('/api/news/1', { method: 'PATCH', body: '{}' })
      expect(lastCall!.url).toBe('http://localhost:3000/api/news/1')
      expect(lastCall!.url).not.toContain('stura.test')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('isInternalBearerRequest', () => {
  it('returns true for a valid Bearer token', () => {
    const request = new Request('http://x/y', {
      headers: { Authorization: 'Bearer test-secret-32-bytes-of-padding-xxx' },
    })
    expect(isInternalBearerRequest(request)).toBe(true)
  })

  it('returns false for a wrong Bearer token', () => {
    const request = new Request('http://x/y', {
      headers: { Authorization: 'Bearer wrong-secret-value' },
    })
    expect(isInternalBearerRequest(request)).toBe(false)
  })

  it('returns false when the Authorization header is missing', () => {
    const request = new Request('http://x/y')
    expect(isInternalBearerRequest(request)).toBe(false)
  })

  it('returns false for a non-Bearer scheme (e.g. Basic)', () => {
    const request = new Request('http://x/y', {
      headers: { Authorization: 'Basic abc' },
    })
    expect(isInternalBearerRequest(request)).toBe(false)
  })

  it('returns false for an empty Bearer value', () => {
    const request = new Request('http://x/y', {
      headers: { Authorization: 'Bearer ' },
    })
    expect(isInternalBearerRequest(request)).toBe(false)
  })
})
