#!/usr/bin/env node
// panel-session.mjs — the browser half of TASK-043's running proof
// (customer-provision-proof.sh). Node built-ins only, plus @auth/core resolved
// from apps/control-panel for `mint`.
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
// The customer's first administrators (brief section 1 "Admins sign in",
// PRD-IDN-005; phase customer-admins):
//
//   mail-link --mail-file F --from <kc-token@domain> --realm-url <https://host/auth/realms/slug> --link-out F
//     Reads the RAW execute-actions message Keycloak submitted (MIME;
//     quoted-printable or base64; the link in the text and the HTML part),
//     refuses any sender but the customer's own principal and any link not
//     under the customer's own realm URL on its own host (Q16), and writes the
//     link (a bearer credential) to a 0600 file. Prints the sender only.
//
//   activate --link-file F --new-password-file F --totp-secret-out F
//            [--resolve host=base[,host=base]] [--insecure yes]
//     Opens the link as the administrator's browser would: Keycloak's
//     "proceed" page, UPDATE_PASSWORD, CONFIGURE_TOTP (a TOTP computed from the
//     page's secret, kept in a 0600 file), any profile form, until Keycloak's
//     closing page. Fails unless both actions were completed.
//
//   signin --app <https://host> --realm-url <https://host/auth/realms/slug> --user <email>
//          --password-file F --totp-secret-in F --title <PageTitle segment>
//          [--resolve host=base] [--insecure yes]
//     The authorization code flow of gremion-ui: GET / (302 into /auth/login),
//     the login page's own two requests (/auth/csrf, POST /auth/signin/keycloak),
//     the authorization request -- which must go to <realm-url> on the
//     customer's host --, password and OTP at Keycloak, the callback, and the
//     page it lands on: 200 carrying <title><title>... (the dashboard's PageTitle).
//     REHEARSAL form: --authorize-url <url> --stop-host <redirect host> drives
//     only Keycloak's half and checks the code and the iss of the callback.
//
// --resolve maps a public host name onto a local base URL (the edge's loopback
// port): the request goes to the base with Host: <host> and TLS SNI <host>.
// Secrets come from and go to FILES only; nothing secret is printed.
import { createHmac } from 'node:crypto'
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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

/**
 * Keycloak refuses a TOTP code a second time (its reuse check), and the code
 * of CONFIGURE_TOTP is the code of its time step. So a code is sent only in a
 * step no earlier use fell into: the milliseconds to wait (plus 1 s of slack
 * past the boundary), 0 when the last use was in an earlier step or never.
 */
export function msUntilFreshTotpStep(lastUsedMs, now = Date.now(), stepSeconds = 30) {
  if (lastUsedMs === null || lastUsedMs === undefined) return 0
  const step = stepSeconds * 1000
  if (Math.floor(lastUsedMs / step) !== Math.floor(now / step)) return 0
  return (Math.floor(now / step) + 1) * step - now + 1000
}

// ── the raw message Keycloak submitted ─────────────────────────────────────
/** Quoted-printable (RFC 2045 6.7): soft breaks joined, =XX as bytes, then UTF-8. */
export function decodeQuotedPrintable(s) {
  const bytes = s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  return Buffer.from(bytes, 'latin1').toString('utf8')
}

/** Headers (unfolded, names lower-cased, first occurrence kept) and body. */
function splitMessage(raw) {
  const m = /\r?\n\r?\n/.exec(raw)
  const head = m ? raw.slice(0, m.index) : raw
  const body = m ? raw.slice(m.index + m[0].length) : ''
  const headers = new Map()
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const name = line.slice(0, i).trim().toLowerCase()
    if (!headers.has(name)) headers.set(name, line.slice(i + 1).trim())
  }
  return { headers, body }
}

/** The address of the From header, lower-cased; null when there is none. */
export function mailFromAddress(raw) {
  const from = splitMessage(raw).headers.get('from')
  if (!from) return null
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(from) ?? /([^\s<>"]+@[^\s<>"]+)/.exec(from)
  return m ? m[1].toLowerCase() : null
}

