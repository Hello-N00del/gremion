#!/usr/bin/env node
// kc-auth-time-probe.mjs -- TASK-081 plan step 1 (gate 1, Q3): on Keycloak 26.6.1, does the
// request the product's step-up page sends (acr_values=loa2 + max_age=300) yield an auth_time
// that is PRESENT and ADVANCES when the person authenticates again?
//
// Four authorization-code flows against the ops realm's step-up flow (the same realm and flow
// kc-token-probe.mjs uses), PKCE, one operator with TOTP:
//   A  fresh login in browser 1 (password + OTP)                -> auth_time t1
//   B  SSO reuse in browser 1, max_age set, no prompt           -> auth_time must stay t1 (not "now")
//   C  fresh login in browser 2 (password + OTP), >= 7 s later  -> auth_time t2 > t1
//   D  browser 1, prompt=login                                  -> auth_time t3 > t1
// Measured 2026-10-22 on 26.6.1: WITHOUT the auth_time mapper on the client (the realm exports'
// explicit defaultClientScopes leave out Keycloak's `basic` scope, which carries it) auth_time is
// absent from the id AND access token on all four flows even with max_age=300; WITH the client's
// auth_time mapper (docker/keycloak/realm-export.{base,ops}.json) it is present, SSO reuse keeps
// the original value and a fresh login / prompt=login advances it. A guard on the exports:
// stepup-realm.test.ts.
// Prints claim PRESENCE and the numeric auth_time/iat of each token (never a token, never a
// secret) and writes the same to fixtures/kc2661-auth-time-maxage<N>.json.
//
// Run against a scratch Keycloak started by name (teardown by name):
//   docker run -d --name t081-<sha8>-kc -p 127.0.0.1:<port>:8080 -e KC_BOOTSTRAP_ADMIN_USERNAME=... \
//     -e KC_BOOTSTRAP_ADMIN_PASSWORD=... quay.io/keycloak/keycloak:26.6.1@sha256:... start-dev --http-relative-path=/auth
//   cd gremion-ui && KC_BASE=http://127.0.0.1:<port>/auth KC_BOOTSTRAP_ADMIN_USERNAME=... KC_BOOTSTRAP_ADMIN_PASSWORD=... \
//     [PROBE_MAX_AGE=300] pnpm exec tsx ../services/kernel-api/test/authz/kc-auth-time-probe.mjs
//   docker rm -f -v t081-<sha8>-kc
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KcProvisionApi } from '../../../../gremion-ui/src/lib/server/tenant/provisioner/kc-admin-api.ts'
import { Browser, msUntilFreshTotpStep, totp } from '../../../../test/host/fixtures/customer-provision/panel-session.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..', '..')
const KC = (process.env.KC_BASE ?? '').replace(/\/$/, '')
if (!/^http:\/\/127\.0\.0\.1:\d+\/auth$/.test(KC)) throw new Error('KC_BASE must be http://127.0.0.1:<port>/auth (a scratch Keycloak)')
const MAX_AGE = process.env.PROBE_MAX_AGE ?? '300'
const ORIGIN = 'http://127.0.0.1:3081'
const REDIRECT = `${ORIGIN}/auth/callback/keycloak`
const decode = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))

let adminTok = null
async function transport(method, path, body) {
  if (!adminTok) {
    const r = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: process.env.KC_BOOTSTRAP_ADMIN_USERNAME ?? '', password: process.env.KC_BOOTSTRAP_ADMIN_PASSWORD ?? '' }),
    })
    if (!r.ok) throw new Error(`admin token: ${r.status}`)
    adminTok = (await r.json()).access_token
  }
  const init = { method, headers: { authorization: `Bearer ${adminTok}`, 'content-type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const r = await fetch(`${KC}${path}`, init)
  if (!r.ok) throw new Error(`Keycloak Admin API error: ${r.status} on ${method} ${path}: ${await r.text()}`)
  if (r.status === 204 || r.status === 201) return undefined
  const t = await r.text()
  return t ? JSON.parse(t) : undefined
}

function formOf(html) {
  const m = /<form[^>]*\baction="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i.exec(html)
  if (!m) return null
  const fields = new Map()
  for (const i of m[2].matchAll(/<input\b[^>]*>/gi)) {
    const name = /\bname="([^"]+)"/.exec(i[0])?.[1]
    if (name) fields.set(name, (/\bvalue="([^"]*)"/.exec(i[0])?.[1] ?? '').replaceAll('&amp;', '&'))
  }
  return { action: m[1].replaceAll('&amp;', '&'), fields }
}

