#!/usr/bin/env node
// TASK-015 (TRD-049, L3-11): one submission principal per customer.
//
//   principals.mjs issue  --tenant <token> [--rotate]
//   principals.mjs revoke --tenant <token>
//   principals.mjs list   [--tenant <token>]
//
// Each customer realm authenticates to the vendor's Stalwart as its OWN
// principal, kc-<tenant token>@<PLATFORM_DOMAIN> (role `user`), so revoking
// one customer never touches another and no customer can authenticate as the
// vendor (system@, alerts@, roles@). TASK-043's provisioning calls this CLI
// through infra/host/bin/gremion-vendor-mail (Q3), never the API directly.
//
// CUSTODY (Q3): the app password is GENERATED here at issue and printed ONCE
// on stdout ("APP-PASSWORD: ..."), for the caller to hand to the realm's
// smtpServer in the same step. It is never written to disk, never on an
// argv, never in git; the only holders afterwards are Stalwart and that
// realm. A lost password is not recovered, it is rotated: re-issuing an
// existing principal is refused unless --rotate, which REPLACES the secret.
//
// THE API ANSWERS 200 TO FAILURES: the verdict is the body ({"data":...} vs
// {"error":...}), exactly as infra/host/mail/provision-roles.sh documents;
// every write is read back. The admin credential comes only from the mail.env
// the launcher mounts read-only; STALWART_ADMIN_URL must be a loopback
// address on port 8086 (the management API is published nowhere else).
//
// EXIT: 0 ok - 1 an API call or read-back failed - 2 usage / precondition.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { envMap } from './lib/env.mjs'

export const TOKEN_RE = /^[a-z][a-z0-9_]{2,39}$/ // SCHEMA 0.1 tenant token
export const APP_NAME = 'gremion-realm'
const LOOPBACK_8086 = /^http:\/\/(127(?:\.\d{1,3}){3}|\[::1\]|localhost):8086$/

export class UsageError extends Error {}
export class ApiError extends Error {}

export const principalName = (token, domain) => `kc-${token}@${domain}`

/** 32 alphanumeric characters from the CSPRNG. */
export function generatePassword(rand = randomBytes) {
  let out = ''
  while (out.length < 32) out += rand(48).toString('base64').replace(/[^A-Za-z0-9]/g, '')
  return out.slice(0, 32)
}

export function parseArgs(argv) {
  const [verb, ...rest] = argv
  if (!['issue', 'revoke', 'list'].includes(verb)) throw new UsageError('usage: principals.mjs issue|revoke|list --tenant <token> [--rotate]')
  const o = { verb, tenant: null, rotate: false, mailEnv: '/run/gremion/env/mail.env' }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--tenant') o.tenant = rest[++i] ?? ''
    else if (a === '--rotate') o.rotate = true
    else if (a === '--mail-env') o.mailEnv = rest[++i]
    else throw new UsageError(`unknown argument: ${a}`)
  }
  if (verb !== 'list' && o.tenant === null) throw new UsageError(`${verb} needs --tenant <token>`)
  if (o.tenant !== null && !TOKEN_RE.test(o.tenant)) throw new UsageError(`tenant token '${o.tenant}' does not match ${TOKEN_RE}`)
  if (o.rotate && verb !== 'issue') throw new UsageError('--rotate belongs to issue')
  return o
}

