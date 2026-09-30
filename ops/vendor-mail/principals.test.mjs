// TASK-015 TDD item 5 (unit half): the principal CLI against an in-memory
// management API that keeps the contract measured on the pinned build
// (v0.15.5-alpine, 2026-09-28): HTTP 200 for success AND failure, the verdict
// in the body; the list call returns every principal WITH its secrets.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apiFromEnv, issue, list, main, parseArgs, revoke, TOKEN_RE } from './principals.mjs'

const ENV = {
  PLATFORM_DOMAIN: 'example.org',
  STALWART_ADMIN_URL: 'http://127.0.0.1:8086',
  STALWART_ADMIN_USER: 'admin',
  STALWART_ADMIN_PASSWORD: 'unit-admin-secret',
  MAIL_ACCOUNT_QUOTA: '1000',
}

function fakeStalwart({ quirks = {} } = {}) {
  const db = new Map([['example.org', { type: 'domain', name: 'example.org' }]])
  const calls = []
  const reply = (body) => ({ status: 200, json: async () => body })
  const fetchImpl = async (url, { method, body, headers }) => {
    calls.push({ method, url, body })
    if (headers.Authorization !== `Basic ${Buffer.from('admin:unit-admin-secret').toString('base64')}`) return { status: 401, json: async () => ({ title: 'Unauthorized' }) }
    const u = new URL(url)
    const name = decodeURIComponent(u.pathname.replace(/^\/api\/principal\/?/, ''))
    if (quirks.errorOn?.(method, name)) return reply({ error: 'forbidden', details: 'quirk' })
    if (method === 'GET' && name === '') return reply({ data: { items: [...db.values()].filter((p) => p.type === 'individual'), total: db.size } })
    if (method === 'GET') return db.has(name) ? reply({ data: structuredClone(db.get(name)) }) : reply({ error: 'notFound', item: name })
    if (method === 'POST') {
      const b = JSON.parse(body)
      db.set(b.name, { ...b, secrets: [] })
      return reply({ data: db.size })
    }
    if (method === 'PATCH') {
      if (!db.has(name)) return reply({ error: 'notFound', item: name })
      for (const op of JSON.parse(body)) {
        const p = db.get(name)
        if (op.action === 'set') p[op.field] = quirks.setKeepsOld && op.field === 'secrets' ? [...(p[op.field] ?? []), ...op.value] : op.value
        if (op.action === 'addItem') p[op.field] = [...(p[op.field] ?? []), op.value]
      }
      return reply({ data: null })
    }
    if (method === 'DELETE') {
      if (!db.has(name)) return reply({ error: 'notFound', item: name })
      if (!quirks.deleteNoop) db.delete(name)
      return reply({ data: null })
    }
    return reply({ error: 'unsupported' })
  }
  return { db, calls, fetchImpl, api: apiFromEnv(ENV, fetchImpl) }
}

const quiet = () => {
  const lines = []
  return { lines, log: { log: (s) => lines.push(s), error: (s) => lines.push(s) } }
}

test('the tenant token grammar is SCHEMA 0.1: ^[a-z][a-z0-9_]{2,39}$', () => {
  for (const ok of ['abc', 'alpha_council', `a${'b'.repeat(39)}`]) assert.ok(TOKEN_RE.test(ok), ok)
  for (const bad of ['ab', 'Alpha', '1abc', 'a-b-c', 'abc@x', `a${'b'.repeat(40)}`, 'abc\n']) assert.ok(!TOKEN_RE.test(bad), bad)
  assert.throws(() => parseArgs(['issue', '--tenant', 'Alpha']), /does not match/)
  assert.throws(() => parseArgs(['issue']), /needs --tenant/)
  assert.throws(() => parseArgs(['revoke', '--tenant', 'abc', '--rotate']), /--rotate belongs to issue/)
})

test('issue creates kc-<token>@<domain> with role user and exactly one app password, printed once', async () => {
  const s = fakeStalwart()
  const { lines, log } = quiet()
  const code = await main(['issue', '--tenant', 'alpha_council'], { log, fetchImpl: s.fetchImpl, readFile: () => Object.entries(ENV).map(([k, v]) => `${k}=${v}`).join('\n') })
  assert.equal(code, 0)
  const p = s.db.get('kc-alpha_council@example.org')
  assert.deepEqual(p.roles, ['user'])
  assert.deepEqual(p.emails, ['kc-alpha_council@example.org'])
  assert.equal(p.secrets.length, 1)
  const pw = lines.find((l) => l.startsWith('APP-PASSWORD: ')).slice(14)
  assert.match(pw, /^[A-Za-z0-9]{32}$/)
  assert.equal(p.secrets[0], `$app$gremion-realm$${pw}`)
  assert.equal(lines.filter((l) => l.includes(pw)).length, 1, 'the password is printed exactly once')
  assert.ok(!s.calls.some((c) => c.url.includes(pw)), 'the password never travels in a URL')
})

