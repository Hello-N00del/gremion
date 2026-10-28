#!/usr/bin/env node
// kc-token-probe.mjs -- TASK-043d TDD 1: which token of ONE authorization code
// flow of the ops realm (docker/keycloak/realm-export.ops.json, the step-up
// flow gremion-ui's KcProvisionApi.configureStepupFlow builds) carries acr,
// auth_time, realm_access.roles, aud and azp on Keycloak 26.6.1. Writes claim
// NAMES and TYPES (never a token, never a value but acr and the role check)
// to kc2661-token-claims.json beside this file.
//
// Run against a scratch Keycloak started by name (teardown by name):
//   docker run -d --name t043d-<sha8>-kc -p 127.0.0.1:<port>:8080 \
//     -e KC_BOOTSTRAP_ADMIN_USERNAME -e KC_BOOTSTRAP_ADMIN_PASSWORD \
//     quay.io/keycloak/keycloak:26.6.1@sha256:... start-dev --http-relative-path=/auth
//   cd gremion-ui && KC_BASE=http://127.0.0.1:<port>/auth KC_BOOTSTRAP_ADMIN_USERNAME=... \
//     KC_BOOTSTRAP_ADMIN_PASSWORD=... pnpm exec tsx ../test/host/fixtures/executor/kc-token-probe.mjs
//   docker rm -f -v t043d-<sha8>-kc
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KcProvisionApi } from '../../../../gremion-ui/src/lib/server/tenant/provisioner/kc-admin-api.ts'
import { Browser, msUntilFreshTotpStep, totp } from '../customer-provision/panel-session.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..', '..')
const KC = (process.env.KC_BASE ?? '').replace(/\/$/, '')
if (!/^http:\/\/127\.0\.0\.1:\d+\/auth$/.test(KC)) throw new Error('KC_BASE must be http://127.0.0.1:<port>/auth (a scratch Keycloak)')
const ORIGIN = 'http://127.0.0.1:3043'
const REDIRECT = `${ORIGIN}/auth/callback/keycloak`

async function adminToken() {
  const r = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: process.env.KC_BOOTSTRAP_ADMIN_USERNAME ?? '', password: process.env.KC_BOOTSTRAP_ADMIN_PASSWORD ?? '' }),
  })
  if (!r.ok) throw new Error(`admin token: ${r.status}`)
  return (await r.json()).access_token
}

