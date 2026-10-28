// TRD-196 / PRD-OPS-005 — DB-backed proof of the content erasure hook against the
// real content schema (modules/content/migrations/001_init.sql + the news_posts
// table of app/migrations/1200). The module is disabled by default, so the test
// creates its schema in the scratch database and drops it again.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '$lib/server/db'
import { createContentErasureHook, CONTENT_ERASED_MARKER } from './erasure'

const SUBJECT = 'kc-content-subject'
const OTHER = 'kc-content-other'
const ADDR = 'anna.muster@example.org'
const hook = createContentErasureHook({ resolveEmail: async () => 'Anna.Muster@Example.org' })

// The module lane runs this suite from the module root (as content-db.integration.test.ts does).
const root = process.cwd()

// The migration files carry their own BEGIN/COMMIT; the shared sql wrapper only
// allows unsafe() inside its own transaction, so those wrappers are stripped.
const stripTx = (text: string) => text.replace(/^\s*(BEGIN|COMMIT);\s*$/gim, '')

beforeAll(async () => {
  const files = [join(root, 'migrations', '001_init.sql'), join(root, 'app', 'migrations', '1200_content_news_posts.sql')]
  await getDb().begin(async (tx) => {
    for (const f of files) await tx.unsafe(stripTx(readFileSync(f, 'utf8')))
  })
})

afterAll(async () => {
  const sql = getDb()
  await sql`DROP SCHEMA IF EXISTS content CASCADE`
  await sql`DROP TABLE IF EXISTS news_posts`
})

beforeEach(async () => {
  await getDb()`TRUNCATE content.posts, content.mailing_lists, news_posts, content.unsubscribes CASCADE`
})

async function seed() {
  const sql = getDb()
  const [mine] = await sql<{ id: string }[]>`INSERT INTO content.posts (slug, created_by) VALUES ('mine', ${SUBJECT}) RETURNING id`
  const [theirs] = await sql<{ id: string }[]>`INSERT INTO content.posts (slug, created_by) VALUES ('theirs', ${OTHER}) RETURNING id`
  await sql`INSERT INTO news_posts (title, slug, author_id) VALUES ('N1', 'n1', ${SUBJECT}), ('N2', 'n2', ${OTHER})`
  const [list] = await sql<{ id: string }[]>`INSERT INTO content.mailing_lists (name) VALUES ('Verteiler') RETURNING id`
  await sql`INSERT INTO content.mailing_list_members (mailing_list_id, email) VALUES (${list.id}, ${' Anna.Muster@EXAMPLE.org'}), (${list.id}, 'other@example.org')`
  for (const p of [mine, theirs]) {
    await sql`INSERT INTO content.send_tokens (token, post_id, email) VALUES (${'tok-a-' + p.id}, ${p.id}, ${ADDR}), (${'tok-o-' + p.id}, ${p.id}, 'other@example.org')`
    await sql`INSERT INTO content.deliveries (post_id, email, status) VALUES (${p.id}, ${ADDR}, 'sent'), (${p.id}, 'other@example.org', 'sent')`
  }
  await sql`INSERT INTO content.unsubscribes (email) VALUES (${ADDR})`
}

describe('contentErasureHook (real schema)', () => {
  it('pseudonymises authorship and delivery evidence, deletes subscription and tokens, keeps suppression and everyone else', async () => {
    await seed()
    const sql = getDb()
    const res = await hook.erase({ tenantId: 't', subjectId: SUBJECT, db: sql })
    expect(res).toEqual({
      status: 'erased',
      counts: { posts: 1, news_posts: 1, mailing_list_members: 1, send_tokens: 2, deliveries: 2 },
      // R33f MED: the suppression row it keeps is named, with its real count
      residuals: [expect.objectContaining({ table: 'content.unsubscribes', column: 'email', rows: 1 })],
    })

    expect(await sql`SELECT 1 FROM content.posts WHERE created_by = ${SUBJECT}`).toHaveLength(0)
    expect((await sql`SELECT 1 FROM content.posts WHERE created_by = ${CONTENT_ERASED_MARKER}`).length).toBe(1)
    expect(await sql`SELECT 1 FROM content.posts`).toHaveLength(2)
    expect(await sql`SELECT 1 FROM news_posts WHERE author_id = ${SUBJECT}`).toHaveLength(0)
    expect(await sql`SELECT 1 FROM news_posts`).toHaveLength(2)

    const members = await sql<{ email: string }[]>`SELECT email FROM content.mailing_list_members`
    expect(members.map((m) => m.email)).toEqual(['other@example.org'])
    expect(await sql`SELECT 1 FROM content.send_tokens WHERE lower(email) = ${ADDR}`).toHaveLength(0)
    expect(await sql`SELECT 1 FROM content.send_tokens`).toHaveLength(2)

    // delivery evidence stays (4 rows), the subject's address is gone, others untouched
    const deliveries = await sql<{ email: string }[]>`SELECT email FROM content.deliveries`
    expect(deliveries).toHaveLength(4)
    expect(deliveries.filter((d) => d.email.startsWith('erased:'))).toHaveLength(2)
    expect(new Set(deliveries.filter((d) => d.email.startsWith('erased:')).map((d) => d.email)).size).toBe(2)
    expect(deliveries.filter((d) => d.email === 'other@example.org')).toHaveLength(2)

    // the suppression list is not touched
    expect(await sql`SELECT 1 FROM content.unsubscribes WHERE email = ${ADDR}`).toHaveLength(1)
  })

  it('is idempotent: a re-run erases nothing and reports erased with zero counts', async () => {
    await seed()
    const sql = getDb()
    await hook.erase({ tenantId: 't', subjectId: SUBJECT, db: sql })
    expect(await hook.erase({ tenantId: 't', subjectId: SUBJECT, db: sql })).toEqual({
      status: 'erased',
      counts: { posts: 0, news_posts: 0, mailing_list_members: 0, send_tokens: 0, deliveries: 0 },
      residuals: [expect.objectContaining({ table: 'content.unsubscribes', rows: 1 })],
    })
  })
})
