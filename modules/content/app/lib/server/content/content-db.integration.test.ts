// DB-backed suite for content-db — runs under `test:integration` against a real
// Postgres (vitest.integration.config.ts; tests/integration/setup.ts establishes
// the default tenant in ALS before each test). The `content` schema is created
// by migration 044, which is module-gated — so we apply the migration's
// (idempotent, IF NOT EXISTS) DDL once in beforeAll, making this suite
// self-contained whether or not the content module is enabled in the test DB.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../db'
import {
	createPost,
	getPost,
	getChannels,
	updatePostBody,
} from './content-db'

describe('content-db (integration)', () => {
	beforeAll(async () => {
		const ddl = readFileSync(
			join(process.cwd(), 'migrations', '044_content_schema.sql'),
			'utf-8',
		)
		// Idempotent (all IF NOT EXISTS) — safe to re-apply on an already-migrated DB.
		// The migration file wraps its DDL in BEGIN;…COMMIT;. Running that via
		// sql.unsafe() on the POOLED connection throws
		//   UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1
		// because postgres.js refuses embedded transaction control on a pool.
		// Reserve a single dedicated connection (like the real migration runner
		// uses sql.begin) so the file's own BEGIN/COMMIT is permitted.
		const reserved = await getDb().reserve()
		try {
			await reserved.unsafe(ddl)
		} finally {
			reserved.release()
		}
	})

	beforeEach(async () => {
		const sql = getDb()
		// post_channels + post_media cascade from posts on delete; TRUNCATE CASCADE
		// clears all three. RESTART IDENTITY is a no-op for uuid PKs but harmless.
		await sql`TRUNCATE content.posts RESTART IDENTITY CASCADE`
	})

	it('create→get round-trips the post', async () => {
		const created = await createPost({ title: 'Spring Plenum Recap', created_by: 'user-1' })
		expect(created.id).toMatch(/[0-9a-f-]{36}/)
		expect(created.slug).toBe('spring-plenum-recap')
		expect(created.title).toBe('Spring Plenum Recap')
		expect(created.body_html).toBe('')
		expect(created.created_by).toBe('user-1')
		expect(typeof created.created_at).toBe('string')

		const fetched = await getPost(created.id)
		expect(fetched).not.toBeNull()
		expect(fetched!.id).toBe(created.id)
		expect(fetched!.slug).toBe(created.slug)
		expect(fetched!.title).toBe('Spring Plenum Recap')
	})

	it('getPost returns null for a missing id', async () => {
		const missing = await getPost('00000000-0000-0000-0000-000000000000')
		expect(missing).toBeNull()
	})

	it('ensureChannels seeds exactly 3 post_channels rows (all disabled, draft)', async () => {
		const post = await createPost({ title: 'Channels Seed', created_by: 'user-1' })
		const channels = await getChannels(post.id)
		expect(channels).toHaveLength(3)
		expect(channels.map((c) => c.channel).sort()).toEqual(['email', 'instagram', 'portal'])
		for (const c of channels) {
			expect(c.enabled).toBe(false)
			expect(c.status).toBe('draft')
			expect(c.overrides).toEqual({})
		}
	})

	it('dedupes the slug on a real UNIQUE conflict', async () => {
		const a = await createPost({ title: 'Duplicate Title', created_by: 'user-1' })
		const b = await createPost({ title: 'Duplicate Title', created_by: 'user-1' })
		const c = await createPost({ title: 'Duplicate Title', created_by: 'user-1' })
		expect(a.slug).toBe('duplicate-title')
		expect(b.slug).toBe('duplicate-title-2')
		expect(c.slug).toBe('duplicate-title-3')
	})

	it('updatePostBody persists sanitized HTML (strips <script>, keeps <h2>)', async () => {
		const post = await createPost({ title: 'Body Sanitize', created_by: 'user-1' })
		const updated = await updatePostBody(
			post.id,
			'<h2>Intro</h2><p>hello</p><script>alert(1)</script>',
		)
		expect(updated.body_html).not.toContain('<script')
		expect(updated.body_html).not.toContain('alert(1)')
		expect(updated.body_html).toContain('<h2>Intro</h2>')
		expect(updated.body_html).toContain('<p>hello</p>')

		// Persisted, not just returned.
		const reread = await getPost(post.id)
		expect(reread!.body_html).toBe(updated.body_html)
	})
})
