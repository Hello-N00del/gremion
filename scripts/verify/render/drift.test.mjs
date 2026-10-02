// TASK-053: G-053-drift -- fixture env vs host template (brief S1, TDD 2).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROJECTS } from '../../check-pooled-stack.mjs'
import { driftChecks, driftViolations, templateFor } from './drift.mjs'

const TMPL = 'STACK=${STACK}\n# COMPOSE_FILE=commented.yml is prose\nCOMPOSE_FILE=docker-compose.app.yml:docker-compose.pins.yml\nCOMPOSE_PROFILES=production\n'
const FIX = 'COMPOSE_FILE=docker-compose.app.yml:test/host/fixtures/pooled-stack/docker-compose.pins.yml\nCOMPOSE_PATH_SEPARATOR=:\nCOMPOSE_PROFILES=production\n'
const drift = (fixtureText, templateText = TMPL) => driftViolations({ projectId: 'app-blue', fixtureText, templateText })

test('the real fixtures and templates agree for all five projects', () => {
  const checks = driftChecks(PROJECTS)
  assert.deepEqual(checks.map((c) => c.id), ['state', 'app-blue', 'app-green', 'ops', 'mail'])
  for (const c of checks) assert.deepEqual(c.problems, [], c.id)
  assert.equal(templateFor('app-green'), 'infra/host/templates/env/app.env.tmpl')
})

test('the synthetic pair is clean (the RED cases below differ by one mutation)', () => {
  assert.deepEqual(drift(FIX), [])
})

test('a dropped docker-compose.app.yml fails', () => {
  const p = drift(FIX.replace('docker-compose.app.yml:', ''))
  assert.match(p.join('\n'), /COMPOSE_FILE has 1 entr\(ies\) in fixture/)
})

test('a replaced non-pins entry fails verbatim', () => {
  assert.match(drift(FIX.replace('docker-compose.app.yml', 'docker-compose.app.dev.yml')).join('\n'), /entry 1 is docker-compose\.app\.dev\.yml in fixture, docker-compose\.app\.yml in template/)
})

test('a different profile fails', () => {
  assert.match(drift(FIX.replace('COMPOSE_PROFILES=production', 'COMPOSE_PROFILES=production,dev')).join('\n'), /COMPOSE_PROFILES is "production,dev" in fixture, "production" in template/)
})

test('a duplicate key fails, in either file', () => {
  assert.match(drift(`${FIX}COMPOSE_PROFILES=production\n`).join('\n'), /fixture declares COMPOSE_PROFILES 2 times/)
  assert.match(drift(FIX, `${TMPL}COMPOSE_FILE=x.yml\n`).join('\n'), /template declares COMPOSE_FILE 2 times/)
})

test('a missing key fails', () => {
  assert.match(drift(FIX.replace(/^COMPOSE_PROFILES=.*$/m, '')).join('\n'), /fixture declares no COMPOSE_PROFILES/)
})

test('a missing pins slot fails (same length, pins slot replaced by another file)', () => {
  const p = drift(FIX.replace('test/host/fixtures/pooled-stack/docker-compose.pins.yml', 'docker-compose.override.yml'))
  assert.match(p.join('\n'), /the pins slot moved or vanished/)
})

test('a differently named pins file in the slot passes, in either merge order (TASK-048b rename)', () => {
  assert.deepEqual(drift(FIX.replace('pooled-stack/docker-compose.pins.yml', 'pooled-stack/docker-compose.state-pins.yml')), [])
  assert.deepEqual(drift(FIX, TMPL.replace(':docker-compose.pins.yml', ':docker-compose.state-pins.yml')), [])
})

test('an unreadable file is a problem of its project, never a skip', () => {
  const [c] = driftChecks([{ id: 'ops', envFile: 'nope.env' }], {
    read: () => {
      throw new Error('ENOENT')
    },
  })
  assert.match(c.problems[0], /ops: cannot read nope\.env/)
})
