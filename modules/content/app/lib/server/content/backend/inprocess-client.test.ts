// inprocess-client.test.ts — delegation tests (no DB).
// Stubs every content-db export so the module under test never touches Postgres.
import { describe, it, expect, vi } from 'vitest'

vi.mock('../content-db', () => ({
	createPost: vi.fn(async () => ({
		id: 'p1',
		slug: 'p1',
		title: 'T',
		body_html: '',
		created_by: 'u',
		created_at: 'x',
		updated_at: 'x',
	})),
	getPost: vi.fn(async () => null),
	listPosts: vi.fn(async () => []),
	updatePostTitle: vi.fn(async () => ({
		id: 'p1',
		slug: 'p1',
		title: 'T2',
		body_html: '',
		created_by: 'u',
		created_at: 'x',
		updated_at: 'y',
	})),
	updatePostBody: vi.fn(async () => ({
		id: 'p1',
		slug: 'p1',
		title: 'T',
		body_html: '<p>b</p>',
		created_by: 'u',
		created_at: 'x',
		updated_at: 'y',
	})),
	deletePost: vi.fn(async () => undefined),
	listMedia: vi.fn(async () => []),
	addMedia: vi.fn(async () => ({
		id: 'm1',
		post_id: 'p1',
		url: 'u',
		role: 'hero',
		position: 0,
		alt: null,
	})),
	getChannels: vi.fn(async () => []),
	ensureChannels: vi.fn(async () => undefined),
	setChannelEnabled: vi.fn(async () => ({
		post_id: 'p1',
		channel: 'email',
		enabled: true,
		status: 'draft',
		scheduled_at: null,
		overrides: {},
	})),
	setChannelStatus: vi.fn(async () => ({
		post_id: 'p1',
		channel: 'email',
		enabled: false,
		status: 'sent',
		scheduled_at: null,
		overrides: {},
	})),
	setChannelScheduledAt: vi.fn(async () => ({
		post_id: 'p1',
		channel: 'email',
		enabled: false,
		status: 'draft',
		scheduled_at: '2025-01-01T00:00:00Z',
		overrides: {},
	})),
	setChannelOverrides: vi.fn(async () => ({
		post_id: 'p1',
		channel: 'email',
		enabled: false,
		status: 'draft',
		scheduled_at: null,
		overrides: { foo: 1 },
	})),
	createMailingList: vi.fn(async () => ({ id: 'ml1', name: 'L', created_at: 'x' })),
	listMailingLists: vi.fn(async () => []),
	deleteMailingList: vi.fn(async () => undefined),
	addListMember: vi.fn(async () => undefined),
	listMembers: vi.fn(async () => []),
	removeListMember: vi.fn(async () => undefined),
	setPostRecipients: vi.fn(async () => undefined),
	getPostRecipients: vi.fn(async () => []),
	isUnsubscribed: vi.fn(async () => false),
	filterUnsubscribed: vi.fn(async () => new Set<string>()),
	addUnsubscribe: vi.fn(async () => undefined),
	mintSendToken: vi.fn(async () => 'tok'),
	consumeUnsubscribeToken: vi.fn(async () => ({ ok: true as const })),
	claimRecipient: vi.fn(async () => 'fresh' as const),
	markDeliverySent: vi.fn(async () => undefined),
	markDeliveryFailed: vi.fn(async () => undefined),
	getPublication: vi.fn(async () => null),
	setPublication: vi.fn(async () => undefined),
	clearPublication: vi.fn(async () => undefined),
	enqueuePublishOp: vi.fn(async () => undefined),
	listDuePublishOps: vi.fn(async () => []),
	markPublishOpOk: vi.fn(async () => undefined),
	markPublishOpFailed: vi.fn(async () => undefined),
}))

// The inprocess client's publish() delegates to the in-kernel publishPost
// orchestrator. Stub it so this delegation test never loads the real renderer/
// db/sanitizer chain that publish.ts pulls in.
vi.mock('../publish', () => ({
	publishPost: vi.fn(async () => ({
		channel: 'portal',
		status: 'published',
		externalRef: '42',
		warnings: [],
	})),
}))

import { InprocessContentClient } from './inprocess-client'
import * as db from '../content-db'
import * as pub from '../publish'

