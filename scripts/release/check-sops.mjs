#!/usr/bin/env node
// check-sops — no plaintext secret in the tracked tree (TASK-046, TRD-442).
//
// Secrets are committed ONLY as SOPS files encrypted to the age recipients
// .sops.yaml names. This guard asserts that as a POST-CONDITION on the content
// of every tracked file, never on a file name or an exit code:
//
//   1. .sops.yaml exists, has at least one creation rule, and every age
//      recipient is a well-formed age1… public key. The committed sentinel
//      (<OPERATOR_AGE_PUBLIC_KEY_…>) FAILS until the operator supplies the
//      real recipient — that failure is expected and documented (activation
//      checklist in scripts/release/README.md).
//   2. Secret-class files (brief Q5): anything a .sops.yaml path_regex
//      matches, anything under a `secrets/` directory (except `.gitkeep`,
//      `*.example*` and scripts), and every `*.enc.{yaml,yml,json,env}`. Each
//      must be a SOPS document whose every value is ENC[AES256_GCM,…], with a
//      MAC, encrypted only to recipients .sops.yaml names.
//   3. Key material, anywhere in the tree: an age secret key, a PEM private
//      key block, the cosign private-key variable. Findings name the path and
//      line, never the matched text.
//   4. scripts/release/sops-allow.json may allow a path per rule, each with a
//      reason. A reasonless entry fails; an entry that suppresses nothing
//      fails as stale.
//   5. Zero tracked files fails: a scan that saw nothing proves nothing.
//
// The marker strings in (3) are assembled from fragments so that this file
// does not itself trip the scan.
//
// Run:  node scripts/release/check-sops.mjs [--root DIR]
// Test: node --test scripts/release/check-sops.test.mjs

import { execFileSync } from 'node:child_process'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SENTINEL_RE = /^<[^>]*>$/
export const AGE_RECIPIENT_RE = /^age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/
// The full SOPS value shape: base64 data, iv and tag, and a type. A bare
// `ENC[AES256_GCM,data:hunter2]` is plaintext dressed up, not ciphertext.
const B64 = '[A-Za-z0-9+/]*={0,2}'
const ENC_RE = new RegExp(`^ENC\\[AES256_GCM,data:${B64},iv:${B64},tag:${B64},type:(str|int|float|bool|bytes|comment)\\]$`)
const ENC_COMMENT_RE = new RegExp(`^#ENC\\[AES256_GCM,data:${B64},iv:${B64},tag:${B64},type:comment\\]$`)
// Keys SOPS itself writes into its metadata block. Anything else under
// `sops:` is a value that escaped encryption.
const SOPS_META_KEYS = new Set([
  'age', 'pgp', 'kms', 'gcp_kms', 'azure_kv', 'hc_vault', 'key_groups', 'shamir_threshold',
  'lastmodified', 'mac', 'version', 'unencrypted_suffix', 'encrypted_suffix',
  'unencrypted_regex', 'encrypted_regex', 'unencrypted_comment_regex', 'encrypted_comment_regex', 'mac_only_encrypted',
])
const DOTENV_META_RE = /^sops_(mac|version|lastmodified|unencrypted_suffix|encrypted_suffix|unencrypted_regex|encrypted_regex|unencrypted_comment_regex|encrypted_comment_regex|mac_only_encrypted|shamir_threshold|(age|pgp|kms|gcp_kms|azure_kv|hc_vault)__list_\d+__map_[a-z_]+)$/
const ENC_NAMED_RE = /\.enc\.(ya?ml|json|env)$/i
const SECRETS_DIR_RE = /(^|\/)secrets\//i
const SCRIPT_EXT_RE = /\.(sh|bash|mjs|cjs|js|ts|py)$/i
export const ALLOW_FILE = 'scripts/release/sops-allow.json'

const KEY_MARKERS = [
  { name: 'age secret key', re: new RegExp(['AGE', 'SECRET', 'KEY', '1'].join('-')) },
  { name: 'PEM/PGP private key', re: new RegExp('-----BEGIN [A-Z0-9 ]*' + 'PRIVATE' + ' KEY( BLOCK)?-----') },
  { name: 'cosign private key variable', re: new RegExp(['COSIGN', 'PRIVATE', 'KEY'].join('_')) },
]

// ── .sops.yaml ─────────────────────────────────────────────────────────────

const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2')

