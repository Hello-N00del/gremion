import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/content/posts/[id]/publish/[channel] — capability-gated publish.
// content.publish is required (401 no user / 403 wrong capability); Instagram
// needs a SECOND, channel-specific content.publish.instagram capability that
// ships ungranted (disabled-by-default → 403). The publish outcome maps to
// 200 / 409 (disabled channel) / 422 (email SMTP-unconfigured).
//
// The route now dispatches through the content backend seam
// (getContentBackend().publish) rather than calling publishPost directly, so the
// backend factory is mocked here — its publish() stands in for both the inprocess
// orchestrator and the service-mode leaf delegation (they share the port shape).

const { mockComposeCapabilities, mockPublish, mockGetContentBackend } = vi.hoisted(() => ({
  mockComposeCapabilities: vi.fn(),
  mockPublish: vi.fn(),
  mockGetContentBackend: vi.fn(),
}))

vi.mock('$lib/auth', () => ({
  hasRole: (roles: string[], required: string) => roles.includes(required),
  Role: { Member: 'member' },
}))
vi.mock('$lib/modules/registry', () => ({ composeCapabilities: mockComposeCapabilities }))

// Mock the backend seam: getContentBackend returns an object whose publish() is
// the mock. Replacing the module keeps the test from transitively loading the
// real content-db / renderer / service-client chain. The route imports this
// SAME identity.
vi.mock('$lib/server/content/backend', () => ({ getContentBackend: mockGetContentBackend }))

// The dependency-free error the route branches on with `instanceof`. Defining it
// in the factory (rather than importActual) keeps the identity stable and cheap.
vi.mock('$lib/server/content/publish-errors', () => {
  class ChannelNotPublishableError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'ChannelNotPublishableError'
    }
  }
  class TenantIdentityMismatchError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'TenantIdentityMismatchError'
    }
  }
  return { ChannelNotPublishableError, TenantIdentityMismatchError }
})

import { POST } from './+server'
import { ChannelNotPublishableError, TenantIdentityMismatchError } from '$lib/server/content/publish-errors'

type Ev = Parameters<typeof POST>[0]

function makeEvent(opts: {
  user?: { roles: string[]; groups: string[]; id: string } | null
  id?: string
  channel?: string
}): Ev {
  return {
    request: new Request('http://stura.test/api/content/posts/p1/publish/email', {
      method: 'POST',
    }),
    locals: { user: opts.user ?? null },
    params: { id: opts.id ?? 'p1', channel: opts.channel ?? 'email' },
  } as unknown as Ev
}

describe('POST /api/content/posts/[id]/publish/[channel]', () => {
  beforeEach(() => {
    mockComposeCapabilities.mockReset().mockReturnValue({ 'content.publish': ['publishers'] })
    mockPublish.mockReset()
    mockGetContentBackend.mockReset().mockReturnValue({ kind: 'inprocess', publish: mockPublish })
  })

  it('401s with no user', async () => {
    await expect(POST(makeEvent({ user: null }))).rejects.toMatchObject({ status: 401 })
    expect(mockPublish).not.toHaveBeenCalled()
  })

  it('403s a user without the content.publish capability', async () => {
    await expect(
      POST(makeEvent({ user: { roles: ['member'], groups: ['authors'], id: 'u1' } })),
    ).rejects.toMatchObject({ status: 403 })
    expect(mockPublish).not.toHaveBeenCalled()
  })

  it('400s an invalid channel', async () => {
    await expect(
      POST(
        makeEvent({ user: { roles: ['member'], groups: ['publishers'], id: 'u1' }, channel: 'tiktok' }),
      ),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('200s with the PublishResult on a successful portal publish', async () => {
    mockPublish.mockResolvedValue({
      channel: 'portal',
      status: 'published',
      externalRef: '42',
      warnings: [],
    })
    const res = await POST(
      makeEvent({ user: { roles: ['member'], groups: ['publishers'], id: 'u1' }, channel: 'portal' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ channel: 'portal', status: 'published', externalRef: '42' })
    expect(mockPublish).toHaveBeenCalledWith('p1', 'portal')
  })

  it('200s with the PublishResult on a successful email send', async () => {
    mockPublish.mockResolvedValue({
      channel: 'email',
      status: 'sent',
      recipientCount: 3,
      warnings: [],
    })
    const res = await POST(
      makeEvent({ user: { roles: ['member'], groups: ['publishers'], id: 'u1' } }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'sent', recipientCount: 3 })
  })

  it('403s the Instagram channel when content.publish.instagram is ungranted (disabled-by-default)', async () => {
    // composeCapabilities grants content.publish (publishers) but NOT
    // content.publish.instagram (absent → no group grants it).
    await expect(
      POST(
        makeEvent({
          user: { roles: ['member'], groups: ['publishers'], id: 'u1' },
          channel: 'instagram',
        }),
      ),
    ).rejects.toMatchObject({ status: 403, body: { message: 'Instagram publishing is not enabled for this tenant.' } })
    // never reaches the backend while the capability is ungranted.
    expect(mockPublish).not.toHaveBeenCalled()
  })

  it('dispatches Instagram once content.publish.instagram IS granted (activation path)', async () => {
    mockComposeCapabilities.mockReturnValue({
      'content.publish': ['publishers'],
      'content.publish.instagram': ['ig-publishers'],
    })
    mockPublish.mockResolvedValue({
      channel: 'instagram',
      status: 'scheduled',
      detail: 'queued for Instagram publish',
      warnings: [],
    })
    const res = await POST(
      makeEvent({
        user: { roles: ['member'], groups: ['publishers', 'ig-publishers'], id: 'u1' },
        channel: 'instagram',
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ channel: 'instagram', status: 'scheduled' })
    expect(mockPublish).toHaveBeenCalledWith('p1', 'instagram')
  })

  it('409s a disabled channel (inprocess throw or leaf 409 → ChannelNotPublishableError)', async () => {
    mockPublish.mockRejectedValue(new ChannelNotPublishableError('channel is disabled'))
    await expect(
      POST(makeEvent({ user: { roles: ['member'], groups: ['publishers'], id: 'u1' } })),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('502s a tenant identity mismatch with its own message (not the 409 channel message)', async () => {
    mockPublish.mockRejectedValue(new TenantIdentityMismatchError('Mandantenzuordnung stimmt nicht überein'))
    await expect(
      POST(makeEvent({ user: { roles: ['member'], groups: ['publishers'], id: 'u1' } })),
    ).rejects.toMatchObject({ status: 502, body: { message: 'Mandantenzuordnung stimmt nicht überein' } })
  })

  it('422s an email publish that failed because SMTP is unconfigured', async () => {
    mockPublish.mockResolvedValue({
      channel: 'email',
      status: 'failed',
      recipientCount: 0,
      warnings: [],
      detail: 'SMTP not configured',
    })
    const res = await POST(
      makeEvent({ user: { roles: ['member'], groups: ['publishers'], id: 'u1' } }),
    )
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ status: 'failed', detail: 'SMTP not configured' })
  })
})