describe('InprocessContentClient', () => {
	it('kind is inprocess', () => {
		expect(new InprocessContentClient().kind).toBe('inprocess')
	})

	it('delegates createPost to content-db', async () => {
		const c = new InprocessContentClient()
		const p = await c.createPost({ title: 'T', created_by: 'u' })
		expect(db.createPost).toHaveBeenCalledWith({ title: 'T', created_by: 'u' })
		expect(p.id).toBe('p1')
	})

	it('delegates getPost and returns null pass-through', async () => {
		expect(await new InprocessContentClient().getPost('nope')).toBeNull()
	})

	it('delegates listPosts', async () => {
		const result = await new InprocessContentClient().listPosts()
		expect(db.listPosts).toHaveBeenCalled()
		expect(result).toEqual([])
	})

	it('delegates updatePostTitle', async () => {
		const c = new InprocessContentClient()
		const p = await c.updatePostTitle('p1', 'T2')
		expect(db.updatePostTitle).toHaveBeenCalledWith('p1', 'T2')
		expect(p.title).toBe('T2')
	})

	it('delegates updatePostBody', async () => {
		const c = new InprocessContentClient()
		const p = await c.updatePostBody('p1', '<p>b</p>')
		expect(db.updatePostBody).toHaveBeenCalledWith('p1', '<p>b</p>')
		expect(p.body_html).toBe('<p>b</p>')
	})

	it('delegates deletePost', async () => {
		await new InprocessContentClient().deletePost('p1')
		expect(db.deletePost).toHaveBeenCalledWith('p1')
	})

	it('delegates listMedia', async () => {
		await new InprocessContentClient().listMedia('p1')
		expect(db.listMedia).toHaveBeenCalledWith('p1')
	})

	it('delegates addMedia', async () => {
		const m = { url: 'u', role: 'hero' as const }
		const result = await new InprocessContentClient().addMedia('p1', m)
		expect(db.addMedia).toHaveBeenCalledWith('p1', m)
		expect(result.id).toBe('m1')
	})

	it('delegates getChannels', async () => {
		await new InprocessContentClient().getChannels('p1')
		expect(db.getChannels).toHaveBeenCalledWith('p1')
	})

	it('delegates ensureChannels', async () => {
		await new InprocessContentClient().ensureChannels('p1')
		expect(db.ensureChannels).toHaveBeenCalledWith('p1')
	})

	it('delegates setChannelEnabled', async () => {
		const result = await new InprocessContentClient().setChannelEnabled('p1', 'email', true)
		expect(db.setChannelEnabled).toHaveBeenCalledWith('p1', 'email', true)
		expect(result.enabled).toBe(true)
	})

	it('delegates setChannelStatus', async () => {
		await new InprocessContentClient().setChannelStatus('p1', 'email', 'sent')
		expect(db.setChannelStatus).toHaveBeenCalledWith('p1', 'email', 'sent')
	})

	it('delegates setChannelScheduledAt', async () => {
		await new InprocessContentClient().setChannelScheduledAt('p1', 'email', '2025-01-01T00:00:00Z')
		expect(db.setChannelScheduledAt).toHaveBeenCalledWith('p1', 'email', '2025-01-01T00:00:00Z')
	})

	it('delegates setChannelOverrides', async () => {
		await new InprocessContentClient().setChannelOverrides('p1', 'email', { foo: 1 })
		expect(db.setChannelOverrides).toHaveBeenCalledWith('p1', 'email', { foo: 1 })
	})

	it('delegates createMailingList', async () => {
		const result = await new InprocessContentClient().createMailingList('L')
		expect(db.createMailingList).toHaveBeenCalledWith('L')
		expect(result.id).toBe('ml1')
	})

	it('delegates listMailingLists', async () => {
		await new InprocessContentClient().listMailingLists()
		expect(db.listMailingLists).toHaveBeenCalled()
	})

	it('delegates deleteMailingList', async () => {
		await new InprocessContentClient().deleteMailingList('ml1')
		expect(db.deleteMailingList).toHaveBeenCalledWith('ml1')
	})

	it('delegates addListMember', async () => {
		const m = { email: 'a@b.com' }
		await new InprocessContentClient().addListMember('ml1', m)
		expect(db.addListMember).toHaveBeenCalledWith('ml1', m)
	})

	it('delegates listMembers', async () => {
		await new InprocessContentClient().listMembers('ml1')
		expect(db.listMembers).toHaveBeenCalledWith('ml1')
	})

	it('delegates removeListMember', async () => {
		await new InprocessContentClient().removeListMember('ml1', 'mem1')
		expect(db.removeListMember).toHaveBeenCalledWith('ml1', 'mem1')
	})

	it('delegates setPostRecipients', async () => {
		const recips = [{ mailing_list_id: 'ml1' }]
		await new InprocessContentClient().setPostRecipients('p1', recips)
		expect(db.setPostRecipients).toHaveBeenCalledWith('p1', recips)
	})

	it('delegates getPostRecipients', async () => {
		await new InprocessContentClient().getPostRecipients('p1')
		expect(db.getPostRecipients).toHaveBeenCalledWith('p1')
	})

	it('delegates isUnsubscribed', async () => {
		const result = await new InprocessContentClient().isUnsubscribed('a@b.com')
		expect(db.isUnsubscribed).toHaveBeenCalledWith('a@b.com')
		expect(result).toBe(false)
	})

	it('delegates filterUnsubscribed', async () => {
		const result = await new InprocessContentClient().filterUnsubscribed(['a@b.com'])
		expect(db.filterUnsubscribed).toHaveBeenCalledWith(['a@b.com'])
		expect(result).toBeInstanceOf(Set)
	})

	it('delegates addUnsubscribe', async () => {
		await new InprocessContentClient().addUnsubscribe('a@b.com')
		expect(db.addUnsubscribe).toHaveBeenCalledWith('a@b.com')
	})

	it('delegates mintSendToken', async () => {
		const result = await new InprocessContentClient().mintSendToken('p1', 'a@b.com')
		expect(db.mintSendToken).toHaveBeenCalledWith('p1', 'a@b.com')
		expect(result).toBe('tok')
	})

	it('delegates consumeUnsubscribeToken', async () => {
		const result = await new InprocessContentClient().consumeUnsubscribeToken('tok')
		expect(db.consumeUnsubscribeToken).toHaveBeenCalledWith('tok')
		expect(result).toEqual({ ok: true })
	})

	it('delegates claimRecipient', async () => {
		const result = await new InprocessContentClient().claimRecipient('p1', 'a@b.com')
		expect(db.claimRecipient).toHaveBeenCalledWith('p1', 'a@b.com')
		expect(result).toBe('fresh')
	})

	it('delegates markDeliverySent', async () => {
		await new InprocessContentClient().markDeliverySent('p1', 'a@b.com', 'msg1')
		expect(db.markDeliverySent).toHaveBeenCalledWith('p1', 'a@b.com', 'msg1')
	})

	it('delegates markDeliveryFailed', async () => {
		await new InprocessContentClient().markDeliveryFailed('p1', 'a@b.com', 'err')
		expect(db.markDeliveryFailed).toHaveBeenCalledWith('p1', 'a@b.com', 'err')
	})

	it('delegates getPublication', async () => {
		const result = await new InprocessContentClient().getPublication('p1', 'email')
		expect(db.getPublication).toHaveBeenCalledWith('p1', 'email')
		expect(result).toBeNull()
	})

	it('delegates setPublication', async () => {
		await new InprocessContentClient().setPublication('p1', 'portal', 'ref1')
		expect(db.setPublication).toHaveBeenCalledWith('p1', 'portal', 'ref1')
	})

	it('delegates clearPublication', async () => {
		await new InprocessContentClient().clearPublication('p1', 'portal')
		expect(db.clearPublication).toHaveBeenCalledWith('p1', 'portal')
	})

	it('delegates enqueuePublishOp (ignores channel/op, passes postId)', async () => {
		await new InprocessContentClient().enqueuePublishOp('p1', 'instagram', 'publish')
		expect(db.enqueuePublishOp).toHaveBeenCalledWith('p1')
	})

	it('delegates listDuePublishOps', async () => {
		await new InprocessContentClient().listDuePublishOps()
		expect(db.listDuePublishOps).toHaveBeenCalled()
	})

	it('delegates markPublishOpOk with optional externalRef', async () => {
		await new InprocessContentClient().markPublishOpOk('op1', 'ref1')
		expect(db.markPublishOpOk).toHaveBeenCalledWith('op1', 'ref1')
	})

	it('delegates markPublishOpOk with undefined externalRef defaulting to empty string', async () => {
		vi.mocked(db.markPublishOpOk).mockClear()
		await new InprocessContentClient().markPublishOpOk('op1')
		expect(db.markPublishOpOk).toHaveBeenCalledWith('op1', '')
	})

	it('delegates markPublishOpFailed', async () => {
		await new InprocessContentClient().markPublishOpFailed('op1', 'err')
		expect(db.markPublishOpFailed).toHaveBeenCalledWith('op1', 'err')
	})

	it('delegates publish to the in-kernel publishPost orchestrator', async () => {
		const result = await new InprocessContentClient().publish('p1', 'portal')
		expect(pub.publishPost).toHaveBeenCalledWith('p1', 'portal')
		expect(result).toMatchObject({ channel: 'portal', status: 'published', externalRef: '42' })
	})
})
