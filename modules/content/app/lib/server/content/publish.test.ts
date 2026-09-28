import { beforeEach, describe, expect, it, vi } from 'vitest'

// publishPost — load post+media+channel, enforce the channel guard, dispatch to
// the matching renderer's publish(). Pure orchestration; content-db + the three
// renderers are mocked.

const {
  mockGetPost,
  mockListMedia,
  mockGetChannels,
  mockEmailPublish,
  mockPortalPublish,
  mockInstagramPublish,
} = vi.hoisted(() => ({
  mockGetPost: vi.fn(),
  mockListMedia: vi.fn(),
  mockGetChannels: vi.fn(),
  mockEmailPublish: vi.fn(),
  mockPortalPublish: vi.fn(),
  mockInstagramPublish: vi.fn(),
}))

vi.mock('./content-db', () => ({
  getPost: mockGetPost,
  listMedia: mockListMedia,
  getChannels: mockGetChannels,
}))
vi.mock('./channels/email-renderer', () => ({ emailRenderer: { channel: 'email', publish: mockEmailPublish } }))
vi.mock('./channels/portal-renderer', () => ({ portalRenderer: { channel: 'portal', publish: mockPortalPublish } }))
vi.mock('./channels/instagram-renderer', () => ({
  instagramRenderer: { channel: 'instagram', publish: mockInstagramPublish },
}))

import { publishPost, ChannelNotPublishableError } from './publish'

const POST = { id: 'p1', title: 'T', body_html: '<p>x</p>', created_by: 'u1' }
function channelRow(channel: string, enabled = true) {
  return { post_id: 'p1', channel, enabled, status: 'draft', scheduled_at: null, overrides: {} }
}

describe('publishPost', () => {
  beforeEach(() => {
    mockGetPost.mockReset().mockResolvedValue(POST)
    mockListMedia.mockReset().mockResolvedValue([])
    mockGetChannels.mockReset().mockResolvedValue([channelRow('email'), channelRow('portal'), channelRow('instagram')])
    mockEmailPublish.mockReset().mockResolvedValue({ channel: 'email', status: 'sent', recipientCount: 2, warnings: [] })
    mockPortalPublish.mockReset().mockResolvedValue({ channel: 'portal', status: 'published', externalRef: '7', warnings: [] })
    mockInstagramPublish.mockReset().mockResolvedValue({ channel: 'instagram', status: 'failed', detail: 'Instagram not configured', warnings: [] })
  })

  it('dispatches to the portal renderer with post+media+channelRow', async () => {
    const result = await publishPost('p1', 'portal')
    expect(result).toMatchObject({ channel: 'portal', status: 'published', externalRef: '7' })
    expect(mockPortalPublish).toHaveBeenCalledWith(POST, [], channelRow('portal'))
  })

  it('dispatches to the email renderer', async () => {
    const result = await publishPost('p1', 'email')
    expect(result).toMatchObject({ channel: 'email', status: 'sent', recipientCount: 2 })
    expect(mockEmailPublish).toHaveBeenCalledOnce()
  })

  it('dispatches to the instagram renderer (no hard throw; the route capability guard gates it)', async () => {
    const result = await publishPost('p1', 'instagram')
    expect(result).toMatchObject({ channel: 'instagram', status: 'failed', detail: 'Instagram not configured' })
    expect(mockInstagramPublish).toHaveBeenCalledWith(POST, [], channelRow('instagram'))
  })

  it('throws ChannelNotPublishableError on an unknown post', async () => {
    mockGetPost.mockResolvedValue(null)
    await expect(publishPost('p1', 'email')).rejects.toBeInstanceOf(ChannelNotPublishableError)
  })

  it('throws ChannelNotPublishableError on a missing channel row', async () => {
    mockGetChannels.mockResolvedValue([channelRow('portal')])
    await expect(publishPost('p1', 'email')).rejects.toBeInstanceOf(ChannelNotPublishableError)
  })

  it('throws ChannelNotPublishableError on a disabled channel', async () => {
    mockGetChannels.mockResolvedValue([channelRow('email', false), channelRow('portal'), channelRow('instagram')])
    await expect(publishPost('p1', 'email')).rejects.toMatchObject({ message: 'channel is disabled' })
    expect(mockEmailPublish).not.toHaveBeenCalled()
  })
})
