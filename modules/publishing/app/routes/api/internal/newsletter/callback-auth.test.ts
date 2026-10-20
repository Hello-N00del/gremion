// TASK-205c: the three leaf callbacks are on the session guard's public list (hooks.server.ts PUBLIC_PATHS), so no
// session protects them: the shared secret in x-internal-auth is the only gate. This suite pins that gate for every
// handler, table-driven, and proves a refused request reaches NOTHING behind it (Nextcloud, Keycloak, SMTP).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const downstream = vi.hoisted(() => ({
  download: vi.fn(),
  convertOdtToHtml: vi.fn(),
  getGroupMembers: vi.fn(),
  sendMailForTenant: vi.fn(),
}))

vi.mock('$lib/server/files/nextcloud-client', () => ({
  createNextcloudClient: vi.fn(() => ({ download: downstream.download })),
}))
vi.mock('$lib/server/newsletter/collabora-convert', () => ({ convertOdtToHtml: downstream.convertOdtToHtml }))
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClientForCurrentTenant: vi.fn(() => ({ getGroupMembers: downstream.getGroupMembers })),
}))
vi.mock('$lib/server/mail/tenant-mail', () => ({
  sendMailForTenant: downstream.sendMailForTenant,
  SmtpUnconfiguredError: class extends Error {},
}))

const SECRET = 'callback-secret-0123456789'

const render = await import('./render/+server')
const resolveGroup = await import('./resolve-group/+server')
const sendMail = await import('./send-mail/+server')

const HANDLERS = [
  { name: 'render', post: render.POST, body: { odtPath: '/files/nl.odt' } },
  { name: 'resolve-group', post: resolveGroup.POST, body: { groupId: 'g-1' } },
  { name: 'send-mail', post: sendMail.POST, body: { to: 'alice@example.org', subject: 's', html: '<p>x</p>' } },
] as const

function event(body: unknown, headers: Record<string, string>) {
  return {
    request: new Request('http://localhost/api/internal/newsletter/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    locals: { tenant: { id: 'tid-1', slug: 'tenant-a' } },
  } as never
}

function expectNothingBehindTheGate() {
  expect(downstream.download).not.toHaveBeenCalled()
  expect(downstream.convertOdtToHtml).not.toHaveBeenCalled()
  expect(downstream.getGroupMembers).not.toHaveBeenCalled()
  expect(downstream.sendMailForTenant).not.toHaveBeenCalled()
}

beforeEach(() => {
  process.env.INTERNAL_NEWSLETTER_SECRET = SECRET
  for (const fn of Object.values(downstream)) fn.mockReset()
})

describe.each(HANDLERS)('/api/internal/newsletter/$name refuses without the shared secret', ({ post, body }) => {
  it('403 with no x-internal-auth header', async () => {
    const res = await post(event(body, {}))
    expect(res.status).toBe(403)
    expectNothingBehindTheGate()
  })

  it('403 with a wrong secret, a prefix of the real one, and one that extends it', async () => {
    for (const wrong of ['nope', SECRET.slice(0, -1), `${SECRET}x`, SECRET.toUpperCase()]) {
      const res = await post(event(body, { 'x-internal-auth': wrong }))
      expect(res.status, wrong).toBe(403)
    }
    expectNothingBehindTheGate()
  })

  it('403 when the server has no secret configured, even if the caller sends one (unset or empty)', async () => {
    delete process.env.INTERNAL_NEWSLETTER_SECRET
    expect((await post(event(body, { 'x-internal-auth': SECRET }))).status).toBe(403)
    expect((await post(event(body, { 'x-internal-auth': '' }))).status).toBe(403)
    process.env.INTERNAL_NEWSLETTER_SECRET = ''
    expect((await post(event(body, { 'x-internal-auth': '' }))).status).toBe(403)
    expect((await post(event(body, { 'x-internal-auth': SECRET }))).status).toBe(403)
    expectNothingBehindTheGate()
  })

  it('403 when the right secret arrives in any other header (only x-internal-auth counts)', async () => {
    const others: Record<string, string>[] = [{ 'x-internal-secret': SECRET }, { authorization: `Bearer ${SECRET}` }, { 'x-internal-push': SECRET }]
    for (const headers of others) {
      const res = await post(event(body, headers))
      expect(res.status, Object.keys(headers)[0]).toBe(403)
    }
    expectNothingBehindTheGate()
  })

  it('the refusal body names nothing (no secret, no tenant, no path)', async () => {
    const res = await post(event(body, { 'x-internal-auth': 'nope' }))
    const text = await res.text()
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('tenant-a')
    expect(JSON.parse(text)).toEqual({ success: false, error: 'Forbidden' })
  })
})

describe('the callback modules expose POST only', () => {
  it.each([
    ['render', render],
    ['resolve-group', resolveGroup],
    ['send-mail', sendMail],
  ])('%s', (_name, mod) => {
    expect(Object.keys(mod)).toEqual(['POST'])
  })
})
