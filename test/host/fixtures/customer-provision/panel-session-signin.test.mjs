// node --test test/host/fixtures/customer-provision/panel-session-signin.test.mjs
//
// `panel-session.mjs signin` against a stub of the Q16 shape: the customer's
// realm lives on the customer's OWN host (https://<host>/auth/realms/<slug>),
// the same host gremion-ui answers on. The driver must keep going through
// Keycloak's pages on that host and stop only when the browser is back on an
// APPLICATION path of it (review r4 HIGH: the old predicate stopped on
// Keycloak's first login page, so no password or OTP was ever sent). The CLI
// is run exactly as customer-provision-proof.sh's customer-admins phase runs
// it, --title included.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { totp } from './panel-session.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'panel-session.mjs')
const HOST = 'rat.proof-x.test'
const SLUG = 'proof-x'
const REALM = `https://${HOST}/auth/realms/${SLUG}`
const USER = 'roles+proof-x-it@proof.test'
const PASSWORD = 'Admin-stub-Aa1!'
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DP'
const TITLE = 'Übersicht'

/** What the stub saw, for the assertions. */
const seen = { password: null, otp: null, dashboard: 0 }

function body(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))))
  })
}
const page = (res, html, headers = {}) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers })
  res.end(html)
}
const redirect = (res, location, headers = {}) => {
  res.writeHead(302, { location, ...headers })
  res.end()
}

/** gremion-ui and Keycloak on ONE host, as the realm router of Q16 serves them. */
async function stub(req, res) {
  const u = new URL(req.url, `https://${HOST}`)
  const cookie = req.headers.cookie ?? ''
  if (req.headers.host !== HOST) return redirect(res, 'https://wrong-host.invalid/')
  const kc = `/auth/realms/${SLUG}`
  // ── Keycloak ─────────────────────────────────────────────────────────────
  if (u.pathname === `${kc}/protocol/openid-connect/auth`) {
    const state = u.searchParams.get('state')
    return page(res, `<html><head><title>Anmelden</title></head><body>
      <form id="kc-form-login" action="${kc}/login-actions/authenticate?session_code=s1&amp;state=${state}" method="post">
      <input name="username" value=""><input name="password" type="password"><input name="credentialId" type="hidden" value="">
      </form></body></html>`, { 'set-cookie': 'KC_RESTART=r; Path=/auth/realms/proof-x/' })
  }
  if (u.pathname === `${kc}/login-actions/authenticate` && req.method === 'POST') {
    const f = await body(req)
    if (u.searchParams.get('execution') === 'otp') {
      seen.otp = f.get('otp')
      if (f.get('otp') !== totp(Buffer.from(SECRET, 'utf8'))) return page(res, '<form action="x"><input name="otp"></form><span id="input-error-otp">falsch</span>')
      return redirect(res, `https://${HOST}/auth/callback/keycloak?state=${u.searchParams.get('state')}&code=c0de&iss=${encodeURIComponent(REALM)}`)
    }
    seen.password = `${f.get('username')}:${f.get('password')}`
    if (f.get('username') !== USER || f.get('password') !== PASSWORD) return page(res, '<form action="x"><input name="username"><input name="password"></form>')
    // Keycloak redirects within its OWN paths on the same host before the OTP form.
    return redirect(res, `${kc}/login-actions/authenticate?execution=otp&state=${u.searchParams.get('state')}`)
  }
  if (u.pathname === `${kc}/login-actions/authenticate` && u.searchParams.get('execution') === 'otp') {
    return page(res, `<html><body><form id="kc-otp-login-form" action="${kc}/login-actions/authenticate?execution=otp&amp;state=${u.searchParams.get('state')}" method="post">
      <input name="otp" autocomplete="one-time-code"><input type="hidden" name="selectedCredentialId" value="cred-1"></form></body></html>`)
  }
  if (u.pathname.startsWith('/auth/resources/')) return page(res, '')
  // ── gremion-ui ───────────────────────────────────────────────────────────
  if (u.pathname === '/' && req.method === 'GET') {
    if (!cookie.includes('authjs.session-token=s3ss')) return redirect(res, '/auth/login')
    seen.dashboard += 1
    return page(res, `<html><head><title>${TITLE} – Gremion</title></head><body>dashboard</body></html>`)
  }
  if (u.pathname === '/auth/csrf') {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'authjs.csrf-token=t0k; Path=/' })
    return res.end(JSON.stringify({ csrfToken: 't0k' }))
  }
  if (u.pathname === '/auth/signin/keycloak' && req.method === 'POST') {
    const f = await body(req)
    if (f.get('csrfToken') !== 't0k') return redirect(res, '/auth/error')
    const az = new URL(`${REALM}/protocol/openid-connect/auth`)
    az.searchParams.set('client_id', 'gremion-ui')
    az.searchParams.set('response_type', 'code')
    az.searchParams.set('redirect_uri', `https://${HOST}/auth/callback/keycloak`)
    az.searchParams.set('state', 'st8')
    return redirect(res, az.toString())
  }
  if (u.pathname === '/auth/callback/keycloak') {
    if (u.searchParams.get('code') !== 'c0de' || u.searchParams.get('iss') !== REALM) return redirect(res, '/auth/error')
    return redirect(res, `https://${HOST}/`, { 'set-cookie': 'authjs.session-token=s3ss; Path=/; HttpOnly' })
  }
  res.writeHead(404)
  res.end('not found')
}