/** Minimal reader for the creation_rules shape .sops.yaml uses. */
export function parseSopsConfig(text) {
  const rules = []
  const lines = text.split('\n')
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+#.*$/, '')
    if (/^\s*#/.test(line) || !line.trim()) continue
    const item = /^\s*-\s+(.*)$/.exec(line)
    const body = item ? item[1] : line.trim()
    if (item) {
      cur = { pathRegex: null, recipients: [] }
      rules.push(cur)
    }
    if (!cur) continue
    let m
    if ((m = /^path_regex:\s*(.*)$/.exec(body))) cur.pathRegex = unquote(m[1])
    else if ((m = /^age:\s*(.*)$/.exec(body))) {
      let v = m[1].trim()
      if (/^[>|][-+]?$/.test(v)) {
        const ind = /^(\s*)/.exec(lines[i])[1].length
        v = ''
        while (i + 1 < lines.length && (/^\s*$/.test(lines[i + 1]) || /^(\s*)/.exec(lines[i + 1])[1].length > ind)) {
          v += ' ' + lines[++i].trim()
        }
      }
      cur.recipients.push(...unquote(v).split(/[\s,]+/).filter(Boolean))
    }
  }
  return { rules }
}

// ── SOPS content checks ────────────────────────────────────────────────────

function yamlSops(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^sops:\s*$/.test(l))
  if (start < 0) return { ok: false, why: 'no sops metadata block' }
  let end = start + 1
  while (end < lines.length && (/^\s/.test(lines[end]) || lines[end] === '')) end++
  const metaLines = lines.slice(start + 1, end)
  const meta = metaLines.join('\n')
  const ind = /^(\s*)/.exec(metaLines.find((l) => l.trim()) ?? '')[1].length
  for (const l of metaLines) {
    if (!l.trim() || /^(\s*)/.exec(l)[1].length !== ind) continue
    const k = /^\s*([A-Za-z_]+):/.exec(l)?.[1]
    if (!k || !SOPS_META_KEYS.has(k)) return { ok: false, why: 'a non-metadata entry inside the sops block' }
  }
  const body = [...lines.slice(0, start), ...lines.slice(end)]
  for (const [i, raw] of body.entries()) {
    const l = raw.trim()
    if (l === '' || l === '---') continue
    if (ENC_COMMENT_RE.test(l)) continue
    const s = l.replace(/^-\s+/, '')
    if (s === '-') continue
    if (ENC_RE.test(s)) continue // list scalar
    const kv = /^("[^"]*"|'[^']*'|[^:#]+):\s*(.*)$/.exec(s)
    if (kv && (kv[2] === '' || ENC_RE.test(kv[2]))) continue
    return { ok: false, why: `plaintext value on line ${i + 1}` }
  }
  if (!/^\s+mac:\s*ENC\[AES256_GCM,/m.test(meta)) return { ok: false, why: 'no MAC in the sops block' }
  const recipients = [...meta.matchAll(/recipient:\s*(\S+)/g)].map((m) => m[1])
  if (!recipients.length) return { ok: false, why: 'no age recipient in the sops block' }
  return { ok: true, recipients }
}

function jsonSops(text) {
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    return { ok: false, why: 'not JSON and not a SOPS document' }
  }
  if (!doc || typeof doc !== 'object' || !doc.sops || typeof doc.sops !== 'object') {
    return { ok: false, why: 'no sops metadata' }
  }
  if (Object.keys(doc.sops).some((k) => !SOPS_META_KEYS.has(k))) return { ok: false, why: 'a non-metadata entry inside sops' }
  const bad = []
  const walk = (v, p) => {
    if (v && typeof v === 'object') {
      for (const [k, c] of Object.entries(v)) if (!(p === '' && k === 'sops')) walk(c, `${p}.${k}`)
    } else if (!(typeof v === 'string' && ENC_RE.test(v))) bad.push(p || '.')
  }
  walk(doc, '')
  if (bad.length) return { ok: false, why: `plaintext value at ${bad[0]}` }
  if (!(typeof doc.sops.mac === 'string' && ENC_RE.test(doc.sops.mac))) return { ok: false, why: 'no MAC' }
  const recipients = (Array.isArray(doc.sops.age) ? doc.sops.age : []).map((a) => a?.recipient).filter(Boolean)
  if (!recipients.length) return { ok: false, why: 'no age recipient' }
  return { ok: true, recipients }
}