const state = { totpSecret: null, usedAt: null }
async function flow(browser, secret, email, pw, extra = {}) {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const authorize = `${KC}/realms/platform/protocol/openid-connect/auth?${new URLSearchParams({
    client_id: 'control-panel', response_type: 'code', scope: 'openid email profile', redirect_uri: REDIRECT,
    acr_values: 'loa2', max_age: MAX_AGE, state: randomBytes(8).toString('hex'), code_challenge: challenge, code_challenge_method: 'S256', ...extra,
  })}`
  let page = await browser.follow(authorize)
  const kinds = []
  for (let round = 0; round < 8 && !page.stopped; round++) {
    const f = formOf(await page.res.text())
    if (!f) throw new Error(`no form on ${new URL(page.url).pathname}`)
    const body = new URLSearchParams()
    if (f.fields.has('totpSecret')) {
      state.totpSecret = f.fields.get('totpSecret')
      body.set('totpSecret', state.totpSecret)
      body.set('totp', totp(Buffer.from(state.totpSecret, 'utf8')))
      body.set('userLabel', 'probe')
      if (f.fields.has('mode')) body.set('mode', f.fields.get('mode'))
      state.usedAt = Date.now()
      kinds.push('configure-totp')
    } else if (f.fields.has('otp')) {
      const wait = msUntilFreshTotpStep(state.usedAt)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      body.set('otp', totp(Buffer.from(state.totpSecret, 'utf8')))
      state.usedAt = Date.now()
      kinds.push('otp')
    } else if (f.fields.has('username') || f.fields.has('password')) {
      body.set('username', email)
      body.set('password', pw)
      kinds.push('password')
    } else throw new Error(`unknown form: ${[...f.fields.keys()].join(',')}`)
    page = await browser.follow(new URL(f.action, page.url).toString(), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
  }
  if (!page.stopped) throw new Error('the flow never returned to the panel origin')
  const code = new URL(page.url).searchParams.get('code')
  const tr = await fetch(`${KC}/realms/platform/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: 'control-panel', client_secret: secret, code_verifier: verifier }),
  })
  if (!tr.ok) throw new Error(`token exchange ${tr.status}`)
  const t = await tr.json()
  const id = decode(t.id_token)
  const at = decode(t.access_token)
  const num = (v) => (typeof v === 'number' ? v : null)
  return { kinds, acr: id.acr ?? null, id: { auth_time: num(id.auth_time), iat: num(id.iat) }, access: { auth_time: num(at.auth_time), iat: num(at.iat) } }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const kc = new KcProvisionApi(transport)
  const secret = randomBytes(24).toString('hex')
  const doc = JSON.parse(readFileSync(join(REPO, 'docker', 'keycloak', 'realm-export.ops.json'), 'utf8').split('__CONTROL_PANEL_OIDC_CLIENT_SECRET__').join(secret))
  const client = doc.clients.find((c) => c.clientId === 'control-panel')
  client.secret = secret
  client.redirectUris = [`${ORIGIN}/*`]
  client.webOrigins = [ORIGIN]
  // a scratch Keycloak only (KC_BASE is pinned to loopback above): start from a clean realm every run
  if (await kc.realmExists('platform')) await transport('DELETE', '/admin/realms/platform')
  await kc.createRealm(doc)
  const email = 'probe.operator@platform.example'
  const pw = randomBytes(18).toString('base64url')
  const otpSecret = randomBytes(10).toString('hex').toUpperCase()
  await transport('POST', '/admin/realms/platform/users', {
    username: email, email, enabled: true, emailVerified: true, firstName: 'Probe', lastName: 'Operator',
    // main's step-up flow ("stepup-2fa second factor") asks for OTP only if the user already HAS one and
    // denies otherwise (CONFIGURE_TOTP inside the step-up would grant loa2 to a bare session), so the
    // probe operator is seeded with a TOTP credential up front instead of enrolling during flow A.
    credentials: [{ type: 'password', value: pw, temporary: false }, { type: 'otp', secretData: JSON.stringify({ value: otpSecret }), credentialData: JSON.stringify({ subType: 'totp', digits: 6, period: 30, algorithm: 'HmacSHA1', counter: 0 }) }],
  })
  state.totpSecret = otpSecret
  const mk = () => new Browser(new Map(), { stopHosts: ['127.0.0.1'] })
  const b1 = mk()
  const A = await flow(b1, secret, email, pw)
  await sleep(7000)
  const B = await flow(b1, secret, email, pw)
  const C = await flow(mk(), secret, email, pw)
  await sleep(7000)
  const D = await flow(b1, secret, email, pw, { prompt: 'login' })
  const at = (x) => x.access.auth_time ?? x.id.auth_time
  const present = [A, B, C, D].every((x) => at(x) !== null)
  const out = {
    keycloak: '26.6.1',
    request: { acr_values: 'loa2', max_age: Number(MAX_AGE) },
    flows: { A_fresh_login: A, B_sso_reuse: B, C_second_browser_login: C, D_prompt_login: D },
    verdict: {
      auth_time_present_in_all: present,
      sso_reuse_keeps_original: present && at(B) === at(A),
      second_login_advances: present && at(C) > at(A),
      prompt_login_advances: present && at(D) > at(A),
    },
  }
  mkdirSync(join(HERE, 'fixtures'), { recursive: true })
  writeFileSync(join(HERE, 'fixtures', `kc2661-auth-time-maxage${MAX_AGE}.json`), `${JSON.stringify(out, null, 2)}\n`)
  console.log(JSON.stringify(out, null, 2))
}

main().catch((err) => {
  console.error(`[kc-auth-time-probe] FAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
