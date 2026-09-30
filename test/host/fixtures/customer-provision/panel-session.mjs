#!/usr/bin/env node
// panel-session.mjs — the browser half of TASK-043's panel proof
// (customer-provision-proof.sh, phases panel-login / panel-gate). Node
// built-ins only, plus @auth/core resolved from apps/control-panel for `mint`.
//
//   login  --base <loopback base> --host <PANEL_HOST> --user <email>
//          --temp-password-file F --new-password-file F --cookie-out F [--totp-secret-out F]
//     A REAL sign-in of an operator the proof created with `gremion-tenant
//     operator add --no-mail`: GET / on the panel (302 to the ops realm), the
//     Keycloak login form with the temporary password, the required actions
//     (UPDATE_PASSWORD, CONFIGURE_TOTP with a TOTP computed from the page's
//     secret), any OTP form, then the panel's Auth.js callback. Writes the
//     panel's cookies as ONE header line "Cookie: ..." (0600) and prints the
//     acr and final status it saw. Requests to https://<PANEL_HOST> go to
//     <base> with Host: <PANEL_HOST> (the loopback port of the standalone
//     panel, as the edge would forward them).
//
//   mint   --secret-file F --cookie-name N --iss I --acr A --uid U [--roles r,s] [--auth-at S] --cookie-out F
//     An Auth.js session cookie signed with the panel's own AUTH secret, for
//     the gate's cases a real sign-in cannot produce on demand (an ops session
//     at loa1; a session whose iss is a customer realm). The panel decodes it
//     exactly as it decodes its own.
//
// Secrets come from and go to FILES only; nothing secret is printed.
import { createHmac } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..', '..')

function args() {
  const [verb, ...rest] = process.argv.slice(2)
  const o = { verb }
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--')) throw new Error(`unexpected argument ${rest[i]}`)
    // a flag without its value is an error, never a silent undefined (review C LOW, r2)
    if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) throw new Error(`${rest[i]} requires a value`)
    o[rest[i].slice(2)] = rest[i + 1]
  }
  return o
}
const need = (o, k) => {
  if (!o[k]) throw new Error(`--${k} is required`)
  return o[k]
}
const readSecret = (f) => readFileSync(f, 'utf8').trim()
function writePrivate(f, text) {
  writeFileSync(f, text, { mode: 0o600 })
  try {
    chmodSync(f, 0o600)
  } catch {
    /* a Windows file system keeps its ACL */
  }
}

// ── RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s) ──────────────────────────────
export function totp(key, now = Date.now(), step = 30, digits = 6) {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / step)))
  const h = createHmac('sha1', key).update(counter).digest()
  const off = h[h.length - 1] & 0xf
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(bin % 10 ** digits).padStart(digits, '0')
}

/** One HTTP(S) exchange, no redirect following; the body is read eagerly. */
function raw(url, method, headers, body) {
  const u = new URL(url)
  const lib = u.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method, headers: body ? { ...headers, 'content-length': Buffer.byteLength(body) } : headers, timeout: 30_000 }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        const sc = res.headers['set-cookie'] ?? []
        resolve({
          status: res.statusCode ?? 0,
          setCookies: Array.isArray(sc) ? sc : [sc],
          headers: { get: (n) => { const v = res.headers[n.toLowerCase()]; return Array.isArray(v) ? v.join(', ') : (v ?? null) } },
          text: async () => text,
        })
      })
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error(`timeout on ${method} ${u.pathname}`)))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