function dotenvSops(text) {
  const recipients = []
  let mac = false
  for (const [i, raw] of text.split('\n').entries()) {
    const l = raw.trim()
    if (l === '' || ENC_COMMENT_RE.test(l)) continue
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l)
    if (!m) return { ok: false, why: `unparseable line ${i + 1}` }
    if (DOTENV_META_RE.test(m[1])) {
      if (/^sops_age__list_\d+__map_recipient$/.test(m[1])) recipients.push(m[2])
      if (m[1] === 'sops_mac' && ENC_RE.test(m[2])) mac = true
      continue
    }
    if (!ENC_RE.test(m[2])) return { ok: false, why: `plaintext value on line ${i + 1}` }
  }
  if (!mac) return { ok: false, why: 'no sops_mac' }
  if (!recipients.length) return { ok: false, why: 'no age recipient' }
  return { ok: true, recipients }
}

/** {ok, recipients?, why?} for one file's content. */
export function isSopsEncrypted(text, path) {
  const b = basename(path)
  if (/\.ya?ml$/.test(b)) return yamlSops(text)
  if (b.endsWith('.env') || b.startsWith('.env')) return dotenvSops(text)
  return jsonSops(text) // .json, and SOPS' binary format (a JSON envelope)
}

// ── the scan ───────────────────────────────────────────────────────────────

function swap16(buf) {
  const b = Buffer.from(buf.subarray(0, buf.length - (buf.length % 2)))
  return b.swap16()
}

