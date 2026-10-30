// 081 residual (r33-14 smoke V7): a user WITHOUT a second factor who asks gremion-ui for the
// loa2 step-up is refused by the realm's OTP-or-deny subflow. Keycloak 26.6.1 renders that refusal
// as its own error page (DenyAccessAuthenticator -> createErrorPage, no redirect to the client;
// AuthenticationProcessor.handleBrowserException passes the page through), so the app's callback
// never sees it. The gremion login theme's error page therefore sends a gremion-ui deny to the
// app's own notice, /auth/step-up?error=no-second-factor (same origin: the realm is served under
// the tenant host's /auth/realms). Any other client keeps the plain error page.
// A REAL Keycloak 26.6.1 imports the realm template with the gremion theme mounted. Scratch
// container t081d-kc-*, 127.0.0.1 only, removed by name. Run with the integration config (needs Docker).
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const REALM_FILE = fileURLToPath(new URL('../../../../docker/keycloak/realm-export.base.json', import.meta.url))
const THEME_DIR = fileURLToPath(new URL('../../../../docker/keycloak/themes/gremion', import.meta.url))
const IMAGE = 'quay.io/keycloak/keycloak:26.6.1'
// A per-run name: the file runs from `test:integration` and from the verify part keycloak-stepup, and two
// runs on one Docker host must not tear down each other's Keycloak.
const NAME = `t081d-kc-${String(process.pid)}-${randomBytes(3).toString('hex')}`
// Every container this file creates carries the label, so a run killed before afterAll (CI cancel, Ctrl-C,
// OOM) leaves something a later run can find: the per-run NAME alone never matches again.
const LABEL = 't081d-stepup'
const STALE_MS = 60 * 60 * 1000
const REALM = 't081d'
const NOTICE = '/auth/step-up?error=no-second-factor'
const tmp = mkdtempSync(join(tmpdir(), 't081d-'))
let base = ''

function docker(args: string[], allowFail = false): string {
  const r = spawnSync('docker', args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  if (r.status !== 0 && !allowFail) throw new Error(`docker ${args[0]} (status ${String(r.status)}): ${r.error?.message ?? ''} ${(r.stderr || '').slice(-400)}`)
  return (r.stdout || '').trim()
}

/** Remove labelled containers older than STALE_MS: leftovers of killed runs. A concurrent run's container is young, so it stays. */
function sweepStale(): void {
  const ids = docker(['ps', '-aq', '--filter', `label=${LABEL}`], true).split(/\r?\n/).filter(Boolean)
  if (ids.length === 0) return
  for (const line of docker(['inspect', '-f', '{{.Id}} {{.Created}}', ...ids], true).split(/\r?\n/)) {
    const [id, created] = line.split(' ')
    const at = Date.parse(created ?? '')
    if (id && Number.isFinite(at) && Date.now() - at > STALE_MS) docker(['rm', '-f', '-v', id], true)
  }
}

/** The template with placeholders filled and a password-only user (test copy only; the repo file is untouched). */
function realm() {
  const raw = readFileSync(REALM_FILE, 'utf8')
    .replaceAll('__REALM_NAME__', REALM)
    .replaceAll('__APEX_DOMAIN__', 'localhost')
    .replaceAll('__SSL_REQUIRED__', 'none')
    .replace(/__[A-Z_]*SECRET__|__SMTP_PASSWORD__/g, 'x'.repeat(24))
    .replaceAll('__SMTP_PORT__', '25')
    .replaceAll('__SMTP_FROM__', 't081d@example.org')
    .replaceAll('__SMTP_HOST__', 'localhost')
    .replace(/__SMTP_[A-Z]+__/g, 'false')
  const doc = JSON.parse(raw)
  doc.users.push({
    username: 'nootp', enabled: true, emailVerified: true, email: 'nootp@example.org', firstName: 'No', lastName: 'Otp',
    credentials: [{ type: 'password', value: 'nootp-pass-1234', temporary: false }],
  })
  return doc
}

/** A cookie-keeping, non-following browser: enough for Keycloak's login forms. */
async function browse(url: string, init: { method?: string; body?: URLSearchParams } = {}, jar: Map<string, string>) {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    redirect: 'manual',
    headers: { ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(init.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: init.body,
  })
  for (const sc of res.headers.getSetCookie()) {
    const pair = sc.split(';')[0]!
    const eq = pair.indexOf('=')
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
  return res
}

/** Sign in as the password-only user and ask `clientId` for loa2; returns the response that ends the flow. */
async function stepUpWithoutOtp(clientId: string, redirectUri: string): Promise<{ status: number; location: string | null; html: string }> {
  const jar = new Map<string, string>()
  const verifier = randomBytes(32).toString('base64url')
  let url: string | null = `${base}/realms/${REALM}/protocol/openid-connect/auth?${new URLSearchParams({
    client_id: clientId, response_type: 'code', scope: 'openid', redirect_uri: redirectUri, acr_values: 'loa2', max_age: '300',
    state: randomBytes(8).toString('hex'), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  }).toString()}`
  let res = await browse(url, {}, jar)
  for (let round = 0; round < 6; round++) {
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      if (!new URL(location, url).href.startsWith(base)) return { status: res.status, location, html: '' }
      url = new URL(location, url).href
      res = await browse(url, {}, jar)
      continue
    }
    const html = await res.text()
    const form = /<form[^>]*\baction="([^"]+)"/i.exec(html)
    if (res.status !== 200 || !form || !/name="password"/.test(html)) return { status: res.status, location: null, html }
    url = new URL(form[1]!.replaceAll('&amp;', '&'), url).href
    res = await browse(url, { method: 'POST', body: new URLSearchParams({ username: 'nootp', password: 'nootp-pass-1234' }) }, jar)
  }
  throw new Error('the step-up never ended')
}