// ── a two-origin cookie jar and a client that maps the panel's public host ──
class Browser {
  constructor(base, host) {
    this.base = new URL(base)
    this.host = host
    this.jars = new Map() // host -> Map(name -> value)
    this.trace = []
  }
  jar(host) {
    if (!this.jars.has(host)) this.jars.set(host, new Map())
    return this.jars.get(host)
  }
  target(url) {
    const u = new URL(url)
    if (u.hostname === this.host) {
      const mapped = new URL(u.pathname + u.search, this.base)
      return { fetchUrl: mapped.toString(), hostHeader: this.host, jarKey: this.host }
    }
    return { fetchUrl: u.toString(), hostHeader: null, jarKey: u.host }
  }
  async request(url, init = {}) {
    const t = this.target(url)
    const headers = { ...init.headers }
    // fetch() rewrites Host from the URL; node:http sends the one given.
    if (t.hostHeader) headers.host = t.hostHeader
    const jar = this.jar(t.jarKey)
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
    const res = await raw(t.fetchUrl, init.method ?? 'GET', headers, init.body ? String(init.body) : null)
    for (const sc of res.setCookies) {
      const [pair, ...attrs] = sc.split(';')
      const eq = pair.indexOf('=')
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a) || /^\s*expires=Thu, 01 Jan 1970/i.test(a))
      if (expired || value === '') jar.delete(name)
      else jar.set(name, value)
    }
    this.trace.push(`${init.method ?? 'GET'} ${new URL(url).host}${new URL(url).pathname} -> ${res.status}`)
    return res
  }
  /** Follows redirects (GET), resolving relative Locations against the PUBLIC url. */
  async follow(url, init = {}) {
    let res = await this.request(url, init)
    let current = url
    for (let hops = 0; hops < 15 && res.status >= 300 && res.status < 400; hops++) {
      const loc = res.headers.get('location')
      if (!loc) break
      current = new URL(loc, current).toString()
      res = await this.request(current)
    }
    return { res, url: current }
  }
}

const decodeHtml = (s) => s.replaceAll('&amp;', '&').replaceAll('&#61;', '=').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>')
function formOf(html) {
  const m = /<form[^>]*\baction="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i.exec(html)
  if (!m) return null
  const fields = new Map()
  for (const i of m[2].matchAll(/<input\b[^>]*>/gi)) {
    const name = /\bname="([^"]+)"/.exec(i[0])?.[1]
    if (!name) continue
    fields.set(name, decodeHtml(/\bvalue="([^"]*)"/.exec(i[0])?.[1] ?? ''))
  }
  return { action: decodeHtml(m[1]), fields }
}
async function login(o) {
  const base = need(o, 'base')
  const host = need(o, 'host')
  const user = need(o, 'user')
  const temp = readSecret(need(o, 'temp-password-file'))
  const fresh = readSecret(need(o, 'new-password-file'))
  const b = new Browser(base, host)
  const panel = `https://${host}`

  let res = await b.request(`${panel}/`)
  if (res.status !== 302) throw new Error(`anonymous GET / answered ${res.status}, not 302`)
  const authUrl = new URL(res.headers.get('location'))
  if (authUrl.searchParams.get('acr_values') !== 'loa2') throw new Error('the authorization request carries no acr_values=loa2')
  let page = await b.follow(authUrl.toString())
  let totpSecret = null
  let lastKind = null
  for (let round = 0; round < 8; round++) {
    const loc = page.url
    if (new URL(loc).hostname === host) break
    const html = await page.res.text()
    // Keycloak's own error line, if the previous submission was refused.
    const feedback = decodeHtml(
      (/id="input-error[^"]*"[^>]*>\s*([^<]+)/.exec(html) ?? /kc-feedback-text">\s*([^<]+)/.exec(html) ?? /class="[^"]*alert-error[^"]*"[\s\S]*?<span[^>]*>\s*([^<]+)/.exec(html) ?? [])[1] ?? '',
    ).trim()
    if (o['debug-out']) writePrivate(o['debug-out'], html)
    const f = formOf(html)
    if (!f) throw new Error(`no form on ${new URL(loc).pathname} (status ${page.res.status}): ${html.replace(/\s+/g, ' ').slice(0, 300)}`)
    const body = new URLSearchParams()
    let kind
    if (f.fields.has('totpSecret')) {
      kind = 'configure-totp'
      totpSecret = f.fields.get('totpSecret')
      // Kept at once: a later failure must not lose the enrolled secret.
      if (o['totp-secret-out']) writePrivate(o['totp-secret-out'], `${totpSecret}\n`)
      body.set('totpSecret', totpSecret)
      body.set('totp', totp(Buffer.from(totpSecret, 'utf8')))
      body.set('userLabel', 'proof')
      if (f.fields.has('mode')) body.set('mode', f.fields.get('mode'))
    } else if (f.fields.has('password-new')) {
      kind = 'update-password'
      body.set('password-new', fresh)
      body.set('password-confirm', fresh)
    } else if (f.fields.has('otp')) {
      kind = 'otp'
      // An operator enrolled earlier (a second sign-in): the secret from its file.
      if (!totpSecret && o['totp-secret-in']) totpSecret = readSecret(o['totp-secret-in'])
      if (!totpSecret) throw new Error('an OTP form before the TOTP secret was configured')
      // A code already used for CONFIGURE_TOTP is refused: wait for the next step.
      if (lastKind !== 'password') await new Promise((r) => setTimeout(r, 31_000))
      body.set('otp', totp(Buffer.from(totpSecret, 'utf8')))
    } else if (f.fields.has('firstName') || f.fields.has('lastName')) {
      // VERIFY_PROFILE: Keycloak's default user profile asks for the names at first sign-in.
      kind = 'profile'
      for (const [k, v] of f.fields) body.set(k, v)
      body.set('firstName', f.fields.get('firstName') || 'Proof')
      body.set('lastName', f.fields.get('lastName') || 'Operator')
      if (f.fields.has('email')) body.set('email', f.fields.get('email') || user)
    } else if (f.fields.has('username') || f.fields.has('password')) {
      kind = 'password'
      body.set('username', user)
      // --password-file: an operator whose temporary password was already changed.
      body.set('password', o['password-file'] ? readSecret(o['password-file']) : temp)
      if (f.fields.has('credentialId')) body.set('credentialId', f.fields.get('credentialId'))
    } else {
      throw new Error(`an unknown form on ${new URL(loc).pathname}: ${[...f.fields.keys()].join(',')}`)
    }
    if (kind === lastKind && kind !== 'otp') throw new Error(`the ${kind} form came back: ${feedback || 'no message'}`)
    lastKind = kind
    const action = new URL(f.action, loc).toString()
    process.stderr.write(`[panel-session] ${kind}${feedback ? ` (after: ${feedback})` : ''}\n`)
    page = await b.follow(action, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
  }
  if (new URL(page.url).hostname !== host) throw new Error(`the sign-in never returned to the panel (last: ${new URL(page.url).pathname})`)
  const status = page.res.status
  const cookies = b.jar(host)
  const sessionName = [...cookies.keys()].find((k) => /authjs\.session-token/.test(k))
  if (!sessionName) throw new Error(`the panel set no session cookie (status ${status}; trace: ${b.trace.join(' | ')})`)
  writePrivate(need(o, 'cookie-out'), `Cookie: ${[...cookies].map(([k, v]) => `${k}=${v}`).join('; ')}\n`)
  console.log(JSON.stringify({ status, path: new URL(page.url).pathname, sessionCookie: sessionName, trace: b.trace }))
  if (status !== 200) process.exitCode = 1
}

