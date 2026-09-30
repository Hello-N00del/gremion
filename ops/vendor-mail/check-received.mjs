#!/usr/bin/env node
// TASK-015 (PRD-REC-006, TRD-252): does a delivered message's header block
// prove it was sent by the vendor's OWN Stalwart, and did it pass SPF, DKIM
// and DMARC at the receiver?
//
//   node ops/vendor-mail/check-received.mjs --file <headers>
//        [--domain D] [--bind-ip IP] [--bind-ip6 IP6]    (default: mail.env)
//        --receiver NAME | --authserv-id ID --receiver-domain D
//        [--receivers F]
//
// It replaces the substring greps of gremion-mail-bringup asserts 6a/6b,
// which passed a relayed message (grep "dkim=pass" is satisfied by
// `dkim=pass header.d=sendgrid.net`; grep "<IP-B>" by the address appearing
// anywhere, the body included). Here:
//   * the header block is UNFOLDED (RFC 5322 2.2.3) and ends at the first
//     empty line: nothing in the body counts;
//   * ONE receiver per run (--receiver, or --authserv-id): Authentication-
//     Results counts only from ITS authserv-id (RFC 8601 section 5), and only
//     the topmost such field;
//   * spf=pass with smtp.mailfrom in <domain>, dkim=pass with header.d (or
//     header.i) = <domain>, dmarc=pass with header.from = <domain>;
//   * the accepting hop is the LOWEST Received whose from-clause carries
//     MAIL_BIND_IP or MAIL_BIND_IP6 as an address literal (an exact token,
//     never a substring), and it must be `by` a host of the receiver; hops
//     above it must be the receiver's too (or address literals, its internal
//     hops); every hop below it must be `by mail.<domain>`;
//   * no third-party mail-API marker anywhere in the header block.
//
// EXIT: 0 proven - 1 not proven (each reason printed) - 2 unreadable/usage.
import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { envMap } from './lib/env.mjs'

export const RECEIVERS_PATH = path.join(import.meta.dirname, 'deliverability', 'receivers.json')

/** Header block -> [{name, value}] in order, unfolded; stops at the first empty line. */
export function unfoldHeaders(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out = []
  for (const line of lines) {
    if (line === '') break
    if (/^[ \t]/.test(line)) {
      if (!out.length) throw new Error('the header block starts with a continuation line')
      out.at(-1).value += line // RFC 5322 2.2.3: unfolding removes the CRLF only
      continue
    }
    const i = line.indexOf(':')
    if (i <= 0) throw new Error(`not a header field: ${line.slice(0, 40)}`)
    out.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1) })
  }
  return out
}

/** Remove RFC 5322 comments (nested parentheses), keeping quoted strings. */
export function stripComments(s) {
  let out = ''
  let depth = 0
  let quoted = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      out += c
      if (c === '\\') out += s[++i] ?? ''
      else if (c === '"') quoted = false
    } else if (c === '"' && depth === 0) {
      quoted = true
      out += c
    } else if (c === '(') depth++
    else if (c === ')' && depth > 0) depth--
    else if (depth === 0) out += c
  }
  return out
}

