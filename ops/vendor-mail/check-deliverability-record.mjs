#!/usr/bin/env node
// TASK-015 (TRD-252, PRD-REC-006, Q5, Q6): the deliverability record, and
// "re-tested at any mail-server change".
//
//   node ops/vendor-mail/check-deliverability-record.mjs [--require]
//   node ops/vendor-mail/check-deliverability-record.mjs --print-fingerprint
//
// FINGERPRINT (Q6): sha256 over, in order, the bytes of
// infra/host/mail/config.toml.tmpl, the STALWART_IMAGE line and the
// DKIM_SELECTOR_A/B lines of infra/host/templates/env/mail.env.tmpl. Any of
// them changing is a mail-server change that can move SPF/DKIM/DMARC or
// placement, so it invalidates the record.
//
// VERDICT
//   PENDING   no record yet: exit 0, printed as PENDING (TRD-252 gate F2 is
//             where it must exist; TASK-038 and F2 run --require).
//   OK        a record exists for the current fingerprint.
//   STALE     records exist, none for the current fingerprint: exit 1 -- the
//             mail server changed after the last test; re-test and record.
//   --require additionally needs, at the current fingerprint, one record per
//             provider class (large-consumer, university) with spf, dkim and
//             dmarc = pass and placement = inbox; else exit 1.
// A record carrying an address, an IP or a hostname is refused (exit 1):
// raw headers stay off git (Q5, GDPR Art. 5(1)(c)).
//
// EXIT: 0 OK/PENDING - 1 STALE, incomplete under --require, or a bad record -
//       2 unreadable input.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPO_ROOT } from './lib/env.mjs'

export const RECORDS_PATH = path.join(import.meta.dirname, 'deliverability', 'records.json')
export const CLASSES = ['large-consumer', 'university']
const FIELDS = ['date', 'providerClass', 'spf', 'dkim', 'dmarc', 'placement', 'fingerprint']

export function fingerprint({ configTmpl, mailTmpl }) {
  const lines = mailTmpl.split(/\r?\n/)
  const pick = (k) => {
    const l = lines.filter((x) => x.startsWith(`${k}=`))
    if (l.length !== 1) throw new Error(`mail.env.tmpl declares ${k} ${l.length} times`)
    return l[0]
  }
  const h = createHash('sha256')
  h.update(configTmpl)
  h.update('\0')
  h.update(pick('STALWART_IMAGE'))
  h.update('\0')
  h.update(pick('DKIM_SELECTOR_A'))
  h.update('\0')
  h.update(pick('DKIM_SELECTOR_B'))
  return h.digest('hex')
}

export function recordProblems(rec, i) {
  const out = []
  for (const f of FIELDS) if (typeof rec?.[f] !== 'string' || !rec[f]) out.push(`record ${i}: ${f} is missing`)
  const extra = Object.keys(rec ?? {}).filter((k) => !FIELDS.includes(k))
  if (extra.length) out.push(`record ${i}: unexpected field(s) ${extra.join(', ')} -- only ${FIELDS.join(', ')} are kept`)
  const text = JSON.stringify(rec)
  if (/@|\b\d{1,3}(\.\d{1,3}){3}\b|[0-9a-f]{1,4}(:[0-9a-f]{0,4}){2,}|\b[a-z0-9-]+\.[a-z]{2,}\b/i.test(text.replace(/"fingerprint":"[0-9a-f]{64}"/, '').replace(/"date":"[0-9-]+"/, '')))
    out.push(`record ${i}: carries an address, IP or host name -- raw headers stay off git (Q5)`)
  if (rec?.providerClass && !CLASSES.includes(rec.providerClass)) out.push(`record ${i}: providerClass must be one of ${CLASSES.join(', ')}`)
  if (rec?.date && !/^\d{4}-\d{2}-\d{2}$/.test(rec.date)) out.push(`record ${i}: date must be YYYY-MM-DD`)
  if (rec?.fingerprint && !/^[0-9a-f]{64}$/.test(rec.fingerprint)) out.push(`record ${i}: fingerprint must be 64 hex`)
  for (const v of ['spf', 'dkim', 'dmarc']) if (rec?.[v] && !['pass', 'fail', 'none', 'softfail', 'neutral', 'temperror', 'permerror'].includes(rec[v])) out.push(`record ${i}: ${v} is not an RFC 8601 result`)
  if (rec?.placement && !['inbox', 'spam'].includes(rec.placement)) out.push(`record ${i}: placement must be inbox or spam`)
  return out
}

export function evaluate({ records, current, require = false }) {
  if (!Array.isArray(records)) return { status: 'UNPARSEABLE', problems: ['records is not an array'] }
  const problems = records.flatMap((r, i) => recordProblems(r, i))
  if (problems.length) return { status: 'BAD-RECORD', problems }
  if (records.length === 0) return require ? { status: 'MISSING', problems: ['no deliverability record exists (--require)'] } : { status: 'PENDING', problems: [] }
  const now = records.filter((r) => r.fingerprint === current)
  if (now.length === 0) return { status: 'STALE', problems: ['the mail server changed after the last deliverability test (fingerprint differs): re-test at both provider classes and record'] }
  if (require) {
    const missing = CLASSES.filter((c) => !now.some((r) => r.providerClass === c && r.spf === 'pass' && r.dkim === 'pass' && r.dmarc === 'pass' && r.placement === 'inbox'))
    if (missing.length) return { status: 'INCOMPLETE', problems: missing.map((c) => `no ${c} record with spf/dkim/dmarc=pass and placement=inbox at the current fingerprint`) }
  }
  return { status: 'OK', problems: [] }
}

export function main(argv = process.argv.slice(2), { root = REPO_ROOT, recordsPath = RECORDS_PATH, log = console } = {}) {
  const require = argv.includes('--require')
  const unknown = argv.filter((a) => !['--require', '--print-fingerprint'].includes(a))
  if (unknown.length) {
    log.error(`usage: check-deliverability-record.mjs [--require | --print-fingerprint]: unknown ${unknown.join(' ')}`)
    return 2
  }
  let current, doc
  try {
    current = fingerprint({
      configTmpl: readFileSync(path.join(root, 'infra/host/mail/config.toml.tmpl'), 'utf8'),
      mailTmpl: readFileSync(path.join(root, 'infra/host/templates/env/mail.env.tmpl'), 'utf8'),
    })
    if (argv.includes('--print-fingerprint')) {
      log.log(current)
      return 0
    }
    doc = JSON.parse(readFileSync(recordsPath, 'utf8'))
    if (doc?.schemaVersion !== 1) throw new Error('records.json is not schemaVersion 1')
  } catch (e) {
    log.error(`UNPARSEABLE ${e.code ?? ''} ${e.message}`)
    return 2
  }
  const r = evaluate({ records: doc.records, current, require })
  for (const p of r.problems) log.error(`FAIL ${p}`)
  log.log(`DELIVERABILITY: ${r.status} fingerprint=${current} records=${Array.isArray(doc.records) ? doc.records.length : '?'}${require ? ' (require)' : ''}`)
  return r.status === 'OK' || r.status === 'PENDING' ? 0 : r.status === 'UNPARSEABLE' ? 2 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