async function mint(o) {
  const require = createRequire(join(REPO, 'apps', 'control-panel', 'package.json'))
  const { encode } = await import(pathToFileURL(require.resolve('@auth/core/jwt')).href)
  const name = need(o, 'cookie-name')
  const token = {
    sub: need(o, 'uid'),
    opsIss: need(o, 'iss'),
    opsAcr: need(o, 'acr'),
    opsUid: need(o, 'uid'),
    opsEmail: o.email ?? null,
    opsRoles: (o.roles ?? '').split(',').filter(Boolean),
    // the sign-in time the panel's absolute session lifetime counts from
    // (review r2 HIGH); --auth-at <epoch seconds> mints an OLD session
    opsAuthAt: o['auth-at'] === undefined ? Math.floor(Date.now() / 1000) : Number(o['auth-at']),
  }
  if (!Number.isInteger(token.opsAuthAt)) throw new Error('--auth-at must be epoch seconds')
  const value = await encode({ token, secret: readSecret(need(o, 'secret-file')), salt: name, maxAge: 3600 })
  writePrivate(need(o, 'cookie-out'), `Cookie: ${name}=${value}\n`)
  console.log(JSON.stringify({ minted: name, iss: token.opsIss, acr: token.opsAcr }))
}

// The CLI runs only when this file is executed, never when a test imports
// totp() (review C LOW, r2); the verb table is own-property only.
const VERBS = { login, mint }
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
const o = isMain ? args() : null
const run = o && Object.hasOwn(VERBS, o.verb) ? VERBS[o.verb] : null
if (isMain && !run) {
  console.error('usage: panel-session.mjs login|mint --...')
  process.exit(2)
}
if (run) run(o).catch((err) => {
  console.error(`[panel-session] FAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