/** Every decoded text leaf of a MIME message (recursive over multipart). */
function mimeTexts(raw) {
  const { headers, body } = splitMessage(raw)
  const ctype = headers.get('content-type') ?? 'text/plain'
  if (/^multipart\//i.test(ctype)) {
    const b = /boundary="([^"]+)"/i.exec(ctype)?.[1] ?? /boundary=([^;\s]+)/i.exec(ctype)?.[1]
    if (!b) return []
    const parts = []
    let cur = null
    for (const line of body.split(/\r?\n/)) {
      if (line === `--${b}` || line === `--${b}--`) {
        if (cur !== null) parts.push(cur.join('\r\n'))
        cur = line === `--${b}` ? [] : null
        continue
      }
      if (cur !== null) cur.push(line)
    }
    return parts.flatMap((p) => mimeTexts(p))
  }
  const cte = (headers.get('content-transfer-encoding') ?? '7bit').toLowerCase()
  if (cte === 'base64') return [Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')]
  if (cte === 'quoted-printable') return [decodeQuotedPrintable(body)]
  return [Buffer.from(body, 'latin1').toString('utf8')]
}

const decodeHtml = (s) => s.replaceAll('&amp;', '&').replaceAll('&#61;', '=').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>')

/**
 * The one execute-actions link of a Keycloak message, bound to its sender and
 * to the customer's realm URL on the customer's own host. Throws otherwise.
 */