/** RFC 8601: authserv-id [version] ; resinfo ; resinfo ... */
export function parseAuthResults(value) {
  const parts = stripComments(value).split(';').map((p) => p.trim()).filter(Boolean)
  const authservId = (parts.shift() ?? '').split(/\s+/)[0].toLowerCase()
  const results = parts.map((p) => {
    const tokens = p.match(/[^\s=]+=(?:"[^"]*"|[^\s]+)|\S+/g) ?? []
    const [method, result] = (tokens.shift() ?? '').split('=')
    const props = {}
    for (const t of tokens) {
      const m = /^([^=]+)=(.*)$/.exec(t)
      if (m) props[m[1].toLowerCase()] = m[2].replace(/^"|"$/g, '')
    }
    return { method: (method ?? '').toLowerCase(), result: (result ?? '').toLowerCase(), props }
  })
  return { authservId, results }
}

const domainOf = (v) => String(v ?? '').replace(/^.*@/, '').replace(/[<>]/g, '').toLowerCase()
const inDomain = (v, d) => {
  const x = domainOf(v)
  return x === d || x.endsWith(`.${d}`)
}

/** One canonical spelling per address, so 2001:db8:0::25 equals 2001:db8::25. */
export function normaliseIp(a) {
  const s = String(a).trim().toLowerCase().replace(/^ipv6:/, '')
  if (!s.includes(':')) return s
  try {
    return new URL(`http://[${s}]/`).hostname.slice(1, -1)
  } catch {
    return s
  }
}

const IP_TOKEN = /^(?:\d{1,3}(?:\.\d{1,3}){3}|(?:IPv6:)?[0-9A-Fa-f]*:[0-9A-Fa-f:.]*)$/

/** The address literals of a Received field's from-clause (before ` by `):
 * bracketed ([192.0.2.25], [IPv6:...]) and bare tokens inside its comment
 * ((192.0.2.25), the form some receivers write), each an exact token. */
export function fromClauseAddresses(value) {
  const v = value.replace(/\s+/g, ' ')
  const byAt = v.search(/\sby\s/i)
  const from = /^\s*from\s/i.test(v) ? v.slice(0, byAt < 0 ? v.length : byAt) : ''
  const out = [...from.matchAll(/\[(?:IPv6:)?([0-9A-Fa-f:.]+)\]/g)].map((m) => m[1])
  for (const m of from.matchAll(/\(([^()]*)\)/g)) {
    for (const tok of m[1].split(/[\s,;]+/)) if (IP_TOKEN.test(tok)) out.push(tok)
  }
  return out.map(normaliseIp)
}

const isAddressLiteral = (h) => isIP(String(h ?? '').replace(/^\[|\]$/g, '').replace(/^ipv6:/i, '')) !== 0
const inSuffixes = (host, suffixes) => Boolean(host) && suffixes.some((x) => host === x || host.endsWith(`.${x}`))

export function byClauseHost(value) {
  const m = /\sby\s+([^\s;()]+)/i.exec(value.replace(/\s+/g, ' '))
  return m ? m[1].toLowerCase().replace(/\.$/, '') : null
}

export function checkReceived(text, { domain, bindIps, authservIds, receiverSuffixes = [], espMarkers }) {
  const d = domain.toLowerCase()
  const why = []
  // ONE receiver per run: trusting the union of every known authserv-id is
  // how a sender-written `Authentication-Results: <another provider>; pass`
  // gets counted at a receiver that does not strip that other provider's id.
  if (!authservIds.length || !receiverSuffixes.length) return { unparseable: 'no receiver named (--receiver <name in receivers.json> or --authserv-id <id>)', reasons: [] }
  const suffixes = receiverSuffixes.map((x) => x.toLowerCase().replace(/^\./, ''))
  let fields
  try {
    fields = unfoldHeaders(text)
  } catch (e) {
    return { unparseable: e.message, reasons: [] }
  }
  if (fields.length === 0) return { unparseable: 'no header fields', reasons: [] }
  // Authentication-Results: the topmost field carrying a trusted authserv-id.
  const trusted = new Set(authservIds.map((s) => s.toLowerCase()))
  const ar = fields.filter((f) => f.name.toLowerCase() === 'authentication-results').map((f) => parseAuthResults(f.value))
  const mine = ar.find((r) => trusted.has(r.authservId))
  if (!mine) {
    why.push(`no Authentication-Results from the receiver (${[...trusted].join(', ') || 'no authserv-id given'}); saw ${ar.map((r) => r.authservId || '<none>').join(', ') || 'none'}`)
  } else {
    const pass = (m, ok) => mine.results.some((r) => r.method === m && r.result === 'pass' && ok(r.props))
    if (!pass('spf', (p) => inDomain(p['smtp.mailfrom'] ?? p['smtp.helo'], d))) why.push(`no spf=pass for a mailfrom in ${d}`)
    if (!pass('dkim', (p) => domainOf(p['header.d'] ?? p['header.i']) === d)) why.push(`no dkim=pass with header.d=${d}`)
    if (!pass('dmarc', (p) => domainOf(p['header.from']) === d)) why.push(`no dmarc=pass with header.from=${d}`)
  }
  // Received chain, top (newest) to bottom (oldest).
  const received = fields.filter((f) => f.name.toLowerCase() === 'received').map((f) => f.value)
  const ips = new Set(bindIps.filter(Boolean).map(normaliseIp))
  let accept = -1
  for (let i = received.length - 1; i >= 0; i--) {
    if (fromClauseAddresses(received[i]).some((a) => ips.has(a))) {
      accept = i
      break
    }
  }
  if (accept < 0) why.push(`no Received hop accepted the message from ${[...ips].join(' / ')}`)
  else {
    // The accepting hop is the RECEIVER's; an unlisted smarthost that took the
    // message from IP-B and passed it on would otherwise be read as delivery.
    const acceptedBy = byClauseHost(received[accept])
    if (!inSuffixes(acceptedBy, suffixes)) why.push(`the accepting hop is by ${acceptedBy ?? '<none>'}, not a host of the receiver (${suffixes.join(', ')})`)
    for (let i = 0; i < accept; i++) {
      const by = byClauseHost(received[i])
      if (!inSuffixes(by, suffixes) && !isAddressLiteral(by)) why.push(`a hop above the accepting one is by ${by ?? '<none>'}, not the receiver's (${suffixes.join(', ')}) -- a relay`)
    }
    for (let i = accept + 1; i < received.length; i++) {
      const by = byClauseHost(received[i])
      if (by !== `mail.${d}`) why.push(`a hop below the accepting one is by ${by ?? '<none>'}, not mail.${d}`)
    }
  }
  // Third-party mail-API markers, anywhere in the header block.
  const hosts = espMarkers.hosts.map((h) => h.toLowerCase())
  for (const f of fields) {
    const n = f.name.toLowerCase()
    const v = f.value.toLowerCase()
    if (espMarkers.headerPrefixes.some((p) => n.startsWith(p))) why.push(`third-party relay marker header ${f.name}`)
    if (n === 'received' || n === 'dkim-signature' || n === 'authentication-results' || n === 'return-path') {
      for (const h of hosts) if (new RegExp(`(^|[^a-z0-9-])([a-z0-9-]+\\.)*${h.replace(/\./g, '\\.')}([^a-z0-9-]|$)`).test(v)) why.push(`third-party relay ${h} in ${f.name}`)
    }
  }
  return { unparseable: null, reasons: [...new Set(why)] }
}

export function loadReceivers(file = RECEIVERS_PATH) {
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  if (doc?.schemaVersion !== 1 || typeof doc.receivers !== 'object' || !Array.isArray(doc.espMarkers?.hosts)) throw new Error('receivers.json is not a schemaVersion 1 document')
  return doc
}

export function main(argv = process.argv.slice(2), log = console) {
  const o = { mailEnv: '/run/gremion/env/mail.env', receivers: RECEIVERS_PATH, authservIds: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = () => {
      if (argv[i + 1] === undefined) throw new Error(`${a} requires a value`)
      return argv[++i]
    }
    try {
      if (a === '--file') o.file = v()
      else if (a === '--domain') o.domain = v()
      else if (a === '--bind-ip') o.ip = v()
      else if (a === '--bind-ip6') o.ip6 = v()
      else if (a === '--authserv-id') {
        if (o.authservIds.length) throw new Error('--authserv-id is given once: one receiver per run')
        o.authservIds.push(v())
      }
      else if (a === '--receiver') o.receiver = v()
      else if (a === '--receiver-domain') o.receiverDomain = v()
      else if (a === '--receivers') o.receivers = v()
      else if (a === '--mail-env') o.mailEnv = v()
      else throw new Error(`unknown argument ${a}`)
    } catch (e) {
      log.error(`usage: check-received.mjs --file F [--domain D --bind-ip IP --bind-ip6 IP6] [--authserv-id ID]: ${e.message}`)
      return 2
    }
  }
  if (!o.file) {
    log.error('usage: check-received.mjs --file F ...: --file is required')
    return 2
  }
  let text, receivers
  try {
    text = readFileSync(o.file, 'utf8')
    receivers = loadReceivers(o.receivers)
    if (!o.domain || !o.ip) {
      const mail = envMap(readFileSync(o.mailEnv, 'utf8'), 'mail.env')
      o.domain ??= mail.PLATFORM_DOMAIN
      o.ip ??= mail.MAIL_BIND_IP
      o.ip6 ??= mail.MAIL_BIND_IP6
    }
  } catch (e) {
    log.error(`UNPARSEABLE ${e.code ?? ''} ${e.message}`)
    return 2
  }
  if (!o.domain || !o.ip) {
    log.error('UNPARSEABLE no domain / bind address (pass --domain and --bind-ip, or mount mail.env)')
    return 2
  }
  let ids = o.authservIds
  let suffixes = o.receiverDomain ? [o.receiverDomain] : []
  if (o.receiver && o.authservIds.length) {
    log.error('usage: --receiver and --authserv-id are mutually exclusive: one receiver per run')
    return 2
  }
  if (o.receiver) {
    const entry = receivers.receivers[o.receiver]
    if (!entry || !Array.isArray(entry.authservIds) || !Array.isArray(entry.hostSuffixes)) {
      log.error(`usage: --receiver ${o.receiver} is not in deliverability/receivers.json (${Object.keys(receivers.receivers).join(', ')})`)
      return 2
    }
    ids = [...ids, ...entry.authservIds]
    suffixes = [...suffixes, ...entry.hostSuffixes]
  } else if (!suffixes.length) {
    // No guessing the receiver's domain from its authserv-id: the last two
    // labels of mx.uni-x.ac.uk are the public suffix ac.uk (round-2 review).
    log.error('usage: --authserv-id needs --receiver-domain <the receiver\'s own domain>')
    return 2
  }
  if (!ids.length) {
    log.error('usage: name the receiver: --receiver <name in receivers.json> or --authserv-id <id> [--receiver-domain D]')
    return 2
  }
  const r = checkReceived(text, { domain: o.domain, bindIps: [o.ip, o.ip6], authservIds: ids, receiverSuffixes: suffixes, espMarkers: receivers.espMarkers })
  if (r.unparseable) {
    log.error(`UNPARSEABLE ${r.unparseable}`)
    return 2
  }
  for (const w of r.reasons) log.error(`FAIL ${w}`)
  log.log(`RECEIVED: domain=${o.domain} verdict=${r.reasons.length ? 'not-proven' : 'own-server spf=pass dkim=pass dmarc=pass'}`)
  return r.reasons.length ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