let token = null
async function transport(method, path, body) {
  token ??= await adminToken()
  const r = await fetch(`${KC}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  if (!r.ok) throw new Error(`Keycloak Admin API error: ${r.status} on ${method} ${path}: ${await r.text()}`)
  if (r.status === 204 || r.status === 201) return undefined
  const t = await r.text()
  return t ? JSON.parse(t) : undefined
}

function shape(v) {
  if (Array.isArray(v)) return 'array'
  if (v === null) return 'null'
  return typeof v
}
function claimShapes(payload) {
  const out = {}
  for (const k of Object.keys(payload).sort()) {
    out[k] = shape(payload[k])
    if (k === 'realm_access' && payload[k] && typeof payload[k] === 'object') out['realm_access.roles'] = shape(payload[k].roles)
  }
  return out
}
const decode = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
const header = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url').toString('utf8'))

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

async function main() {
  const kc = new KcProvisionApi(transport)
  const secret = randomBytes(24).toString('hex')
  const doc = JSON.parse(readFileSync(join(REPO, 'docker', 'keycloak', 'realm-export.ops.json'), 'utf8').split('__CONTROL_PANEL_OIDC_CLIENT_SECRET__').join(secret))
  const client = doc.clients.find((c) => c.clientId === 'control-panel')
  client.secret = secret
  client.redirectUris = [`${ORIGIN}/*`]
  client.webOrigins = [ORIGIN]
  if (!(await kc.realmExists('platform'))) await kc.createRealm(doc)
  await kc.configureStepupFlow('platform')
  // an operator with a password and TOTP enrolled at first sign-in
  const email = 'probe.operator@platform.example'
  const pw = randomBytes(18).toString('base64url')
  await transport('POST', '/admin/realms/platform/users', {
    username: email, email, enabled: true, emailVerified: true, firstName: 'Probe', lastName: 'Operator',
    requiredActions: ['CONFIGURE_TOTP'], credentials: [{ type: 'password', value: pw, temporary: false }],
  }).catch((e) => { if (!/409/.test(String(e))) throw e })
  const [user] = await transport('GET', `/admin/realms/platform/users?email=${encodeURIComponent(email)}&exact=true`)
  const role = await transport('GET', '/admin/realms/platform/roles/operator')
  await transport('POST', `/admin/realms/platform/users/${user.id}/role-mappings/realm`, [role])

  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const authorize = `${KC}/realms/platform/protocol/openid-connect/auth?${new URLSearchParams({
    client_id: 'control-panel', response_type: 'code', scope: 'openid email profile', redirect_uri: REDIRECT,
    acr_values: 'loa2', max_age: '3600', state: randomBytes(8).toString('hex'), code_challenge: challenge, code_challenge_method: 'S256',
  })}`
  const b = new Browser(new Map(), { stopHosts: ['127.0.0.1'] })
  let page = await b.follow(authorize)
  let secretTotp = null
  let usedAt = null
  const kinds = []
  for (let round = 0; round < 8 && !page.stopped; round++) {
    const html = await page.res.text()
    const f = formOf(html)
    if (!f) throw new Error(`no form on ${new URL(page.url).pathname}`)
    const body = new URLSearchParams()
    if (f.fields.has('totpSecret')) {
      secretTotp = f.fields.get('totpSecret')
      body.set('totpSecret', secretTotp)
      body.set('totp', totp(Buffer.from(secretTotp, 'utf8')))
      body.set('userLabel', 'probe')
      if (f.fields.has('mode')) body.set('mode', f.fields.get('mode'))
      usedAt = Date.now()
      kinds.push('configure-totp')
    } else if (f.fields.has('otp')) {
      const wait = msUntilFreshTotpStep(usedAt)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      body.set('otp', totp(Buffer.from(secretTotp, 'utf8')))
      usedAt = Date.now()
      kinds.push('otp')
    } else if (f.fields.has('username') || f.fields.has('password')) {
      body.set('username', email)
      body.set('password', pw)
      kinds.push('password')
    } else throw new Error(`unknown form: ${[...f.fields.keys()].join(',')}`)
    page = await b.follow(new URL(f.action, page.url).toString(), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
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
  const roleIn = (p) => Array.isArray(p.realm_access?.roles) && p.realm_access.roles.includes('operator')
  const audHas = (p) => (Array.isArray(p.aud) ? p.aud : [p.aud]).includes('control-panel')
  const out = {
    keycloak: '26.6.1',
    realm: 'docker/keycloak/realm-export.ops.json + configureStepupFlow',
    request: { scope: 'openid email profile', acr_values: 'loa2', max_age: 3600 },
    flow: kinds,
    idToken: { alg: header(t.id_token).alg, typ: header(t.id_token).typ ?? null, claims: claimShapes(id), acr: id.acr ?? null, operatorRole: roleIn(id), audIncludesControlPanel: audHas(id), azp: id.azp ?? null, subEqualsUserId: id.sub === user.id },
    accessToken: { alg: header(t.access_token).alg, typ: header(t.access_token).typ ?? null, claims: claimShapes(at), acr: at.acr ?? null, operatorRole: roleIn(at), audIncludesControlPanel: audHas(at), azp: at.azp ?? null, subEqualsUserId: at.sub === user.id },
  }
  writeFileSync(join(HERE, 'kc2661-token-claims.json'), `${JSON.stringify(out, null, 2)}\n`)
  console.log(JSON.stringify({ written: 'kc2661-token-claims.json', id: { acr: out.idToken.acr, role: out.idToken.operatorRole, auth_time: 'auth_time' in id }, access: { acr: out.accessToken.acr, role: out.accessToken.operatorRole, auth_time: 'auth_time' in at } }))
}

main().catch((err) => {
  console.error(`[kc-token-probe] FAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