export function actionLinkFromMail(raw, { from, realmUrl }) {
  const sender = mailFromAddress(raw)
  if (sender !== from.toLowerCase()) throw new Error(`the message has sender ${sender ?? '<none>'}, want ${from}`)
  const prefix = `${realmUrl.replace(/\/$/, '')}/login-actions/action-token?`
  const links = new Set()
  for (const text of mimeTexts(raw)) {
    for (const m of decodeHtml(text).matchAll(/https?:\/\/[^\s"'<>]+/g)) {
      const url = m[0].replace(/[.,;)]+$/, '')
      if (url.startsWith(prefix)) links.add(url)
    }
  }
  if (links.size === 0) throw new Error(`the message carries no execute-actions link under ${prefix}`)
  if (links.size > 1) throw new Error(`the message carries ${links.size} different execute-actions links`)
  return [...links][0]
}

// ── HTTP ───────────────────────────────────────────────────────────────────
/** One HTTP(S) exchange, no redirect following; the body is read eagerly. */
function raw(url, method, headers, body, tls = {}) {
  const u = new URL(url)
  const lib = u.protocol === 'https:' ? https : http
  const opts = { method, headers: body ? { ...headers, 'content-length': Buffer.byteLength(body) } : headers, timeout: 30_000 }
  if (u.protocol === 'https:') {
    if (tls.servername) opts.servername = tls.servername
    if (tls.insecure) opts.rejectUnauthorized = false
  }
  return new Promise((resolve, reject) => {
    const req = lib.request(u, opts, (res) => {
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

// ── where Keycloak ends and the application begins ──────────────────────────
/**
 * Keycloak's own paths (KC_HTTP_RELATIVE_PATH=/auth). Q16 puts a customer's
 * realm on the customer's OWN host, so the host alone never says "back on the
 * application": only a path outside these does (review r4 HIGH).
 */
export const isKeycloakPath = (pathname) => /^\/auth\/(realms|resources)\//.test(pathname)

/** True once `url` is an APPLICATION page of `host` (not one of Keycloak's). */
export function onAppPage(host, url) {
  const u = new URL(url)
  return u.hostname === host && !isKeycloakPath(u.pathname)
}

// ── a per-host cookie jar and a client that maps public hosts to local bases ──
export class Browser {
  /** @param {Map<string,string>} resolve host name -> local base URL */
  constructor(resolve = new Map(), { insecure = false, stopHosts = [] } = {}) {
    this.resolve = resolve
    this.insecure = insecure
    this.stopHosts = new Set(stopHosts)
    this.jars = new Map() // host -> Map(name -> value)
    this.trace = []
  }
  jar(host) {
    if (!this.jars.has(host)) this.jars.set(host, new Map())
    return this.jars.get(host)
  }
  target(url) {
    const u = new URL(url)
    const base = this.resolve.get(u.hostname)
    if (base) {
      const mapped = new URL(u.pathname + u.search, base)
      return { fetchUrl: mapped.toString(), hostHeader: u.host, servername: u.hostname, jarKey: u.hostname }
    }
    return { fetchUrl: u.toString(), hostHeader: null, servername: null, jarKey: u.hostname }
  }
  async request(url, init = {}) {
    const t = this.target(url)
    const headers = { ...init.headers }
    // fetch() rewrites Host from the URL; node:http sends the one given.
    if (t.hostHeader) headers.host = t.hostHeader
    const jar = this.jar(t.jarKey)
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
    const res = await raw(t.fetchUrl, init.method ?? 'GET', headers, init.body ? String(init.body) : null, { servername: t.servername, insecure: this.insecure })
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
  /** Follows redirects (GET), resolving relative Locations against the PUBLIC
   *  url; stops BEFORE requesting an application page of a --stop-host (the
   *  rehearsal's callback) -- never on Keycloak's own redirects on that host. */
  async follow(url, init = {}) {
    let res = await this.request(url, init)
    let current = url
    for (let hops = 0; hops < 15 && res.status >= 300 && res.status < 400; hops++) {
      const loc = res.headers.get('location')
      if (!loc) break
      current = new URL(loc, current).toString()
      if ([...this.stopHosts].some((h) => onAppPage(h, current))) return { res, url: current, stopped: true }
      res = await this.request(current)
    }
    return { res, url: current, stopped: false }
  }
}

function browserFrom(o) {
  const map = new Map()
  for (const pair of (o.resolve ?? '').split(',').filter(Boolean)) {
    const i = pair.indexOf('=')
    if (i <= 0) throw new Error(`--resolve wants host=base, got ${pair}`)
    map.set(pair.slice(0, i), pair.slice(i + 1))
  }
  return new Browser(map, { insecure: o.insecure === 'yes', stopHosts: o['stop-host'] ? [o['stop-host']] : [] })
}

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
const visibleText = (html) => decodeHtml(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

/**
 * Drives Keycloak's pages as a browser does until `until(url)` holds (back on
 * an application host) or a page without a form ends the run (Keycloak's
 * closing info page). Forms: sign-in (username/password), UPDATE_PASSWORD,
 * CONFIGURE_TOTP (secret kept at once), OTP, the profile (VERIFY_PROFILE);
 * a form-less page with a login-actions link ("proceed") is followed once.
 */
async function drive(b, page, o) {
  const kinds = []
  let lastKind = null
  let totpSecret = o.totpSecret ?? null
  let usedAt = o.totpUsedAt ?? null
  for (let round = 0; round < 12; round++) {
    if (o.until(page.url)) return { page, kinds, totpSecret, final: false, html: null }
    const loc = page.url
    const html = await page.res.text()
    // Keycloak's own error line, if the previous submission was refused.
    const feedback = decodeHtml(
      (/id="input-error[^"]*"[^>]*>\s*([^<]+)/.exec(html) ?? /kc-feedback-text">\s*([^<]+)/.exec(html) ?? /class="[^"]*alert-error[^"]*"[\s\S]*?<span[^>]*>\s*([^<]+)/.exec(html) ?? [])[1] ?? '',
    ).trim()
    if (o.debugOut) writePrivate(o.debugOut, html)
    const f = formOf(html)
    if (!f) {
      const proceed = /<a\b[^>]*\bhref="([^"]*\/login-actions\/[^"]*)"/i.exec(html)
      if (proceed && !kinds.includes('proceed')) {
        kinds.push('proceed')
        process.stderr.write('[panel-session] proceed\n')
        page = await b.follow(new URL(decodeHtml(proceed[1]), loc).toString())
        continue
      }
      return { page, kinds, totpSecret, final: true, html }
    }
    const body = new URLSearchParams()
    let kind
    if (f.fields.has('totpSecret')) {
      kind = 'configure-totp'
      totpSecret = f.fields.get('totpSecret')
      // Kept at once: a later failure must not lose the enrolled secret.
      if (o.totpSecretOut) writePrivate(o.totpSecretOut, `${totpSecret}\n`)
      body.set('totpSecret', totpSecret)
      body.set('totp', totp(Buffer.from(totpSecret, 'utf8')))
      usedAt = Date.now()
      body.set('userLabel', 'proof')
      if (f.fields.has('mode')) body.set('mode', f.fields.get('mode'))
    } else if (f.fields.has('password-new')) {
      kind = 'update-password'
      if (!o.newPassword) throw new Error('an UPDATE_PASSWORD form where no new password was supplied')
      body.set('password-new', o.newPassword)
      body.set('password-confirm', o.newPassword)
    } else if (f.fields.has('otp')) {
      kind = 'otp'
      if (!totpSecret) throw new Error('an OTP form before the TOTP secret was configured')
      // A code already used (CONFIGURE_TOTP, or a refused try) is refused: wait for the next step.
      const wait = msUntilFreshTotpStep(usedAt)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      body.set('otp', totp(Buffer.from(totpSecret, 'utf8')))
      usedAt = Date.now()
      if (f.fields.has('selectedCredentialId')) body.set('selectedCredentialId', f.fields.get('selectedCredentialId'))
    } else if (f.fields.has('firstName') || f.fields.has('lastName')) {
      // VERIFY_PROFILE: Keycloak's default user profile asks for the names at first sign-in.
      kind = 'profile'
      for (const [k, v] of f.fields) body.set(k, v)
      body.set('firstName', f.fields.get('firstName') || 'Proof')
      body.set('lastName', f.fields.get('lastName') || (o.lastName ?? 'Operator'))
      if (f.fields.has('email')) body.set('email', f.fields.get('email') || o.user)
    } else if (f.fields.has('username') || f.fields.has('password')) {
      kind = 'password'
      if (!o.password) throw new Error('a sign-in form appeared where none was expected')
      body.set('username', o.user)
      body.set('password', o.password)
      if (f.fields.has('credentialId')) body.set('credentialId', f.fields.get('credentialId'))
    } else {
      throw new Error(`an unknown form on ${new URL(loc).pathname}: ${[...f.fields.keys()].join(',')}`)
    }
    if (kind === lastKind && kind !== 'otp') throw new Error(`the ${kind} form came back: ${feedback || 'no message'}`)
    lastKind = kind
    kinds.push(kind)
    const action = new URL(f.action, loc).toString()
    process.stderr.write(`[panel-session] ${kind}${feedback ? ` (after: ${feedback})` : ''}\n`)
    page = await b.follow(action, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
  }
  throw new Error('more than 12 Keycloak pages without an end')
}

/** The TOTP secret file's content and when it was written (its enrolment). */
function totpIn(file) {
  if (!file) return { secret: null, usedAt: null }
  return { secret: readSecret(file), usedAt: statSync(file).mtimeMs }
}

async function login(o) {
  const base = need(o, 'base')
  const host = need(o, 'host')
  const user = need(o, 'user')
  const temp = readSecret(need(o, 'temp-password-file'))
  const fresh = readSecret(need(o, 'new-password-file'))
  const b = new Browser(new Map([[host, base]]))
  const panel = `https://${host}`

  const res = await b.request(`${panel}/`)
  if (res.status !== 302) throw new Error(`anonymous GET / answered ${res.status}, not 302`)
  const authUrl = new URL(res.headers.get('location'))
  if (authUrl.searchParams.get('acr_values') !== 'loa2') throw new Error('the authorization request carries no acr_values=loa2')
  const t = totpIn(o['totp-secret-in'])
  const r = await drive(b, await b.follow(authUrl.toString()), {
    user,
    // --password-file: an operator whose temporary password was already changed.
    password: o['password-file'] ? readSecret(o['password-file']) : temp,
    newPassword: fresh,
    totpSecret: t.secret,
    totpUsedAt: t.usedAt,
    totpSecretOut: o['totp-secret-out'],
    debugOut: o['debug-out'],
    until: (u) => onAppPage(host, u),
  })
  if (r.final) throw new Error(`the sign-in never returned to the panel (last: ${new URL(r.page.url).pathname}: ${visibleText(r.html).slice(0, 200)})`)
  const status = r.page.res.status
  const cookies = b.jar(host)
  const sessionName = [...cookies.keys()].find((k) => /authjs\.session-token/.test(k))
  if (!sessionName) throw new Error(`the panel set no session cookie (status ${status}; trace: ${b.trace.join(' | ')})`)
  writePrivate(need(o, 'cookie-out'), `Cookie: ${[...cookies].map(([k, v]) => `${k}=${v}`).join('; ')}\n`)
  console.log(JSON.stringify({ status, path: new URL(r.page.url).pathname, sessionCookie: sessionName, trace: b.trace }))
  if (status !== 200) process.exitCode = 1
}

async function mailLink(o) {
  const rawMail = readFileSync(need(o, 'mail-file'), 'latin1')
  const from = need(o, 'from')
  const realmUrl = need(o, 'realm-url')
  const link = actionLinkFromMail(rawMail, { from, realmUrl })
  writePrivate(need(o, 'link-out'), `${link}\n`)
  console.log(JSON.stringify({ from: mailFromAddress(rawMail), realm: realmUrl, link: `${new URL(link).origin}${new URL(link).pathname}` }))
}

async function activate(o) {
  const link = readSecret(need(o, 'link-file'))
  const b = browserFrom(o)
  const r = await drive(b, await b.follow(link), {
    user: o.user,
    password: null,
    newPassword: readSecret(need(o, 'new-password-file')),
    totpSecretOut: need(o, 'totp-secret-out'),
    debugOut: o['debug-out'],
    lastName: 'Admin',
    until: () => false,
  })
  const done = r.kinds.includes('update-password') && r.kinds.includes('configure-totp')
  console.log(JSON.stringify({ kinds: r.kinds, status: r.page.res.status, page: visibleText(r.html ?? '').slice(0, 160), trace: b.trace }))
  if (!done || r.page.res.status !== 200) process.exitCode = 1
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function signin(o) {
  const app = new URL(need(o, 'app'))
  const realmUrl = need(o, 'realm-url').replace(/\/$/, '')
  const user = need(o, 'user')
  const password = readSecret(need(o, 'password-file'))
  const t = totpIn(need(o, 'totp-secret-in'))
  // the gremion-ui form proves the dashboard: its PageTitle is required up front,
  // before any request (review r4 HIGH: the proof never passed it)
  const titleSegment = o['authorize-url'] ? null : need(o, 'title')
  const b = browserFrom(o)
  let authorize
  if (o['authorize-url']) {
    authorize = o['authorize-url'] // REHEARSAL: Keycloak's half only
  } else {
    // gremion-ui: an anonymous GET / goes into its sign-in page ...
    const first = await b.request(`${app.origin}/`)
    const into = first.headers.get('location')
    if (![302, 303, 307].includes(first.status) || !into || !/^\/auth\/login$/.test(new URL(into, app.origin).pathname)) {
      throw new Error(`anonymous GET / answered ${first.status} ${into ?? ''}, not a redirect into /auth/login`)
    }
    // ... whose script calls Auth.js: the CSRF token, then the sign-in POST. gremion-ui runs Auth.js
    // with its own CSRF check disabled (csrfOriginGuard checks Origin instead); Auth.js then serves no
    // /auth/csrf at all (404), and the POST carries no token, only the Origin every browser sends (#50).
    const csrf = await b.request(`${app.origin}/auth/csrf`)
    const form = { callbackUrl: `${app.origin}/` }
    if (csrf.status !== 404) {
      const text = await csrf.text()
      let token
      try {
        token = JSON.parse(text).csrfToken
      } catch {
        throw new Error(`GET /auth/csrf answered ${csrf.status} with a non-JSON body: ${text.slice(0, 80)}`)
      }
      if (!token) throw new Error(`GET /auth/csrf answered ${csrf.status} with no csrfToken`)
      form.csrfToken = token
    }
    const post = await b.request(`${app.origin}/auth/signin/keycloak`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: app.origin },
      body: new URLSearchParams(form),
    })
    const loc = post.headers.get('location')
    if (post.status !== 302 || !loc) throw new Error(`POST /auth/signin/keycloak answered ${post.status}, not 302`)
    authorize = new URL(loc, app.origin).toString()
  }
  // Q16: the authorization request goes to the customer's realm ON ITS HOST.
  const az = new URL(authorize)
  if (`${az.origin}${az.pathname}` !== `${realmUrl}/protocol/openid-connect/auth`) {
    throw new Error(`the authorization request goes to ${az.origin}${az.pathname}, not ${realmUrl}/protocol/openid-connect/auth`)
  }
  const r = await drive(b, await b.follow(authorize), {
    user,
    password,
    totpSecret: t.secret,
    totpUsedAt: t.usedAt,
    debugOut: o['debug-out'],
    lastName: 'Admin',
    // Q16: Keycloak answers on the app's own host, so only an application
    // path of that host ends the drive
    until: (u) => onAppPage(app.hostname, u),
  })
  if (r.final) throw new Error(`the sign-in stopped on a Keycloak page: ${visibleText(r.html).slice(0, 200)}`)
  const end = new URL(r.page.url)
  if (o['authorize-url']) {
    const code = end.searchParams.get('code')
    const iss = end.searchParams.get('iss')
    console.log(JSON.stringify({ callback: `${end.origin}${end.pathname}`, code: Boolean(code), iss, kinds: r.kinds }))
    if (!code || iss !== realmUrl) process.exitCode = 1
    return
  }
  const html = await r.page.res.text()
  const title = new RegExp(`<title>${escapeRe(titleSegment)}\\b`).test(html)
  console.log(JSON.stringify({ status: r.page.res.status, path: end.pathname, authorize: `${az.origin}${az.pathname}`, kinds: r.kinds, title, trace: b.trace }))
  if (r.page.res.status !== 200 || !title) process.exitCode = 1
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
// it (review C LOW, r2); the verb table is own-property only.
const VERBS = { login, mint, 'mail-link': mailLink, activate, signin }
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
const o = isMain ? args() : null
const run = o && Object.hasOwn(VERBS, o.verb) ? VERBS[o.verb] : null
if (isMain && !run) {
  console.error('usage: panel-session.mjs login|mint|mail-link|activate|signin --...')
  process.exit(2)
}
if (run) run(o).catch((err) => {
  console.error(`[panel-session] FAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
