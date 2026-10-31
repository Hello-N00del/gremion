// Module Karenz (phase 2, Task 1): the catalogue is re-dated BEFORE any deletion step may be
// switched on. Reads the retention catalogue, the host env template and the app compose file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const CATALOGUE = read('docs/compliance/retention-catalogue.md')
const row = (id) => {
  const line = CATALOGUE.split('\n').find((l) => l.startsWith(`| ${id} `))
  assert.ok(line, `${id} row not found in the catalogue`)
  return line
}

/** The body of a top-level `## N.` section, up to the next top-level heading. */
const section = (prefix) => {
  const body = CATALOGUE.split('\n## ').find((s) => s.startsWith(prefix))
  assert.ok(body, `section ${prefix} not found`)
  return body
}

test('RC-MOD-EXPORT and RC-MOD-DATA state the 30-day grace as derived from the DSB answer of 2026-10-30 and no longer say provisional', () => {
  for (const id of ['RC-MOD-EXPORT', 'RC-MOD-DATA']) {
    const line = row(id)
    assert.match(line, /\*\*grace \(30 days\)\*\*/, `${id} must state the 30-day grace`)
    assert.match(line, /\[D 2026-10-30 DSB Q14\]/, `${id} must carry the DSB answer tag`)
    assert.doesNotMatch(line, /provisional/i, `${id} must not say provisional`)
  }
  assert.match(CATALOGUE, /Change note 2026-10-30/, 'a dated change note sits at the top')
})

test('RC-MOD-EXPORT says the export is taken at switch-off, kept 30 days and deleted on day 30 together with the blocked database, and that K4 finance exports follow their RC-FIN-* class hold (phase 3)', () => {
  const line = row('RC-MOD-EXPORT')
  assert.match(line, /export at switch-off|verified export at switch-off/i)
  assert.match(line, /blocked database/)
  assert.match(line, /RC-FIN-BOOKS 10 y/)
  assert.match(line, /RC-FIN-VOUCH 8 y/)
  assert.match(line, /RC-FIN-CORR 6 y/)
  assert.match(line, /phase 3/)
})

test('RC-MOD-DATA names the sealed read-only copies written at switch-off and the classes kept regardless', () => {
  const line = row('RC-MOD-DATA')
  assert.match(line, /sealed read-only copies/)
  assert.match(line, /RC-ELE/)
  assert.match(line, /RC-GOV-RES/)
  assert.match(line, /RC-GOV-SECRET/)
  assert.match(line, /RC-HND-TRACK 2 years/)
  assert.match(line, /file contents stay in the council's file store/)
})

test('RC-MSG-ROOM says archived at switch-off, deleted on day 30, meeting-linked rooms excepted (RC-MSG-LINK), and names the operator decision as differing from the DSB question text ("sofort") for part 2', () => {
  const line = row('RC-MSG-ROOM')
  assert.match(line, /archived at once/)
  assert.match(line, /30-day Karenz/)
  assert.match(line, /RC-MSG-LINK/)
  assert.match(line, /operator round 2/)
  assert.match(line, /sofort/)
  assert.match(line, /part 2/)
})

test('section 9 no longer says archiving by an admin starts no period for the module-disabled case', () => {
  const s9 = section('9.')
  assert.match(s9, /Chat rooms: archiving is not erasure/)
  // the admin-archive case stays period-free ...
  assert.match(s9, /Archiving by an admin starts no deletion period/i)
  // ... but the module-disabled case is now dated, not "kept until the module is disabled".
  assert.doesNotMatch(s9, /kept until the module is disabled for the customer/)
  assert.match(s9, /module is switched off/i)
  assert.match(s9, /30-day Karenz/)
})

test('A-MOD is marked resolved by the DSB answer and A-G confirms the module grace only (the audit window stays open)', () => {
  const s11 = section('11.')
  const aMod = s11.split('\n').find((l) => l.startsWith('| A-MOD '))
  assert.ok(aMod, 'A-MOD row missing')
  assert.match(aMod, /resolved/i)
  assert.match(aMod, /DSB/)
  assert.match(aMod, /question 14/)
  const aG = s11.split('\n').find((l) => l.startsWith('| A-G '))
  assert.ok(aG, 'A-G row missing')
  assert.match(aG, /module grace/i)
  assert.match(aG, /confirmed/i)
  assert.match(aG, /audit window/)
  assert.match(aG, /open/i)
})

test('section 3 row "Module default profiles" is re-dated', () => {
  const line = CATALOGUE.split('\n').find((l) => l.startsWith('| Module default profiles'))
  assert.ok(line, 'section 3 row missing')
  assert.match(line, /2026-10-30/)
  assert.doesNotMatch(line, /provisional/i)
})

test('app.env.tmpl and docker-compose.app.yml (service tenant-create only) ship KARENZ_FINAL_DELETION defaulting to off', () => {
  const env = read('infra/host/templates/env/app.env.tmpl')
  assert.match(env, /^KARENZ_FINAL_DELETION=off$/m)

  const compose = read('docker-compose.app.yml')
  const occurrences = compose.match(/KARENZ_FINAL_DELETION/g) ?? []
  const hasDefault = compose.match(/^\s+KARENZ_FINAL_DELETION: \$\{KARENZ_FINAL_DELETION:-off\}$/gm) ?? []
  assert.equal(hasDefault.length, 1, 'exactly one KARENZ_FINAL_DELETION entry with the off default')
  assert.ok(occurrences.length >= 1)

  const start = compose.search(/^  tenant-create:/m)
  assert.ok(start >= 0, 'tenant-create service not found')
  const rest = compose.slice(start + 1)
  const next = rest.search(/^  [a-z][\w-]*:|^# =/m)
  const block = next < 0 ? rest : rest.slice(0, next)
  assert.match(block, /^\s+KARENZ_FINAL_DELETION: \$\{KARENZ_FINAL_DELETION:-off\}$/m, 'the entry sits in tenant-create')
  // gremion-ui reads the mode from the row, never from its own environment.
  const ui = compose.slice(compose.search(/^  gremion-ui:/m))
  const uiBlock = ui.slice(0, ui.slice(1).search(/^  [a-z][\w-]*:/m) + 1)
  assert.doesNotMatch(uiBlock, /KARENZ_FINAL_DELETION/, 'gremion-ui must not carry the switch')
})

test('the render env fixtures that carry the app env keys also carry KARENZ_FINAL_DELETION=off', () => {
  for (const f of [
    'test/host/fixtures/pooled-stack/app-blue.env',
    'test/host/fixtures/pooled-stack/app-green.env',
    'scripts/verify/census/render.env',
    'scripts/release/fixtures/render/render.env',
  ]) {
    assert.match(read(f), /^KARENZ_FINAL_DELETION=off$/m, `${f} lacks KARENZ_FINAL_DELETION=off`)
  }
})
