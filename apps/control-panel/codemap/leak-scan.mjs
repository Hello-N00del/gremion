// leak-scan.mjs - looks for what must never be in a public repository or in a page made from it.
// findLeaks(text) returns [{ rule, sample, index }]. The rule ids are safe to print; the sample is the matched
// text and is NOT (the caller prints a rule id, never a sample, into a status file or a log).
//
// This file holds patterns for classes of secret, never a real host name, address or key.

const ALLOWED_HOSTS = [/(^|\.)example$/i, /^schema$/i, /^w3$/i]
const TLDS = 'de|com|org|net|io|eu|cloud'

// ipv4: four numbers 0-255, not part of a longer dotted number (a version string).
const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d]|\.\d)/g
// domain: labels, then a listed ending. A dot and a letter or digit after it make a file name (a.net.ts).
const DOMAIN = new RegExp(`(?<![A-Za-z0-9_-])((?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?[.])+(?:${TLDS}))(?![A-Za-z0-9_-]|[.][A-Za-z0-9])`, 'gi')
const PEM = /-----BEGIN/g
const TOKEN = /(?:\bghp_[A-Za-z0-9]{10,}|\bgithub_pat_[A-Za-z0-9_]{10,}|\bAKIA[0-9A-Z]{12,}|\bxox[bp]-[A-Za-z0-9-]{6,})/g
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g
const CREDENTIAL = /\b(?:password|secret)\s*=\s*(["']?)([^\s"'&;,)]*)/gi
// A Windows path in JSON text has its backslashes doubled (or doubled again in a string inside a string), so the
// separator is one or more of / and \. Any letter case: a drive letter and a folder name can be lower case.
const LOCAL_PATH = /(?:\b[A-Za-z]:[\\/]+Users[\\/]+|(?<![A-Za-z0-9_.-])\/home\/[^/\s]+\/)/gi

const PLACEHOLDER = /^(?:[$<{[(%*]|\.{3}|x+$|-+$|changeme|change-me|example|placeholder|secret$|password$|your|todo|redacted|none$|null$|undefined$|true$|false$|process\.|env\.)/i

function* all(re, text) {
  re.lastIndex = 0
  yield* text.matchAll(re)
}

/** @returns {Array<{rule:string, sample:string, index:number}>} */
export function findLeaks(text) {
  const s = String(text ?? '')
  const out = []
  for (const m of all(IPV4, s)) {
    const octets = m.slice(1, 5).map(Number)
    if (octets.some((o) => o > 255)) continue
    if (m[0] === '127.0.0.1' || m[0] === '0.0.0.0') continue
    out.push({ rule: 'ipv4', sample: m[0], index: m.index })
  }
  for (const m of all(DOMAIN, s)) {
    const labels = m[1].split('.')
    const rest = labels.slice(0, -1)
    const second = rest[rest.length - 1] ?? ''
    if (ALLOWED_HOSTS.some((re) => re.test(second))) continue
    out.push({ rule: 'domain', sample: m[1], index: m.index })
  }
  for (const m of all(PEM, s)) out.push({ rule: 'pem', sample: m[0], index: m.index })
  for (const m of all(TOKEN, s)) out.push({ rule: 'token', sample: m[0], index: m.index })
  for (const m of all(JWT, s)) out.push({ rule: 'jwt', sample: m[0], index: m.index })
  for (const m of all(CREDENTIAL, s)) {
    const v = m[2]
    if (v.length < 4 || PLACEHOLDER.test(v)) continue
    out.push({ rule: 'credential', sample: m[0], index: m.index })
  }
  for (const m of all(LOCAL_PATH, s)) out.push({ rule: 'local-path', sample: m[0], index: m.index })
  return out
}

/** The rule ids of a list of hits, unique and sorted. Safe to print. */
export const ruleIds = (leaks) => [...new Set(leaks.map((l) => l.rule))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
