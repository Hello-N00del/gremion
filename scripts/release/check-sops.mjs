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
import { readFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SENTINEL_RE = /^<[^>]*>$/
export const AGE_RECIPIENT_RE = /^age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/
const ENC_RE = /^ENC\[AES256_GCM,data:[^\]]*\]$/
const ENC_NAMED_RE = /\.enc\.(ya?ml|json|env)$/
const SECRETS_DIR_RE = /(^|\/)secrets\//
const SCRIPT_EXT_RE = /\.(sh|bash|mjs|cjs|js|ts|py)$/
export const ALLOW_FILE = 'scripts/release/sops-allow.json'

const KEY_MARKERS = [
  { name: 'age secret key', re: new RegExp(['AGE', 'SECRET', 'KEY', '1'].join('-')) },
  { name: 'PEM private key', re: new RegExp('-----BEGIN [A-Z0-9 ]*' + 'PRIVATE' + ' KEY-----') },
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
  const meta = lines.slice(start + 1, end).join('\n')
  const body = [...lines.slice(0, start), ...lines.slice(end)]
  for (const [i, raw] of body.entries()) {
    const l = raw.trim()
    if (l === '' || l === '---') continue
    if (/^#ENC\[AES256_GCM,/.test(l)) continue
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
    if (l === '' || /^#ENC\[AES256_GCM,/.test(l)) continue
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l)
    if (!m) return { ok: false, why: `unparseable line ${i + 1}` }
    if (m[1].startsWith('sops_')) {
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
  if (/\.env$/.test(b) || /^\.env/.test(b)) return dotenvSops(text)
  return jsonSops(text) // .json, and SOPS' binary format (a JSON envelope)
}

// ── the scan ───────────────────────────────────────────────────────────────

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

  const files = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean)
  if (files.length === 0) {
    add('zero-files', '.', 'git ls-files returned nothing — refusing to report a clean scan of an empty set')
    return { problems, scanned: 0, secretFiles: 0 }
  }

  // allowances
  const allow = []
  if (files.includes(ALLOW_FILE)) {
    const doc = JSON.parse(readFileSync(join(root, ALLOW_FILE), 'utf8'))
    for (const e of doc.allow ?? []) {
      if (!e || typeof e.reason !== 'string' || !e.reason.trim()) {
        add('allow-without-reason', ALLOW_FILE, `allowance for ${e?.path ?? '?'} has no reason`)
        continue
      }
      allow.push({ ...e, used: false })
    }
  }
  const allowed = (path, rule) => {
    const e = allow.find((a) => a.path === path && a.rule === rule)
    if (e) e.used = true
    return Boolean(e)
  }

  // .sops.yaml
  let config = { rules: [] }
  if (!files.includes('.sops.yaml') || !existsSync(join(root, '.sops.yaml'))) {
    add('no-sops-config', '.sops.yaml', '.sops.yaml is not tracked')
  } else {
    config = parseSopsConfig(readFileSync(join(root, '.sops.yaml'), 'utf8'))
    if (!config.rules.length) add('no-sops-rule', '.sops.yaml', 'no creation_rules entry')
    for (const r of config.rules) {
      if (!r.pathRegex) add('no-sops-rule', '.sops.yaml', 'a creation rule has no path_regex')
      if (!r.recipients.length) add('bad-recipient', '.sops.yaml', 'a creation rule names no age recipient')
      for (const rc of r.recipients) {
        if (SENTINEL_RE.test(rc)) {
          add('sentinel-recipient', '.sops.yaml', `age recipient is the placeholder ${rc} — operator activation pending`)
        } else if (!AGE_RECIPIENT_RE.test(rc)) {
          add('bad-recipient', '.sops.yaml', `not an age public key: ${rc}`)
        }
      }
    }
  }
  const known = new Set(config.rules.flatMap((r) => r.recipients).filter((r) => AGE_RECIPIENT_RE.test(r)))
  const ruleRegexes = config.rules.filter((r) => r.pathRegex).map((r) => new RegExp(r.pathRegex))

  let secretFiles = 0
  for (const path of files) {
    const abs = join(root, path)
    if (!existsSync(abs)) continue // tracked but deleted in the work tree
    const buf = readFileSync(abs)
    const text = buf.subarray(0, 8192).includes(0) ? null : buf.toString('utf8')

    if (path !== '.sops.yaml' && classify(path, ruleRegexes)) {
      if (!allowed(path, 'secret-path')) {
        secretFiles += 1
        const v = text === null ? { ok: false, why: 'binary, not a SOPS envelope' } : isSopsEncrypted(text, path)
        if (!v.ok) add('plaintext-secret', path, `secret-class file is not SOPS-encrypted: ${v.why}`)
        else {
          const foreign = v.recipients.filter((r) => !known.has(r))
          if (foreign.length) add('foreign-recipient', path, `encrypted to recipient(s) .sops.yaml does not name: ${foreign.join(', ')}`)
        }
      }
    }

    if (text !== null) {
      const lines = text.split('\n')
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
