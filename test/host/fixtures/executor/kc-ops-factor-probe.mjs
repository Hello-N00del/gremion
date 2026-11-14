#!/usr/bin/env node
// kc-ops-factor-probe.mjs -- can the second factor of the ops realm
// (docker/keycloak/realm-export.ops.json + the step-up flow gremion-ui's
// KcProvisionApi.configureStepupFlow builds) be weakened by someone who holds the
// operator's PASSWORD ONLY (an acr-loa1 session)? It asks the account console of
// a scratch Keycloak, which is where a password-only session can reach:
//
//   1. a plain sign-in (no acr_values) is asked for the password and nothing
//      else, even though the operator has an authenticator enrolled (that is what
//      "loa1" is here);
//   2. with the access token of THAT session, does the account API list the
//      operator's credentials, and does it DELETE the OTP credential?
//   3. with the SSO session of THAT sign-in, does the application-initiated
//      action CONFIGURE_TOTP (the account console's "set up another authenticator")
//      run without asking for the factor first?
//   4. the realm's reset-credentials flow: its executions and how each is required.
//   5. whether the sign-in page offers "forgot password", and what the endpoint
//      answers when asked for directly.
//
// It prints one JSON document of FACTS (statuses, names, requirements; never a
// token, secret or password). The verdict is the caller's: the run that closed
// the gaps in the realm export is recorded in docs/runbooks/control-panel-access.md.
//
// Run against a scratch Keycloak started by name (teardown by name):
//   docker run -d --name pm-kcprobe-<hex> -p 127.0.0.1:<port>:8080 \
//     -e KC_BOOTSTRAP_ADMIN_USERNAME -e KC_BOOTSTRAP_ADMIN_PASSWORD \
//     quay.io/keycloak/keycloak:26.6.1@sha256:... start-dev --http-relative-path=/auth
//   cd gremion-ui && KC_BASE=http://127.0.0.1:<port>/auth KC_BOOTSTRAP_ADMIN_USERNAME=... \
//     KC_BOOTSTRAP_ADMIN_PASSWORD=... pnpm exec tsx ../test/host/fixtures/executor/kc-ops-factor-probe.mjs
//   docker rm -f -v pm-kcprobe-<hex>
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KcProvisionApi } from '../../../../gremion-ui/src/lib/server/tenant/provisioner/kc-admin-api.ts'
import { Browser, totp } from '../customer-provision/panel-session.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..', '..')
const KC = (process.env.KC_BASE ?? '').replace(/\/$/, '')
if (!/^http:\/\/127\.0\.0\.1:\d+\/auth$/.test(KC)) throw new Error('KC_BASE must be http://127.0.0.1:<port>/auth (a scratch Keycloak)')
const ORIGIN = process.env.PROBE_PANEL_ORIGIN ?? 'http://127.0.0.1:3043'

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
const pkce = () => {
  const v = randomBytes(32).toString('base64url')
  return { verifier: v, challenge: createHash('sha256').update(v).digest('base64url') }
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
const form = { 'content-type': 'application/x-www-form-urlencoded' }
const accountUrl = `${KC}/realms/platform/account/`
const authorizeUrl = (extra) => {
  const p = pkce()
  return { ...p, url: `${KC}/realms/platform/protocol/openid-connect/auth?${new URLSearchParams({ client_id: 'account-console', response_type: 'code', scope: 'openid', redirect_uri: accountUrl, state: randomBytes(8).toString('hex'), code_challenge: p.challenge, code_challenge_method: 'S256', ...extra })}` }
}

async function main() {
  const kc = new KcProvisionApi(transport)
  const secret = randomBytes(24).toString('hex')
  const doc = JSON.parse(readFileSync(join(REPO, 'docker', 'keycloak', 'realm-export.ops.json'), 'utf8').split('__CONTROL_PANEL_OIDC_CLIENT_SECRET__').join(secret))
  const client = doc.clients.find((c) => c.clientId === 'control-panel')
  client.redirectUris = [`${ORIGIN}/*`]
  client.webOrigins = [ORIGIN]
  if (process.env.PROBE_RESET_REALM === '1' && (await kc.realmExists('platform'))) await transport('DELETE', '/admin/realms/platform')
  if (!(await kc.realmExists('platform'))) await kc.createRealm(doc)
  await kc.configureStepupFlow('platform')
  const realm = await transport('GET', '/admin/realms/platform')
  // the version is READ from the server under test, never asserted from a constant
  const info = await transport('GET', '/admin/serverinfo')
  const kcVersion = info?.systemInfo?.version
  if (!kcVersion) throw new Error('serverinfo: the scratch Keycloak reported no version')
  const facts = { keycloak: kcVersion, realm: { resetPasswordAllowed: realm.resetPasswordAllowed, rememberMe: realm.rememberMe, editUsernameAllowed: realm.editUsernameAllowed } }

  // the operator, as `operator add --no-mail` makes it
  const email = 'probe.operator@platform.example'
  const tmpPw = randomBytes(18).toString('base64url')
  const pw = randomBytes(18).toString('base64url')
  await transport('POST', '/admin/realms/platform/users', {
    username: email, email, enabled: true, emailVerified: true, firstName: 'Probe', lastName: 'Operator',
    requiredActions: ['UPDATE_PASSWORD', 'CONFIGURE_TOTP'], credentials: [{ type: 'password', value: tmpPw, temporary: true }],
  })
  const [user] = await transport('GET', `/admin/realms/platform/users?email=${encodeURIComponent(email)}&exact=true`)
  const role = await transport('GET', '/admin/realms/platform/roles/operator')
  await transport('POST', `/admin/realms/platform/users/${user.id}/role-mappings/realm`, [role])

  // enrolment: ONE plain sign-in at the account console runs UPDATE_PASSWORD and CONFIGURE_TOTP
  let secretTotp = null
  {
    const b0 = new Browser(new Map())
    let page = await b0.follow(authorizeUrl({}).url)
    for (let round = 0; round < 8 && !new URL(page.url).searchParams.has('code'); round++) {
      const f = formOf(await page.res.text())
      if (!f) throw new Error('enrolment: no form')
      const body = new URLSearchParams()
      if (f.fields.has('totpSecret')) {
        secretTotp = f.fields.get('totpSecret')
        body.set('totpSecret', secretTotp)
        body.set('totp', totp(Buffer.from(secretTotp, 'utf8')))
        body.set('userLabel', 'probe')
        if (f.fields.has('mode')) body.set('mode', f.fields.get('mode'))
      } else if (f.fields.has('password-new')) {
        body.set('password-new', pw)
        body.set('password-confirm', pw)
      } else if (f.fields.has('username') || f.fields.has('password')) {
        body.set('username', email)
        body.set('password', tmpPw)
      } else throw new Error(`enrolment: unknown form: ${[...f.fields.keys()].join(',')}`)
      page = await b0.follow(new URL(f.action, page.url).toString(), { method: 'POST', headers: form, body })
    }
    if (!secretTotp) throw new Error('enrolment: CONFIGURE_TOTP did not run')
  }
  facts.enrolled = true

  // 1. a plain sign-in with the password only
  const a = authorizeUrl({})
  const b = new Browser(new Map())
  let page = await b.follow(a.url)
  const asked = []
  for (let round = 0; round < 6 && !new URL(page.url).searchParams.has('code'); round++) {
    const f = formOf(await page.res.text())
    if (!f) break
    const body = new URLSearchParams()
    if (f.fields.has('otp')) { asked.push('otp'); break }
    if (f.fields.has('username') || f.fields.has('password')) {
      asked.push('password')
      body.set('username', email)
      body.set('password', pw)
    } else { asked.push(`unexpected:${[...f.fields.keys()].join(',')}`); break }
    page = await b.follow(new URL(f.action, page.url).toString(), { method: 'POST', headers: form, body })
  }
  const code = new URL(page.url).searchParams.get('code')
  facts.plainSignIn = { asked, gotCode: Boolean(code) }
  if (!code) throw new Error(`plain sign-in did not complete: ${JSON.stringify(facts.plainSignIn)}`)
  const tr = await fetch(`${KC}/realms/platform/protocol/openid-connect/token`, {
    method: 'POST', headers: form,
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: accountUrl, client_id: 'account-console', code_verifier: a.verifier }),
  })
  if (!tr.ok) throw new Error(`account-console token exchange answered ${tr.status}`)
  const t = await tr.json()
  if (typeof t?.access_token !== 'string') throw new Error('account-console token exchange returned no access_token')
  const at = JSON.parse(Buffer.from(t.access_token.split('.')[1], 'base64url').toString('utf8'))
  facts.plainSignIn.acr = at.acr ?? null
  facts.plainSignIn.accountRoles = at.resource_access?.account?.roles ?? []

  // 2. the account API with that token
  const api = (method, path) => fetch(`${KC}/realms/platform/account${path}`, { method, headers: { authorization: `Bearer ${t.access_token}`, accept: 'application/json' } })
  const list = await api('GET', '/credentials')
  const listed = list.ok ? await list.json() : []
  const types = listed.map((c) => ({ type: c.type, user: (c.userCredentialMetadatas ?? []).map((m) => ({ id: m.credential?.id, type: m.credential?.type })) }))
  facts.accountApi = { listStatus: list.status, credentialTypes: types.map((x) => x.type) }
  const otp = types.flatMap((x) => x.user).find((u) => u.type === 'otp')
  if (otp?.id) {
    const del = await api('DELETE', `/credentials/${otp.id}`)
    facts.accountApi.deleteOtpStatus = del.status
    const after = await transport('GET', `/admin/realms/platform/users/${user.id}/credentials`)
    facts.accountApi.otpStillThere = after.some((c) => c.type === 'otp')
  } else {
    facts.accountApi.deleteOtpStatus = 'no otp credential was listed'
  }

  // 3. the application-initiated action CONFIGURE_TOTP on the SSO session of the plain sign-in
  //    (runs after step 2, whatever step 2 answered)
  const k = authorizeUrl({ kc_action: 'CONFIGURE_TOTP' })
  const aia = await b.follow(k.url)
  const aiaHtml = await aia.res.text()
  const aiaForm = formOf(aiaHtml)
  facts.addOtpAction = {
    status: aia.res.status,
    landedOn: new URL(aia.url).pathname.replace(/^.*\/realms\/platform/, ''),
    formFields: aiaForm ? [...aiaForm.fields.keys()].filter((n) => !/^(session_code|execution|client_data|tab_id)$/.test(n)) : [],
    showsTotpEnrolment: Boolean(aiaForm?.fields.has('totpSecret')),
    asksForPasswordOrOtp: Boolean(aiaForm?.fields.has('otp') || aiaForm?.fields.has('password')),
  }

  // 4. reset credentials: the flow's executions and how each is required
  const flows = await transport('GET', '/admin/realms/platform/authentication/flows')
  const resetFlow = flows.find((f) => f.id === realm.resetCredentialsFlow) ?? flows.find((f) => /reset credentials/i.test(f.alias))
  if (!resetFlow) throw new Error('reset-credentials: the realm has no such flow')
  const execs = await transport('GET', `/admin/realms/platform/authentication/flows/${encodeURIComponent(resetFlow.alias)}/executions`)
  facts.resetCredentials = {
    flow: resetFlow.alias,
    executions: execs.map((e) => ({ level: e.level, name: e.displayName ?? e.providerId, requirement: e.requirement })),
  }
  // 5. the "forgot password" path:
  //    is it offered on the sign-in page, and does the endpoint answer when asked for directly?
  {
    const c = new Browser(new Map())
    const entry = await c.follow(authorizeUrl({}).url)
    const html = await entry.res.text()
    const f = formOf(html)
    if (!f) throw new Error('forgot-password probe: the sign-in page has no form')
    const link = /href="([^"]*login-actions\/reset-credentials[^"]*)"/.exec(html)?.[1]?.replaceAll('&amp;', '&')
    const direct = new URL(f.action, entry.url)
    direct.pathname = direct.pathname.replace(/\/authenticate$/, '/reset-credentials')
    for (const k of ['session_code', 'execution']) direct.searchParams.delete(k)
    const target = link ? new URL(link, entry.url).toString() : direct.toString()
    const reset = await c.follow(target)
    const resetHtml = await reset.res.text()
    const rf = formOf(resetHtml)
    facts.forgotPassword = {
      linkOnSignInPage: Boolean(link),
      endpointStatus: reset.res.status,
      endpointShowsUsernameForm: Boolean(rf?.fields.has('username')),
      endpointSaysRefused: /not allowed|forbidden|expired|invalid|error/i.test(resetHtml.replace(/<[^>]+>/g, ' ').slice(0, 4000)),
    }
  }
  console.log(JSON.stringify(facts, null, 2))
}

main().catch((err) => {
  console.error(`[kc-ops-factor-probe] FAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