let server
let base
let dir
before(async () => {
  server = http.createServer((req, res) => {
    stub(req, res).catch((e) => {
      res.writeHead(500)
      res.end(String(e))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  dir = mkdtempSync(join(HERE, '..', '..', '..', '..', '.scratch', 'signin-'))
  writeFileSync(join(dir, 'pw'), `${PASSWORD}\n`)
  writeFileSync(join(dir, 'totp'), `${SECRET}\n`)
  // the enrolment was long ago: no wait for a fresh TOTP step
  const old = new Date(Date.now() - 3_600_000)
  utimesSync(join(dir, 'totp'), old, old)
})
after(() => {
  server?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

describe('panel-session signin, realm on the app host (Q16)', () => {
  it('drives password + OTP through Keycloak on the same host and ends 200 on / with the PageTitle', async () => {
    seen.password = null
    seen.otp = null
    seen.dashboard = 0
    const r = await run([
      'signin', '--app', `https://${HOST}`, '--realm-url', REALM, '--user', USER,
      '--password-file', join(dir, 'pw'), '--totp-secret-in', join(dir, 'totp'),
      '--title', TITLE, '--resolve', `${HOST}=${base}`,
    ])
    assert.equal(r.code, 0, `signin failed: ${r.err} ${r.out}`)
    assert.equal(seen.password, `${USER}:${PASSWORD}`, 'the password was never sent to Keycloak')
    assert.ok(seen.otp, 'the OTP was never sent to Keycloak')
    assert.equal(seen.dashboard, 1, 'the dashboard was never served')
    const out = JSON.parse(r.out.trim().split('\n').pop())
    assert.equal(out.status, 200)
    assert.equal(out.path, '/')
    assert.equal(out.title, true)
    assert.deepEqual(out.kinds, ['password', 'otp'])
    assert.equal(out.authorize, `${REALM}/protocol/openid-connect/auth`)
  })

  it('the rehearsal form stops at the callback on the SAME host, never on a Keycloak redirect', async () => {
    const az = `${REALM}/protocol/openid-connect/auth?client_id=rehearsal-app&response_type=code&state=t043&redirect_uri=${encodeURIComponent(`https://${HOST}/auth/callback/keycloak`)}`
    const r = await run([
      'signin', '--app', `https://${HOST}`, '--authorize-url', az, '--stop-host', HOST, '--realm-url', REALM, '--user', USER,
      '--password-file', join(dir, 'pw'), '--totp-secret-in', join(dir, 'totp'), '--resolve', `${HOST}=${base}`,
    ])
    assert.equal(r.code, 0, `signin failed: ${r.err} ${r.out}`)
    const out = JSON.parse(r.out.trim().split('\n').pop())
    assert.equal(out.callback, `https://${HOST}/auth/callback/keycloak`)
    assert.equal(out.code, true)
    assert.equal(out.iss, REALM)
    assert.deepEqual(out.kinds, ['password', 'otp'])
  })

  it('a sign-in whose page title is not the dashboard fails', async () => {
    const r = await run([
      'signin', '--app', `https://${HOST}`, '--realm-url', REALM, '--user', USER,
      '--password-file', join(dir, 'pw'), '--totp-secret-in', join(dir, 'totp'),
      '--title', 'Mitglieder', '--resolve', `${HOST}=${base}`,
    ])
    assert.equal(r.code, 1)
  })

  it('--title is required for the gremion-ui form', async () => {
    const r = await run([
      'signin', '--app', `https://${HOST}`, '--realm-url', REALM, '--user', USER,
      '--password-file', join(dir, 'pw'), '--totp-secret-in', join(dir, 'totp'), '--resolve', `${HOST}=${base}`,
    ])
    assert.equal(r.code, 1)
    assert.match(r.err, /--title is required/)
  })
})
