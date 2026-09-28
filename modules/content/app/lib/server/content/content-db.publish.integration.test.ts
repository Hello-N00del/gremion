// DB-backed suite for the L2 publish/email helpers added to content-db — runs
// under `test:integration` against a real Postgres (vitest.integration.config.ts;
// tests/integration/setup.ts establishes the default tenant in ALS). The
// `content` schema (migration 044) + its L2 publish machinery (migration 045)
// are applied here in beforeAll, both idempotent (IF NOT EXISTS), so the suite
// is self-contained whether or not the content module is enabled in the test DB.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../db'
import {
	createPost,
	setChannelStatus,
	setChannelScheduledAt,
	getChannels,
	createMailingList,
	listMailingLists,
	deleteMailingList,
	addListMember,
	listMembers,
	removeListMember,
	setPostRecipients,
	getPostRecipients,
	isUnsubscribed,
	addUnsubscribe,
	filterUnsubscribed,
	mintSendToken,
	consumeUnsubscribeToken,
	claimRecipient,
	markDeliverySent,
	markDeliveryFailed,
	getPublication,
	setPublication,
	clearPublication,
} from './content-db'

describe('content-db L2 publish/email (integration)', () => {
	beforeAll(async () => {
		// The migration files wrap their DDL in BEGIN;…COMMIT;. Running that via
		// sql.unsafe() on the POOLED connection throws
		//   UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1.
		// Reserve one dedicated connection so the embedded transaction is permitted.
		const reserved = await getDb().reserve()
		try {
			for (const file of ['044_content_schema.sql', '045_content_publish.sql']) {
				const ddl = readFileSync(join(process.cwd(), 'migrations', file), 'utf-8')
				await reserved.unsafe(ddl)
			}
		} finally {
			reserved.release()
		}
	})

	beforeEach(async () => {
		const sql = getDb()
		// posts cascades to channels/media/recipients/tokens/deliveries/publications;
		// mailing_lists + unsubscribes are independent, so clear them explicitly.
		await sql`TRUNCATE content.posts RESTART IDENTITY CASCADE`
		await sql`TRUNCATE content.mailing_lists RESTART IDENTITY CASCADE`
		await sql`TRUNCATE content.unsubscribes`
	})

	// ── channel status / scheduling ───────────────────────────────────────────

	it('setChannelStatus + setChannelScheduledAt update the row', async () => {
		const post = await createPost({ title: 'Sched', created_by: 'u1' })
		const at = '2099-01-01T10:00:00.000Z'
		const sched = await setChannelScheduledAt(post.id, 'email', at)
		expect(sched.scheduled_at).toBe(at)
		const statused = await setChannelStatus(post.id, 'email', 'scheduled')
		expect(statused.status).toBe('scheduled')
		// scheduled_at survives the separate status update
		const channels = await getChannels(post.id)
		const email = channels.find((c) => c.channel === 'email')!
		expect(email.scheduled_at).toBe(at)
		expect(email.status).toBe('scheduled')

		const cleared = await setChannelScheduledAt(post.id, 'email', null)
		expect(cleared.scheduled_at).toBeNull()
	})

	// ── mailing lists + members ───────────────────────────────────────────────

	it('mailing-list CRUD + member add/list/remove (idempotent add)', async () => {
		const list = await createMailingList('Plenum')
		expect(list.id).toMatch(/[0-9a-f-]{36}/)
		expect(list.name).toBe('Plenum')

		const all = await listMailingLists()
		expect(all.map((l) => l.name)).toContain('Plenum')

		await addListMember(list.id, { email: 'a@x.de', name: 'Ada' })
		await addListMember(list.id, { email: 'a@x.de', name: 'Dup' }) // ON CONFLICT no-op
		await addListMember(list.id, { email: 'b@x.de' })
		const members = await listMembers(list.id)
		expect(members).toHaveLength(2)
		const ada = members.find((m) => m.email === 'a@x.de')!
		expect(ada.name).toBe('Ada')
		expect(ada.source).toBe('manual')

		await removeListMember(list.id, ada.id)
		expect((await listMembers(list.id)).map((m) => m.email)).toEqual(['b@x.de'])

		await deleteMailingList(list.id)
		expect((await listMailingLists()).map((l) => l.id)).not.toContain(list.id)
	})

	// ── post recipients (XOR set, wholesale replace) ──────────────────────────

	it('setPostRecipients replaces the set; mixes list + group', async () => {
		const post = await createPost({ title: 'Rcpt', created_by: 'u1' })
		const list = await createMailingList('L')
		await setPostRecipients(post.id, [
			{ mailing_list_id: list.id },
			{ keycloak_group_id: 'grp-1' },
		])
		let recips = await getPostRecipients(post.id)
		expect(recips).toHaveLength(2)
		expect(recips.some((r) => r.mailing_list_id === list.id)).toBe(true)
		expect(recips.some((r) => r.keycloak_group_id === 'grp-1')).toBe(true)

		// wholesale replace
		await setPostRecipients(post.id, [{ keycloak_group_id: 'grp-2' }])
		recips = await getPostRecipients(post.id)
		expect(recips).toHaveLength(1)
		expect(recips[0]!.keycloak_group_id).toBe('grp-2')
	})

	// ── unsubscribe + tokens ──────────────────────────────────────────────────

	it('addUnsubscribe + isUnsubscribed (idempotent)', async () => {
		expect(await isUnsubscribed('z@x.de')).toBe(false)
		await addUnsubscribe('z@x.de')
		await addUnsubscribe('z@x.de') // no throw on conflict
		expect(await isUnsubscribed('z@x.de')).toBe(true)
	})

	it('unsubscribe is case-insensitive: a mixed-case add suppresses any casing', async () => {
		// stored lowercased → a later lookup in ANY casing matches (no case-bypass).
		await addUnsubscribe('Case@X.de')
		expect(await isUnsubscribed('case@x.de')).toBe(true)
		expect(await isUnsubscribed('CASE@X.DE')).toBe(true)
		// filterUnsubscribed takes already-lowercased keys and returns the matches
		const hit = await filterUnsubscribed(['case@x.de', 'other@x.de'])
		expect(hit.has('case@x.de')).toBe(true)
		expect(hit.has('other@x.de')).toBe(false)
		// empty input short-circuits
		expect((await filterUnsubscribed([])).size).toBe(0)
	})

	it('mintSendToken is idempotent per (post,email) and case-insensitive', async () => {
		const post = await createPost({ title: 'Tok', created_by: 'u1' })
		const t1 = await mintSendToken(post.id, 'a@x.de')
		const t2 = await mintSendToken(post.id, 'a@x.de')
		expect(t1).toBe(t2) // reuse-on-conflict
		// a mixed-case mint of the SAME address reuses the same token (lowercased key)
		const t2b = await mintSendToken(post.id, 'A@X.de')
		expect(t2b).toBe(t1)
		const t3 = await mintSendToken(post.id, 'b@x.de')
		expect(t3).not.toBe(t1)
	})

	it('consumeUnsubscribeToken records the unsubscribe lowercased (token minted mixed-case)', async () => {
		const post = await createPost({ title: 'ConsCase', created_by: 'u1' })
		// mint stores 'mixed@x.de'; consuming it must suppress any casing
		const token = await mintSendToken(post.id, 'Mixed@X.de')
		expect(await consumeUnsubscribeToken(token)).toEqual({ ok: true })
		expect(await isUnsubscribed('mixed@x.de')).toBe(true)
		expect(await isUnsubscribed('MIXED@X.DE')).toBe(true)
	})

	it('consumeUnsubscribeToken: valid → ok + records unsubscribe + single-use', async () => {
		const post = await createPost({ title: 'Cons', created_by: 'u1' })
		const token = await mintSendToken(post.id, 'a@x.de')
		const r1 = await consumeUnsubscribeToken(token)
		expect(r1).toEqual({ ok: true })
		expect(await isUnsubscribed('a@x.de')).toBe(true)
		// single-use: the token is gone → invalid on the second hit
		const r2 = await consumeUnsubscribeToken(token)
		expect(r2).toEqual({ ok: false, reason: 'invalid' })
	})

	it('consumeUnsubscribeToken: invalid token', async () => {
		const r = await consumeUnsubscribeToken('does-not-exist')
		expect(r).toEqual({ ok: false, reason: 'invalid' })
	})

	it('consumeUnsubscribeToken: expired → expired, deletes token, no unsubscribe', async () => {
		const sql = getDb()
		const post = await createPost({ title: 'Exp', created_by: 'u1' })
		const token = await mintSendToken(post.id, 'old@x.de')
		// backdate the expiry into the past
		await sql`UPDATE content.send_tokens SET expires_at = now() - interval '1 day' WHERE token = ${token}`
		const r = await consumeUnsubscribeToken(token)
		expect(r).toEqual({ ok: false, reason: 'expired' })
		expect(await isUnsubscribed('old@x.de')).toBe(false)
		// token cleaned up → a re-hit is 'invalid'
		expect(await consumeUnsubscribeToken(token)).toEqual({ ok: false, reason: 'invalid' })
	})

	// ── delivery ledger (3-state claim) ───────────────────────────────────────

	it('claimRecipient: fresh → in-flight → already-sent; stale takeover', async () => {
		const sql = getDb()
		const post = await createPost({ title: 'Ledger', created_by: 'u1' })

		// first claim is fresh
		expect(await claimRecipient(post.id, 'a@x.de')).toBe('fresh')
		// second (non-stale claimed row) is in-flight
		expect(await claimRecipient(post.id, 'a@x.de')).toBe('in-flight')

		// mark sent → already-sent
		await markDeliverySent(post.id, 'a@x.de', 'msg-1')
		expect(await claimRecipient(post.id, 'a@x.de')).toBe('already-sent')

		// stale takeover: a 'claimed' row older than 15 min re-claims as fresh
		await claimRecipient(post.id, 'b@x.de') // fresh, status='claimed'
		await sql`UPDATE content.deliveries SET claimed_at = now() - interval '20 minutes'
			WHERE post_id = ${post.id} AND email = 'b@x.de'`
		expect(await claimRecipient(post.id, 'b@x.de')).toBe('fresh')
	})

	it('markDeliveryFailed records the failure', async () => {
		const sql = getDb()
		const post = await createPost({ title: 'Fail', created_by: 'u1' })
		await claimRecipient(post.id, 'a@x.de')
		await markDeliveryFailed(post.id, 'a@x.de', 'smtp 550')
		const rows = await sql<{ status: string; error_message: string }[]>`
			SELECT status, error_message FROM content.deliveries
			WHERE post_id = ${post.id} AND email = 'a@x.de'
		`
		expect(rows[0]!.status).toBe('failed')
		expect(rows[0]!.error_message).toBe('smtp 550')
	})

	// ── publications (upsert linkage) ─────────────────────────────────────────

	it('setPublication upserts + stamps published_at; getPublication reads; clear removes', async () => {
		const post = await createPost({ title: 'Pub', created_by: 'u1' })
		expect(await getPublication(post.id, 'portal')).toBeNull()

		await setPublication(post.id, 'portal', '42')
		const p1 = await getPublication(post.id, 'portal')
		expect(p1).not.toBeNull()
		expect(p1!.external_ref).toBe('42')
		expect(p1!.published_at).not.toBeNull()

		// upsert: same (post,channel) updates external_ref, no duplicate row
		await setPublication(post.id, 'portal', '99')
		const p2 = await getPublication(post.id, 'portal')
		expect(p2!.external_ref).toBe('99')

		await clearPublication(post.id, 'portal')
		expect(await getPublication(post.id, 'portal')).toBeNull()
	})
})
