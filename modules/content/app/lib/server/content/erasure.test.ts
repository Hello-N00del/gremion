// @vitest-environment node
//
// TRD-196 / PRD-OPS-005 — the content module's erasure hook (the module is off by
// default but can be enabled; when it is, an erasure must reach it). With the
// in-process backend the content schema lives in the tenant database. Personal
// data: post authorship (posts.created_by, news_posts.author_id), and the
// e-mail-keyed mailing-list membership, send tokens and delivery evidence.
//   deleted        mailing_list_members, send_tokens of the subject's address
//   pseudonymised  posts.created_by / news_posts.author_id -> 'erased';
//                  deliveries.email -> 'erased:<random>' (delivery evidence stays,
//                  the recipient does not)
//   kept           unsubscribes (suppression / consent evidence), the posts
// CONTENT_BACKEND=service: the leaf owns the database, the kernel has no
// connection -> skipped. Keycloak account gone: the address cannot be derived ->
// skipped, and nothing is changed.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Sql } from '@gremion/db'
import { createContentErasureHook, CONTENT_ERASED_MARKER } from './erasure'

function fakeDb(counts: number[]) {
  const calls: { text: string; values: unknown[] }[] = []
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values })
    return Promise.resolve({ count: counts[calls.length - 1] ?? 0 })
  }
  const db = Object.assign(tag, { begin: async (fn: (tx: typeof tag) => Promise<unknown>) => fn(tag) })
  return { db: db as unknown as Sql, calls }
}

afterEach(() => vi.unstubAllEnvs())

describe('contentErasureHook', () => {
  it('is registered under the module id and needs a connection', () => {
    const h = createContentErasureHook({ resolveEmail: async () => 'a@b.c' })
    expect(h.moduleId).toBe('content')
    expect(h.requiresConnection).not.toBe(false)
  })

  it('erases authorship, list membership, tokens and delivery evidence in one transaction', async () => {
    const { db, calls } = fakeDb([1, 2, 3, 4, 5, 0])
    const h = createContentErasureHook({ resolveEmail: async () => 'Anna.Muster@Example.org' })
    const res = await h.erase({ tenantId: 't', subjectId: 'u-1', db })
    expect(res).toEqual({
      status: 'erased',
      counts: { posts: 1, news_posts: 2, mailing_list_members: 3, send_tokens: 4, deliveries: 5 },
    })
    expect(calls).toHaveLength(6)
    expect(calls[0].text).toMatch(/UPDATE content\.posts SET created_by/)
    expect(calls[0].values).toEqual([CONTENT_ERASED_MARKER, 'u-1'])
    expect(calls[1].text).toMatch(/UPDATE news_posts SET author_id/)
    expect(calls[2].text).toMatch(/DELETE FROM content\.mailing_list_members/)
    expect(calls[2].values).toEqual(['anna.muster@example.org'])
    expect(calls[3].text).toMatch(/DELETE FROM content\.send_tokens/)
    expect(calls[4].text).toMatch(/UPDATE content\.deliveries SET email = 'erased:' \|\| gen_random_uuid\(\)/)
    // the suppression list is only COUNTED (for the residual), never modified
    expect(calls[5].text).toMatch(/^\s*SELECT 1 FROM content\.unsubscribes/)
    expect(calls.map((c) => c.text).join('\n')).not.toMatch(/(UPDATE|DELETE FROM|INSERT INTO)\s+content\.unsubscribes/)
  })

  it('R33f MED: the unsubscribes it keeps are reported as a residual with their real count', async () => {
    const { db } = fakeDb([1, 2, 3, 4, 5, 2])
    const h = createContentErasureHook({ resolveEmail: async () => 'anna@example.org' })
    const res = await h.erase({ tenantId: 't', subjectId: 'u-1', db })
    expect(res.status === 'erased' && res.residuals).toEqual([
      expect.objectContaining({ table: 'content.unsubscribes', column: 'email', rows: 2 }),
    ])
    expect(JSON.stringify(res)).not.toContain('anna@example.org')
  })

  it('no unsubscribe row of the subject: no residual', async () => {
    const { db } = fakeDb([1, 2, 3, 4, 5, 0])
    const h = createContentErasureHook({ resolveEmail: async () => 'anna@example.org' })
    const res = await h.erase({ tenantId: 't', subjectId: 'u-1', db })
    expect(res.status === 'erased' && (res.residuals ?? [])).toEqual([])
  })

  it('Keycloak account gone: skipped, nothing touched', async () => {
    const { db, calls } = fakeDb([])
    const h = createContentErasureHook({ resolveEmail: async () => null })
    const res = await h.erase({ tenantId: 't', subjectId: 'u-1', db })
    expect(res.status).toBe('skipped')
    expect(res.status === 'skipped' && res.reason).toMatch(/Keycloak account .* e-mail address/i)
    expect(calls).toHaveLength(0)
  })

  it('an account without an address still gets authorship pseudonymised, the e-mail steps are no-ops', async () => {
    const { db, calls } = fakeDb([1, 1])
    const h = createContentErasureHook({ resolveEmail: async () => '' })
    const res = await h.erase({ tenantId: 't', subjectId: 'u-1', db })
    expect(res).toEqual({
      status: 'erased',
      counts: { posts: 1, news_posts: 1, mailing_list_members: 0, send_tokens: 0, deliveries: 0 },
    })
    expect(calls).toHaveLength(2)
  })

  it('CONTENT_BACKEND=service: skipped, the kernel DB is not touched', async () => {
    vi.stubEnv('CONTENT_BACKEND', 'service')
    const { db, calls } = fakeDb([9])
    const h = createContentErasureHook({ resolveEmail: async () => 'a@b.c' })
    const res = await h.erase({ tenantId: 't', subjectId: 'u-1', db })
    expect(res.status).toBe('skipped')
    expect(res.status === 'skipped' && res.reason).toMatch(/content service/i)
    expect(calls).toHaveLength(0)
  })

  it('no connection: skipped', async () => {
    const h = createContentErasureHook({ resolveEmail: async () => 'a@b.c' })
    expect((await h.erase({ tenantId: 't', subjectId: 'u-1', db: null })).status).toBe('skipped')
  })
})