/** path -> {sha, content} for every stage-0 entry of the index (git cat-file --batch). */
export function indexBlobs(root) {
  const ls = execFileSync('git', ['-C', root, 'ls-files', '-s', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  const entries = ls.split('\0').filter(Boolean).map((l) => {
    const m = /^(\d+) ([0-9a-f]{40}) (\d)\t(.*)$/s.exec(l)
    if (!m) throw new Error(`cannot parse git ls-files -s entry: ${l}`)
    return { mode: m[1], sha: m[2], path: m[4] }
  }).filter((e) => e.mode !== '160000') // gitlinks carry no content here
  const out = new Map()
  if (!entries.length) return out
  const raw = execFileSync('git', ['-C', root, 'cat-file', '--batch'], {
    input: entries.map((e) => e.sha).join('\n') + '\n',
    maxBuffer: 1024 * 1024 * 1024,
  })
  let off = 0
  for (const e of entries) {
    const nl = raw.indexOf(10, off)
    const [sha, type, size] = raw.subarray(off, nl).toString('utf8').split(' ')
    if (sha !== e.sha || type !== 'blob') throw new Error(`git cat-file: unexpected ${sha} ${type} for ${e.path}`)
    const n = Number(size)
    out.set(e.path, { sha, content: raw.subarray(nl + 1, nl + 1 + n) })
    off = nl + 1 + n + 1
  }
  return out
}

export function classify(path, ruleRegexes) {
  const b = basename(path)
  if (ENC_NAMED_RE.test(b)) return true
  const listed = SECRETS_DIR_RE.test(path) || ruleRegexes.some((re) => re.test(path))
  if (!listed) return false
  return !(b === '.gitkeep' || b.includes('.example') || SCRIPT_EXT_RE.test(b))
}

export function runSopsCheck(root) {
  const problems = []
  const add = (code, path, message) => problems.push({ code, path, message })

  // The INDEX is what gets committed, so it is what is read: a plaintext file
  // deleted from the work tree, or hidden behind an uncommitted encrypted
  // twin, is still in the commit.
  const blobs = indexBlobs(root)
  const files = [...blobs.keys()]
  if (files.length === 0) {
    add('zero-files', '.', 'git ls-files returned nothing — refusing to report a clean scan of an empty set')
    return { problems, scanned: 0, secretFiles: 0 }
  }

  // allowances
  const allow = []
  if (files.includes(ALLOW_FILE)) {
    const doc = JSON.parse(blobs.get(ALLOW_FILE).content.toString('utf8'))
    for (const e of doc.allow ?? []) {
      if (!e || typeof e.reason !== 'string' || !e.reason.trim()) {
        add('allow-without-reason', ALLOW_FILE, `allowance for ${e?.path ?? '?'} has no reason`)
        continue
      }
      // An allowance covers one exact content (its git blob id): the file
      // cannot later grow a real key or value under the same exemption.
      if (typeof e.blob !== 'string' || !/^[0-9a-f]{40}$/.test(e.blob)) {
        add('allow-unpinned', ALLOW_FILE, `allowance for ${e.path} names no blob id (git hash-object)`)
        continue
      }
      allow.push({ ...e, used: false })
    }
  }
  const allowed = (path, rule) => {
    const e = allow.find((a) => a.path === path && a.rule === rule && a.blob === blobs.get(path)?.sha)
    if (e) e.used = true
    return Boolean(e)
  }

  // .sops.yaml
  let config = { rules: [] }
  if (!files.includes('.sops.yaml')) {
    add('no-sops-config', '.sops.yaml', '.sops.yaml is not tracked')
  } else {
    config = parseSopsConfig(blobs.get('.sops.yaml').content.toString('utf8'))
    if (!config.rules.length) add('no-sops-rule', '.sops.yaml', 'no creation_rules entry')
    for (const r of config.rules) {
      if (!r.pathRegex) add('no-sops-rule', '.sops.yaml', 'a creation rule has no path_regex')
      if (!r.recipients.length) add('bad-recipient', '.sops.yaml', 'a creation rule names no age recipient')
      for (const [i, rc] of r.recipients.entries()) {
        if (SENTINEL_RE.test(rc)) {
          // Echo the placeholder only when it is plainly one (<UPPER_SNAKE>).
          const shown = /^<[A-Z0-9_]+>$/.test(rc) && !KEY_MARKERS.some((k) => k.re.test(rc)) ? rc : '(value withheld)'
          add('sentinel-recipient', '.sops.yaml', `age recipient is the placeholder ${shown} — operator activation pending`)
        } else if (!AGE_RECIPIENT_RE.test(rc)) {
          // Never echo the value: the classic mistake is pasting the SECRET half.
          const secret = KEY_MARKERS.some((k) => k.re.test(rc))
          add('bad-recipient', '.sops.yaml', `recipient #${i + 1} is not an age public key${secret ? ' — it looks like a SECRET key; rotate it' : ''} (value withheld)`)
        }
      }
    }
  }
  const known = new Set(config.rules.flatMap((r) => r.recipients).filter((r) => AGE_RECIPIENT_RE.test(r)))
  const ruleRegexes = config.rules.filter((r) => r.pathRegex).map((r) => new RegExp(r.pathRegex))

  let secretFiles = 0
  for (const path of files) {
    const buf = blobs.get(path).content
    const text = buf.includes(0) ? null : buf.toString('utf8')

    if (path !== '.sops.yaml' && classify(path, ruleRegexes)) {
      if (!allowed(path, 'secret-path')) {
        secretFiles += 1
        const v = text === null ? { ok: false, why: 'binary, not a SOPS envelope' } : isSopsEncrypted(text, path)
        if (!v.ok) add('plaintext-secret', path, `secret-class file is not SOPS-encrypted: ${v.why}`)
        else {
          const foreign = v.recipients.filter((r) => !known.has(r))
          // Only well-formed PUBLIC recipients are printed; anything else
          // (a pasted secret key above all) is withheld.
          const shown = foreign.map((r) => (AGE_RECIPIENT_RE.test(r) ? r : '(value withheld)'))
          if (foreign.length) add('foreign-recipient', path, `encrypted to recipient(s) .sops.yaml does not name: ${shown.join(', ')}`)
        }
      }
    }

    {
      // Binary or UTF-16 content is scanned too: raw bytes as latin1 plus both
      // UTF-16 decodings, NULs stripped. A NUL never switches the scan off.
      const views = text !== null ? [text] : [buf.toString('latin1'), buf.toString('utf16le'), swap16(buf).toString('utf16le')].map((v) => v.replace(/\0/g, ''))
      const lines = views.join('\n').split('\n')
      for (const k of KEY_MARKERS) {
        const at = lines.findIndex((l) => k.re.test(l))
        if (at >= 0 && !allowed(path, 'key-material')) add('key-material', path, `${k.name} marker on line ${at + 1}`)
      }
    }
  }

  for (const a of allow) if (!a.used) add('allow-stale', ALLOW_FILE, `allowance for ${a.path} (${a.rule}) suppresses nothing`)
  return { problems, scanned: files.length, secretFiles }
}

// ── CLI ────────────────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--root')
  const root = i > 0 ? process.argv[i + 1] : join(fileURLToPath(import.meta.url), '..', '..', '..')
  const res = runSopsCheck(root)
  for (const p of res.problems) console.error(`check-sops: FAIL ${p.code} ${p.path}: ${p.message}`)
  console.log(`check-sops: scanned ${res.scanned} tracked file(s), ${res.secretFiles} secret-class file(s), ${res.problems.length} problem(s)`)
  process.exit(res.problems.length ? 1 : 0)
}
