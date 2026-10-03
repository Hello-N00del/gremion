// node --test test/host/fixtures/customer-provision/data-fingerprint.test.mjs
//
// TASK-043c R30 addendum A2 (PRD-OPS-004): suspend must not alter stored data.
// customer-provision-proof.sh records a fingerprint of the customer's stored
// data (per table of its kernel database and of every enabled module database:
// row count + md5 over the ordered rows; plus the realm's user count) before
// `tenant suspend` and after `tenant resume`; this judge compares the two.
// Equal is the ONLY pass: a changed, added or dropped table, a changed realm
// user count, and an EMPTY fingerprint (a check that read nothing) all fail.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { compareFingerprints, parseFingerprint } from './data-fingerprint.mjs'

const BEFORE = [
  '# fingerprint proof-x 01927f00-0000-7000-8000-000000000001',
  'kernel:public.org_units\t1\t0f343b0931126a20f133d67c2b018a3b',
  'kernel:public.schema_migrations\t42\t5d41402abc4b2a76b9719d911017c592',
  'calendar:public.events\t0\t-',
  'realm-users\t2',
  '',
].join('\n')

describe('parseFingerprint', () => {
  it('reads table lines and the realm user count, ignoring comments and blank lines', () => {
    const fp = parseFingerprint(BEFORE)
    assert.equal(fp.tables.size, 3)
    assert.deepEqual(fp.tables.get('kernel:public.org_units'), { count: '1', md5: '0f343b0931126a20f133d67c2b018a3b' })
    assert.equal(fp.realmUsers, '2')
    assert.deepEqual(fp.malformed, [])
  })

  it('names a malformed line instead of skipping it', () => {
    assert.deepEqual(parseFingerprint('kernel:public.x\tnot-a-count\t-\nrealm-users\t2\n').malformed, ['kernel:public.x\tnot-a-count\t-'])
  })
})

describe('compareFingerprints', () => {
  it('equal fingerprints pass', () => {
    assert.deepEqual(compareFingerprints(BEFORE, BEFORE), [])
    // line order and CRLF do not matter (the lines are keyed)
    const shuffled = BEFORE.split('\n').toReversed().join('\r\n')
    assert.deepEqual(compareFingerprints(BEFORE, shuffled), [])
  })

  it('a changed row count or checksum fails, naming the table', () => {
    const changed = BEFORE.replace('kernel:public.org_units\t1\t0f343b0931126a20f133d67c2b018a3b', 'kernel:public.org_units\t1\tffffffffffffffffffffffffffffffff')
    const v = compareFingerprints(BEFORE, changed)
    assert.equal(v.length, 1)
    assert.match(v[0], /kernel:public\.org_units: changed/)
    assert.match(compareFingerprints(BEFORE, BEFORE.replace('calendar:public.events\t0\t-', 'calendar:public.events\t1\t900150983cd24fb0d6963f7d28e17f72'))[0], /calendar:public\.events: changed \(0 rows -> 1 rows; md5 - -> 9001/)
  })

  it('a table that appeared or vanished fails', () => {
    const dropped = BEFORE.replace('calendar:public.events\t0\t-\n', '')
    assert.match(compareFingerprints(BEFORE, dropped)[0], /calendar:public\.events: present before suspend, absent after resume/)
    assert.match(compareFingerprints(dropped, BEFORE)[0], /calendar:public\.events: absent before suspend, present after resume/)
  })

  it('a changed realm user count fails', () => {
    assert.match(compareFingerprints(BEFORE, BEFORE.replace('realm-users\t2', 'realm-users\t3'))[0], /realm users: 2 before suspend, 3 after resume/)
  })

  it('an empty fingerprint is a failure even when both sides are equally empty (zero tables proves nothing)', () => {
    assert.ok(compareFingerprints('', '').length > 0)
    assert.ok(compareFingerprints('realm-users\t2\n', 'realm-users\t2\n').some((l) => /no table/.test(l)))
    assert.ok(compareFingerprints(BEFORE.replace('realm-users\t2\n', ''), BEFORE.replace('realm-users\t2\n', '')).some((l) => /no realm user count/.test(l)))
  })

  it('a malformed line fails', () => {
    assert.ok(compareFingerprints(`${BEFORE}garbage\n`, `${BEFORE}garbage\n`).some((l) => /malformed/.test(l)))
  })
})

describe('the CLI the proof script calls', () => {
  const cli = fileURLToPath(new URL('./data-fingerprint.mjs', import.meta.url))
  const dir = join(fileURLToPath(new URL('../../../../', import.meta.url)), '.scratch', 'data-fingerprint-test')
  mkdirSync(dir, { recursive: true })
  const file = (name, body) => {
    const p = join(dir, name)
    writeFileSync(p, body)
    return p
  }
  const run = (...args) => spawnSync(process.execPath, [cli, 'compare', ...args], { encoding: 'utf8' })

  it('exits 0 on equal files and 1 on a mismatch, printing the difference', () => {
    assert.equal(run(file('a.txt', BEFORE), file('b.txt', BEFORE)).status, 0)
    const bad = run(file('a.txt', BEFORE), file('c.txt', BEFORE.replace('realm-users\t2', 'realm-users\t1')))
    assert.equal(bad.status, 1)
    assert.match(bad.stdout, /realm users: 2 before suspend, 1 after resume/)
  })

  it('exits 1 on a missing file and on two empty files', () => {
    assert.equal(run(file('a.txt', BEFORE), join(dir, 'absent.txt')).status, 1)
    assert.equal(run(file('e1.txt', ''), file('e2.txt', '')).status, 1)
  })
})