test('issue is refused for an existing principal without --rotate; --rotate REPLACES the secret', async () => {
  const s = fakeStalwart()
  const first = await issue(s.api, { token: 'alpha_council', domain: 'example.org', quota: 1 })
  await assert.rejects(issue(s.api, { token: 'alpha_council', domain: 'example.org', quota: 1 }), /pass --rotate/)
  const second = await issue(s.api, { token: 'alpha_council', domain: 'example.org', quota: 1, rotate: true })
  assert.notEqual(first.password, second.password)
  assert.deepEqual(s.db.get('kc-alpha_council@example.org').secrets, [`$app$gremion-realm$${second.password}`])
})

test('a rotation that leaves the old secret behind fails the read-back', async () => {
  const s = fakeStalwart({ quirks: { setKeepsOld: true } })
  await issue(s.api, { token: 'alpha_council', domain: 'example.org', quota: 1 })
  await assert.rejects(issue(s.api, { token: 'alpha_council', domain: 'example.org', quota: 1, rotate: true }), /read-back shows 2 secret\(s\)/)
})

test('revoke removes the secrets and then the principal, both read back', async () => {
  const s = fakeStalwart()
  await issue(s.api, { token: 'alpha_council', domain: 'example.org', quota: 1 })
  await issue(s.api, { token: 'beta_council', domain: 'example.org', quota: 1 })
  assert.deepEqual(await revoke(s.api, { token: 'alpha_council', domain: 'example.org' }), { name: 'kc-alpha_council@example.org', revoked: true })
  assert.equal(s.db.has('kc-alpha_council@example.org'), false)
  assert.equal(s.db.get('kc-beta_council@example.org').secrets.length, 1, 'revoking A leaves B')
  const patch = s.calls.find((c) => c.method === 'PATCH' && c.url.endsWith('kc-alpha_council%40example.org') && c.body.includes('"value":[]'))
  assert.ok(patch, 'the secrets are removed before the delete')
  assert.deepEqual(await revoke(s.api, { token: 'alpha_council', domain: 'example.org' }), { name: 'kc-alpha_council@example.org', revoked: false })
})

test('a DELETE the server answers with data but does not perform fails the read-back', async () => {
  const s = fakeStalwart({ quirks: { deleteNoop: true } })
  await issue(s.api, { token: 'alpha_council', domain: 'example.org', quota: 1 })
  await assert.rejects(revoke(s.api, { token: 'alpha_council', domain: 'example.org' }), /still present after DELETE/)
})

test('list names only kc-* principals of the platform domain, idempotently, never a secret', async () => {
  const s = fakeStalwart()
  await issue(s.api, { token: 'beta_council', domain: 'example.org', quota: 1 })
  await issue(s.api, { token: 'alpha_council', domain: 'example.org', quota: 1 })
  s.db.set('system@example.org', { type: 'individual', name: 'system@example.org', secrets: ['$app$gremion-vendor$x'] })
  const a = await list(s.api, { domain: 'example.org' })
  assert.deepEqual(a, ['kc-alpha_council@example.org', 'kc-beta_council@example.org'])
  assert.deepEqual(await list(s.api, { domain: 'example.org' }), a)
  assert.deepEqual(await list(s.api, { domain: 'example.org', token: 'beta_council' }), ['kc-beta_council@example.org'])
})

test('HTTP 200 with {"error":...} is a failure (exit 1), never "already present"', async () => {
  const s = fakeStalwart({ quirks: { errorOn: (m) => m === 'POST' } })
  const { lines, log } = quiet()
  const code = await main(['issue', '--tenant', 'alpha_council'], { log, fetchImpl: s.fetchImpl, readFile: () => Object.entries(ENV).map(([k, v]) => `${k}=${v}`).join('\n') })
  assert.equal(code, 1)
  assert.match(lines.join('\n'), /FAIL creating kc-alpha_council@example\.org: forbidden/)
})

test('a GET answering an unknown error is a failure, not "absent"', async () => {
  const s = fakeStalwart({ quirks: { errorOn: (m, n) => m === 'GET' && n.startsWith('kc-') } })
  await assert.rejects(issue(s.api, { token: 'alpha_council', domain: 'example.org', quota: 1 }), /GET kc-alpha_council@example\.org: forbidden/)
})

test('the admin URL must be a loopback address on 8086; the credential only from mail.env', async () => {
  assert.throws(() => apiFromEnv({ ...ENV, STALWART_ADMIN_URL: 'http://192.0.2.10:8086' }), /loopback/)
  assert.throws(() => apiFromEnv({ ...ENV, STALWART_ADMIN_URL: 'http://127.0.0.1:8080' }), /loopback/)
  assert.throws(() => apiFromEnv({ ...ENV, STALWART_ADMIN_PASSWORD: '' }), /unset in mail\.env/)
  const { log } = quiet()
  assert.equal(await main(['list'], { log, fetchImpl: async () => ({}), readFile: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }) } }), 2)
})

test('an unprovisioned platform domain is a named failure', async () => {
  const s = fakeStalwart()
  s.db.delete('example.org')
  await assert.rejects(issue(s.api, { token: 'alpha_council', domain: 'example.org', quota: 1 }), /run infra\/host\/mail\/provision-roles\.sh first/)
})