beforeAll(async () => {
  const dir = join(tmp, 'import')
  mkdirSync(dir)
  writeFileSync(join(dir, `${REALM}.json`), JSON.stringify(realm()))
  sweepStale()
  docker(['create', '--name', NAME, '--label', LABEL, '-p', '127.0.0.1::8080', '-e', 'KC_BOOTSTRAP_ADMIN_USERNAME=a', '-e', 'KC_BOOTSTRAP_ADMIN_PASSWORD=a', IMAGE, 'start-dev', '--import-realm'])
  docker(['cp', dir, `${NAME}:/opt/keycloak/data/import`])
  docker(['cp', THEME_DIR, `${NAME}:/opt/keycloak/themes/gremion`])
  docker(['start', NAME])
  base = `http://127.0.0.1:${docker(['port', NAME, '8080/tcp']).split('\n')[0]!.split(':').pop()}`
  const deadline = Date.now() + 100_000
  while (Date.now() < deadline) {
    const ok = await fetch(`${base}/realms/${REALM}/.well-known/openid-configuration`).then((r) => r.ok, () => false)
    if (ok) return
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`Keycloak never served realm ${REALM}\n${docker(['logs', '--tail', '25', NAME], true)}`)
}, 150_000)

afterAll(() => {
  if (!process.env.T081D_KEEP) docker(['rm', '-f', '-v', NAME], true)
  rmSync(tmp, { recursive: true, force: true })
})

describe('step-up deny (no second factor) goes back to the app notice', () => {
  it('gremion-ui: the deny page is still a refusal (401, no code) and sends the user to the app notice', async () => {
    const end = await stepUpWithoutOtp('gremion-ui', 'http://localhost:3000/auth/callback/keycloak')
    expect(end.location, 'Keycloak must never hand out a code without the second factor').toBeNull()
    expect(end.status).toBe(401)
    expect(end.html).toContain(`<meta http-equiv="refresh" content="0;url=${NOTICE}">`)
    expect(end.html).toContain(`href="${NOTICE}"`)
  })
  it('another client (account-console) keeps the plain deny page: no redirect into gremion-ui', async () => {
    const end = await stepUpWithoutOtp('account-console', `${base}/realms/${REALM}/account/`)
    expect(end.location).toBeNull()
    expect(end.status).toBe(401)
    expect(end.html).not.toContain(NOTICE)
  })
})
