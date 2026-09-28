// @vitest-environment node
// Unit tests for the Meta Graph carousel adapter. The HTTP layer is a fully
// mocked `fetch` — NO network. We assert the 3-step Graph sequence (per-slide
// image containers → carousel container → publish) and fail-on-any-non-ok-step.
import { describe, expect, it, vi } from 'vitest'
import { createInstagramAdapter } from './adapter'
import type { InstagramCredentials } from './credentials'

const CREDS: InstagramCredentials = { accessToken: 'TOKEN', igUserId: '17841400000000000' }

/** Encode exactly as the adapter does (URLSearchParams — space → '+', comma → %2C). */
function q(v: string): string {
  return new URLSearchParams({ v }).toString().slice('v='.length)
}

/** A `fetch` double that returns each queued response in turn and records calls. */
function mockFetch(responses: Array<{ ok: boolean; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let i = 0
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    const r = responses[i++] ?? { ok: false, body: { error: { message: 'no response queued' } } }
    return {
      ok: r.ok,
      status: r.ok ? 200 : 400,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as unknown as Response
  })
  return { fn: fn as unknown as typeof fetch, calls }
}

describe('createInstagramAdapter.publishCarousel', () => {
  it('runs the 3-step Graph sequence and returns the published media id', async () => {
    const { fn, calls } = mockFetch([
      { ok: true, body: { id: 'child-1' } }, // slide 1 image container
      { ok: true, body: { id: 'child-2' } }, // slide 2 image container
      { ok: true, body: { id: 'carousel-1' } }, // carousel container
      { ok: true, body: { id: 'media-final' } }, // media_publish
    ])
    const adapter = createInstagramAdapter(fn)
    const result = await adapter.publishCarousel(
      CREDS,
      [{ imageUrl: 'https://h/1.png' }, { imageUrl: 'https://h/2.png' }],
      'a caption',
    )

    expect(result).toEqual({ mediaId: 'media-final' })
    expect(calls).toHaveLength(4)

    // Step 1+2 — per-slide image containers, is_carousel_item=true, on /{ig}/media.
    expect(calls[0].url).toContain(`/${CREDS.igUserId}/media`)
    expect(calls[0].url).toContain('is_carousel_item=true')
    expect(calls[0].url).toContain('image_url=' + q('https://h/1.png'))
    expect(calls[0].url).toContain('access_token=TOKEN')
    expect(calls[1].url).toContain('image_url=' + q('https://h/2.png'))

    // Step 3 — carousel container referencing both children + caption.
    expect(calls[2].url).toContain(`/${CREDS.igUserId}/media`)
    expect(calls[2].url).toContain('media_type=CAROUSEL')
    expect(calls[2].url).toContain('children=' + q('child-1,child-2'))
    expect(calls[2].url).toContain('caption=' + q('a caption'))

    // Step 4 — publish the carousel creation id.
    expect(calls[3].url).toContain(`/${CREDS.igUserId}/media_publish`)
    expect(calls[3].url).toContain('creation_id=carousel-1')

    // All POSTs.
    for (const c of calls) expect((c.init?.method ?? 'GET')).toBe('POST')
  })

  it('throws with the Meta error when the carousel-container step fails', async () => {
    const { fn } = mockFetch([
      { ok: true, body: { id: 'child-1' } },
      { ok: false, body: { error: { message: 'Invalid children' } } }, // carousel container fails
    ])
    const adapter = createInstagramAdapter(fn)
    await expect(
      adapter.publishCarousel(CREDS, [{ imageUrl: 'https://h/1.png' }], 'cap'),
    ).rejects.toThrow(/Invalid children/)
  })

  it('throws when a per-slide image container step fails (and does not proceed)', async () => {
    const { fn, calls } = mockFetch([
      { ok: false, body: { error: { message: 'bad image_url' } } },
    ])
    const adapter = createInstagramAdapter(fn)
    await expect(
      adapter.publishCarousel(CREDS, [{ imageUrl: 'https://h/1.png' }], 'cap'),
    ).rejects.toThrow(/bad image_url/)
    // Failed at the first container — no further calls.
    expect(calls).toHaveLength(1)
  })

  it('throws when given an empty slide list (a carousel needs children)', async () => {
    const { fn } = mockFetch([])
    const adapter = createInstagramAdapter(fn)
    await expect(adapter.publishCarousel(CREDS, [], 'cap')).rejects.toThrow()
  })
})