export function apiFromEnv(env, fetchImpl = globalThis.fetch) {
  const url = env.STALWART_ADMIN_URL
  if (!url || !LOOPBACK_8086.test(url)) throw new UsageError(`STALWART_ADMIN_URL must be http://<loopback>:8086, got ${url ? 'another address' : 'nothing'}`)
  if (!env.STALWART_ADMIN_USER || !env.STALWART_ADMIN_PASSWORD) throw new UsageError('STALWART_ADMIN_USER/STALWART_ADMIN_PASSWORD are unset in mail.env')
  const auth = `Basic ${Buffer.from(`${env.STALWART_ADMIN_USER}:${env.STALWART_ADMIN_PASSWORD}`).toString('base64')}`
  return async function api(method, p, body) {
    let res
    try {
      res = await fetchImpl(`${url}${p}`, {
        method,
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (e) {
      throw new ApiError(`the management API did not answer ${method} ${p}: ${e.cause?.code ?? e.message}`)
    }
    let json
    try {
      json = await res.json()
    } catch {
      throw new ApiError(`${method} ${p}: HTTP ${res.status} with a body that is not JSON`)
    }
    if (res.status !== 200) throw new ApiError(`${method} ${p}: HTTP ${res.status} ${json?.title ?? ''}`.trim())
    return json
  }
}

const hasData = (j) => j !== null && typeof j === 'object' && Object.hasOwn(j, 'data') && !Object.hasOwn(j, 'error')
const isNotFound = (j) => j?.error === 'notFound'

async function getPrincipal(api, name) {
  const j = await api('GET', `/api/principal/${encodeURIComponent(name)}`)
  if (hasData(j)) return j.data
  if (isNotFound(j)) return null
  throw new ApiError(`GET ${name}: ${j?.error ?? 'unrecognised response'}`)
}

async function write(api, method, p, body, what) {
  const j = await api(method, p, body)
  if (!hasData(j)) throw new ApiError(`${what}: ${j?.error ?? 'unrecognised response'}`)
}

export async function issue(api, { token, domain, quota, rotate = false, gen = generatePassword }) {
  const name = principalName(token, domain)
  const dom = await getPrincipal(api, domain)
  if (!dom) throw new ApiError(`the domain ${domain} is not provisioned; run infra/host/mail/provision-roles.sh first`)
  let p = await getPrincipal(api, name)
  if (p && !rotate) throw new UsageError(`${name} already exists; re-issuing replaces its app password -- pass --rotate to do that on purpose`)
  if (!p) {
    await write(api, 'POST', '/api/principal', { type: 'individual', name, emails: [name], roles: ['user'], quota: Number(quota) || 0 }, `creating ${name}`)
    p = await getPrincipal(api, name)
    if (!p) throw new ApiError(`${name} is absent after create`)
  }
  if (!(p.roles ?? []).includes('user')) {
    await write(api, 'PATCH', `/api/principal/${encodeURIComponent(name)}`, [{ action: 'addItem', field: 'roles', value: 'user' }], `granting the login role to ${name}`)
  }
  const password = gen()
  const secret = `$app$${APP_NAME}$${password}`
  // `set`, not `addItem`: a rotation must leave exactly ONE secret, or the old
  // password keeps working next to the new one.
  await write(api, 'PATCH', `/api/principal/${encodeURIComponent(name)}`, [{ action: 'set', field: 'secrets', value: [secret] }], `setting the app password of ${name}`)
  const back = await getPrincipal(api, name)
  const secrets = back?.secrets ?? []
  if (secrets.length !== 1 || secrets[0] !== secret) throw new ApiError(`${name}: read-back shows ${secrets.length} secret(s), not exactly the one just set`)
  if (!(back.roles ?? []).includes('user')) throw new ApiError(`${name}: read-back shows no login role`)
  if (JSON.stringify(back.emails ?? []) !== JSON.stringify([name])) throw new ApiError(`${name}: read-back shows addresses other than its own`)
  return { name, password, rotated: Boolean(rotate) }
}

export async function revoke(api, { token, domain }) {
  const name = principalName(token, domain)
  const p = await getPrincipal(api, name)
  if (!p) return { name, revoked: false }
  await write(api, 'PATCH', `/api/principal/${encodeURIComponent(name)}`, [{ action: 'set', field: 'secrets', value: [] }], `removing the secrets of ${name}`)
  const mid = await getPrincipal(api, name)
  if ((mid?.secrets ?? []).length !== 0) throw new ApiError(`${name}: secrets remain after removal`)
  await write(api, 'DELETE', `/api/principal/${encodeURIComponent(name)}`, undefined, `deleting ${name}`)
  if (await getPrincipal(api, name)) throw new ApiError(`${name} is still present after DELETE`)
  return { name, revoked: true }
}

export async function list(api, { domain, token = null }) {
  const j = await api('GET', '/api/principal?types=individual&limit=0')
  if (!hasData(j) || !Array.isArray(j.data?.items)) throw new ApiError(`listing principals: ${j?.error ?? 'no data.items array'}`)
  const names = j.data.items.map((i) => (typeof i === 'string' ? i : i?.name)).filter((n) => typeof n === 'string')
  const kc = names.filter((n) => /^kc-[a-z][a-z0-9_]{2,39}@/.test(n) && n.endsWith(`@${domain}`)).sort()
  return token ? kc.filter((n) => n === principalName(token, domain)) : kc
}

export async function main(argv = process.argv.slice(2), { log = console, fetchImpl = globalThis.fetch, readFile = readFileSync } = {}) {
  let o, env, api
  try {
    o = parseArgs(argv)
    env = envMap(String(readFile(o.mailEnv, 'utf8')), 'mail.env')
    if (!env.PLATFORM_DOMAIN || env.PLATFORM_DOMAIN.startsWith('CHANGE_ME_')) throw new UsageError('PLATFORM_DOMAIN is unset in mail.env')
    api = apiFromEnv(env, fetchImpl)
  } catch (e) {
    log.error(e instanceof UsageError ? e.message : `cannot read mail.env: ${e.code ?? e.message}`)
    return 2
  }
  try {
    if (o.verb === 'issue') {
      const r = await issue(api, { token: o.tenant, domain: env.PLATFORM_DOMAIN, quota: env.MAIL_ACCOUNT_QUOTA, rotate: o.rotate })
      log.log(`KC-PRINCIPAL: ${r.rotated ? 'rotated' : 'issued'} ${r.name}`)
      // Printed ONCE, on stdout only, for the caller to place in the realm.
      log.log(`APP-PASSWORD: ${r.password}`)
    } else if (o.verb === 'revoke') {
      const r = await revoke(api, { token: o.tenant, domain: env.PLATFORM_DOMAIN })
      log.log(`KC-PRINCIPAL: ${r.revoked ? 'revoked' : 'absent (nothing to revoke)'} ${r.name}`)
    } else {
      const names = await list(api, { domain: env.PLATFORM_DOMAIN, token: o.tenant })
      for (const n of names) log.log(n)
      log.log(`KC-PRINCIPALS: ${names.length}`)
    }
    return 0
  } catch (e) {
    log.error(`FAIL ${e.message}`)
    return e instanceof UsageError ? 2 : 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
