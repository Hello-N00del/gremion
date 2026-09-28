#!/usr/bin/env node
// TASK-015 (L3-11, R-E5a root fix, D R21-22): every customer realm sends as
// ITS OWN principal, and no realm shares one with another or with the vendor.
//
//   node ops/vendor-mail/check-principals.mjs                 # verify: the fixtures
//   node ops/vendor-mail/check-principals.mjs --host [--no-allowances] [--dir D]
//
// Inputs are the shape `gremion-vendor-mail collect` writes (principals.json:
// names/emails/roles; realms.json: every realm's smtpServer user/from/host),
// from __fixtures__/principals/ in verify mode, or /run/gremion/collect/ on a
// host (TASK-038 runs --host --no-allowances).
//
// FAILS on
//   * two customer realms sharing one SMTP user;
//   * a customer realm sending as a vendor principal (system@, alerts@,
//     roles@ -- allowances.json principals.vendorPrincipals), and a vendor
//     realm (master, platform -- principals.vendorRealms, structural, kept
//     under --no-allowances) sending as anything but a vendor principal;
//   * a realm whose SMTP user is no principal at all, or whose From is not its
//     user (must-match-sender refuses that envelope with 501 5.5.4) -- this
//     holds for the transitional platform@ realms too: realm-doc.ts stamps
//     them with From no-reply@, which the pinned build refuses (TASK-043);
//   * a realm that sends (a host or a From) with no SMTP user, a customer
//     realm on a principal that is neither kc-* nor the transitional
//     platform@, and -- on a host -- the vendor realm master with no sender;
//   * an orphan kc-* principal no realm uses (a credential nobody should hold);
//   * a customer realm on platform@, unless the transitional allowance holds
//     (principals.transitional; dropped by --no-allowances).
// UNPARSEABLE (exit 2): an input that is not an array, an {"error":...} body,
// and -- on a host -- zero principals or zero realms: a live Stalwart always
// has the vendor principals and a live Keycloak always has `master`.
//
// EXIT: 0 separate - 1 a shared / misassigned principal - 2 unparseable.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAllowances } from './lib/allowances.mjs'

export const FIXTURE_DIR = path.join(import.meta.dirname, '__fixtures__', 'principals')
const KC_RE = /^kc-[a-z][a-z0-9_]{2,39}@/

const local = (addr) => String(addr).split('@')[0].toLowerCase()

export function principalViolations({ principals, realms }, allowances, { useAllowances = true, host = false } = {}) {
  const hostMode = host
  for (const [label, v] of [['principals', principals], ['realms', realms]]) {
    if (!Array.isArray(v)) return { unparseable: `${label} is not an array${v && typeof v === 'object' && 'error' in v ? ` (API error: ${v.error})` : ''}`, violations: [] }
  }
  if (host && principals.length === 0) return { unparseable: 'zero principals read from Stalwart -- a live server always has the vendor principals', violations: [] }
  if (host && realms.length === 0) return { unparseable: 'zero realms read from Keycloak -- a live Keycloak always has master', violations: [] }
  const vendorRealms = new Set(Object.keys(allowances.principals.vendorRealms))
  const vendorLocals = new Set(allowances.principals.vendorPrincipals)
  const transitional = useAllowances ? new Set(allowances.principals.transitional.map((t) => t.principal)) : new Set()
  const names = new Set(principals.map((p) => String(p?.name ?? '').toLowerCase()).filter(Boolean))
  const out = []
  const usedBy = new Map()
  for (const r of realms) {
    const realm = r?.realm
    const user = r?.smtp?.user ? String(r.smtp.user).toLowerCase() : ''
    const from = r?.smtp?.from ? String(r.smtp.from).toLowerCase() : ''
    const host = r?.smtp?.host ? String(r.smtp.host).toLowerCase() : ''
    if (!realm) return { unparseable: 'a realm entry has no name', violations: [] }
    if (!user) {
      // A realm that sends (a host or a From) without authenticating is an
      // unauthenticated submission or a third-party relay -- never one of
      // this server's principals. A realm with no sender at all sends nothing,
      // except the vendor's own realm, which must: realm-smtp sets it.
      if (host || from) out.push(`realm ${realm}: sends (host ${host || '<none>'}, From ${from || '<none>'}) without an SMTP user`)
      else if (realm === 'master' && hostMode) out.push('vendor realm master has no SMTP user: run gremion-vendor-mail realm-smtp')
      continue
    }
    if (!names.has(user)) out.push(`realm ${realm}: SMTP user ${user} is no principal on the vendor's Stalwart`)
    if (from !== user) out.push(`realm ${realm}: From ${from || '<none>'} is not its SMTP user ${user} (must-match-sender refuses it)`)
    if (vendorRealms.has(realm)) {
      if (!vendorLocals.has(local(user))) out.push(`vendor realm ${realm} sends as ${user}, not as a vendor principal`)
      continue
    }
    if (vendorLocals.has(local(user))) out.push(`customer realm ${realm} shares the vendor's own principal ${user}`)
    else if (local(user) === 'platform') {
      if (!transitional.has('platform')) out.push(`customer realm ${realm} sends as the transitional platform@ principal${useAllowances ? '' : ' (--no-allowances)'}`)
    } else if (!KC_RE.test(user)) out.push(`customer realm ${realm} sends as ${user}, not as a kc-<tenant token>@ principal`)
    if (!usedBy.has(user)) usedBy.set(user, [])
    usedBy.get(user).push(realm)
  }
  for (const [user, rs] of usedBy) {
    if (rs.length > 1 && !(local(user) === 'platform' && transitional.has('platform'))) out.push(`customer realms ${rs.join(', ')} share the principal ${user}`)
  }
  for (const n of names) {
    if (KC_RE.test(n) && !usedBy.has(n)) out.push(`orphan principal ${n}: no realm sends as it -- revoke it (principals.mjs revoke)`)
  }
  return { unparseable: null, violations: out }
}

export function main(argv = process.argv.slice(2), log = console) {
  let host = false
  let useAllowances = true
  let dir = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host') host = true
    else if (argv[i] === '--no-allowances') useAllowances = false
    else if (argv[i] === '--dir') {
      dir = argv[++i]
      if (!dir) {
        log.error('usage: check-principals.mjs --dir requires a value')
        return 2
      }
    }
    else {
      log.error(`usage: check-principals.mjs [--host [--no-allowances] [--dir D]]: unknown argument ${argv[i]}`)
      return 2
    }
  }
  dir ??= host ? '/run/gremion/collect' : FIXTURE_DIR
  let input, allowances
  try {
    allowances = loadAllowances()
    input = {
      principals: JSON.parse(readFileSync(path.join(dir, 'principals.json'), 'utf8')),
      realms: JSON.parse(readFileSync(path.join(dir, 'realms.json'), 'utf8')),
    }
  } catch (e) {
    log.error(`UNPARSEABLE ${e.code ?? ''} ${e.message}`)
    return 2
  }
  const r = principalViolations(input, allowances, { useAllowances, host })
  if (r.unparseable) {
    log.error(`UNPARSEABLE ${r.unparseable}`)
    return 2
  }
  for (const v of r.violations) log.error(`FAIL ${v}`)
  log.log(`PRINCIPALS: mode=${host ? 'host' : 'verify'} allowances=${useAllowances ? 'on' : 'off'} principals=${input.principals.length} realms=${input.realms.length} violations=${r.violations.length}`)
  return r.violations.length ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
