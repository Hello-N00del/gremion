// TASK-015 TDD item 11: the TRD-252 fingerprint and record.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { evaluate, fingerprint, main, recordProblems } from './check-deliverability-record.mjs'
import { REPO_ROOT } from './lib/env.mjs'

const configTmpl = readFileSync(path.join(REPO_ROOT, 'infra/host/mail/config.toml.tmpl'), 'utf8')
const mailTmpl = readFileSync(path.join(REPO_ROOT, 'infra/host/templates/env/mail.env.tmpl'), 'utf8')
const FP = fingerprint({ configTmpl, mailTmpl })
const rec = (o = {}) => ({ date: '2026-09-28', providerClass: 'large-consumer', spf: 'pass', dkim: 'pass', dmarc: 'pass', placement: 'inbox', fingerprint: FP, ...o })
const quiet = { log() {}, error() {} }

test('one changed byte of config.toml.tmpl changes the fingerprint', () => {
  assert.notEqual(fingerprint({ configTmpl: configTmpl.replace('max-recipients = 25', 'max-recipients = 26'), mailTmpl }), FP)
})

test('the STALWART_IMAGE line and the DKIM selector lines are in the fingerprint', () => {
  assert.notEqual(fingerprint({ configTmpl, mailTmpl: mailTmpl.replace(/^STALWART_IMAGE=.*@sha256:0/m, (m) => m.slice(0, -1) + '1') }), FP)
  assert.notEqual(fingerprint({ configTmpl, mailTmpl: mailTmpl.replace('DKIM_SELECTOR_A=g2026a', 'DKIM_SELECTOR_A=g2027a') }), FP)
  assert.notEqual(fingerprint({ configTmpl, mailTmpl: mailTmpl.replace('DKIM_SELECTOR_B=g2026b', 'DKIM_SELECTOR_B=g2027b') }), FP)
  // a comment-only edit of mail.env.tmpl is not a mail-server change
  assert.equal(fingerprint({ configTmpl, mailTmpl: `# note\n${mailTmpl}` }), FP)
})

test('no record yet is PENDING (exit 0); --require without a record is RED', () => {
  assert.deepEqual(evaluate({ records: [], current: FP }), { status: 'PENDING', problems: [] })
  assert.equal(evaluate({ records: [], current: FP, require: true }).status, 'MISSING')
  assert.equal(main([], { log: quiet }), 0)
  assert.equal(main(['--require'], { log: quiet }), 1)
})

test('after the first record, a fingerprint change fails verify (STALE)', () => {
  assert.equal(evaluate({ records: [rec({ fingerprint: 'f'.repeat(64) })], current: FP }).status, 'STALE')
  assert.equal(evaluate({ records: [rec()], current: FP }).status, 'OK')
})

test('--require needs both provider classes at the current fingerprint, all pass, inbox', () => {
  assert.equal(evaluate({ records: [rec()], current: FP, require: true }).status, 'INCOMPLETE')
  // a spam or failing record at the current fingerprint is FAILED, before completeness
  assert.equal(evaluate({ records: [rec(), rec({ providerClass: 'university', placement: 'spam' })], current: FP, require: true }).status, 'FAILED')
  assert.equal(evaluate({ records: [rec(), rec({ providerClass: 'university', dmarc: 'fail' })], current: FP, require: true }).status, 'FAILED')
  assert.equal(evaluate({ records: [rec(), rec({ providerClass: 'university' })], current: FP, require: true }).status, 'OK')
})

test('a record carrying an address, an IP, a host name or an extra field is refused (Q5)', () => {
  assert.match(recordProblems(rec({ placement: 'inbox@example.net' }), 0).join('\n'), /address, IP or host name/)
  assert.match(recordProblems({ ...rec(), note: 'from 192.0.2.25' }, 0).join('\n'), /unexpected field\(s\) note/)
  assert.match(recordProblems(rec({ providerClass: 'mx.example.net' }), 0).join('\n'), /address, IP or host name/)
  assert.deepEqual(recordProblems(rec(), 0), [])
})

test('the CLI reads a records file: STALE exit 1, unparseable exit 2', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 't015-deliv-'))
  try {
    writeFileSync(path.join(d, 'r.json'), JSON.stringify({ schemaVersion: 1, records: [rec({ fingerprint: 'e'.repeat(64) })] }))
    assert.equal(main([], { recordsPath: path.join(d, 'r.json'), log: quiet }), 1)
    writeFileSync(path.join(d, 'bad.json'), '{')
    assert.equal(main([], { recordsPath: path.join(d, 'bad.json'), log: quiet }), 2)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('a failing record at the current fingerprint fails even without --require (review C8)', () => {
  assert.equal(evaluate({ records: [rec({ dmarc: 'fail' })], current: FP }).status, 'FAILED')
  assert.equal(evaluate({ records: [rec({ placement: 'spam' })], current: FP }).status, 'FAILED')
  assert.equal(evaluate({ records: [rec({ dmarc: 'fail', fingerprint: 'f'.repeat(64) }), rec()], current: FP }).status, 'OK')
})
