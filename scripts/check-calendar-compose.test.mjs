// The calendar leaf in the app compose (docker-compose.app.yml `calendar-service`): how it reaches the databases.
//
// A customer's calendar is t_<tenant>__calendar, created, migrated, exported and blocked by the module lifecycle. The leaf
// only opens it, so what the render must say is pinned here as post-conditions of a real `docker compose config`:
//   1. GREMION_CALENDAR_PG_URL names calendar-postgres and the module APP role m_calendar_app, never the server admin (the
//      Karenz block revokes CONNECT from that role; a superuser would ignore the revoke and keep serving a switched-off
//      customer), and carries the password the module role is set from;
//   2. CALENDAR_PG_URL stays the admin login, for the leaf's catalogue database only: the two URLs name different users;
//   3. the password is required: unset or empty it fails the render by variable NAME, with or without the profile (a
//      recreate without the env must not start a leaf whose every connection is refused with 28P01 while /healthz is green);
//   4. no leak: the password reaches calendar-service only, and a refusal names the variable, never a value.
// The password's single source (the file the module lifecycle sets the role from) is test/host/init-secrets.bats.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEnvFile, renderState } from './compose-edge.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP_ENV = 'test/host/fixtures/pooled-stack/app-blue.env'
// a distinctive value, so a leak is a plain substring search (the fixture's own values are not unique)
const PASSWORD = 'cal-pw-7d1f3b5a9c2e4680'

const render = (profiles, env = {}) =>
  renderState({ envFile: APP_ENV, env: { COMPOSE_PROFILES: profiles, CALENDAR_APP_PASSWORD: PASSWORD, ...env } })

test('GREMION_CALENDAR_PG_URL names calendar-postgres and the module APP role, never the server admin; CALENDAR_PG_URL stays the admin', () => {
  const env = render('calendar').services['calendar-service'].environment
  const appUrl = new URL(env.GREMION_CALENDAR_PG_URL)
  assert.equal(appUrl.hostname, 'calendar-postgres')
  assert.equal(appUrl.port, '5432')
  assert.equal(appUrl.pathname, '/postgres', 'the leaf replaces the database name per customer')
  // the role is the lifecycle's: m_<module>_app (packages/tenant-store/src/lifecycle/guards.ts moduleRoles)
  assert.match(readFileSync(join(ROOT, 'packages/tenant-store/src/lifecycle/guards.ts'), 'utf8'), /app: `m_\$\{moduleId\}_app`/)
  assert.equal(decodeURIComponent(appUrl.username), 'm_calendar_app')
  assert.equal(decodeURIComponent(appUrl.password), PASSWORD)

  const adminUrl = new URL(env.CALENDAR_PG_URL)
  assert.equal(adminUrl.hostname, 'calendar-postgres')
  assert.notEqual(decodeURIComponent(adminUrl.username), decodeURIComponent(appUrl.username), 'the catalogue login and the customer login are different users')
  assert.notEqual(decodeURIComponent(adminUrl.password), PASSWORD, 'the admin password is not the app role password')
  const fx = readEnvFile(APP_ENV)
  assert.equal(decodeURIComponent(adminUrl.username), fx.CALENDAR_PG_USER ?? 'calendar')
})

test('an unset or empty CALENDAR_APP_PASSWORD fails the render by variable name, with or without the profile, naming no value', () => {
  for (const profiles of ['calendar', 'production']) {
    assert.throws(
      () => renderState({ envFile: APP_ENV, env: { COMPOSE_PROFILES: profiles, CALENDAR_APP_PASSWORD: '' } }),
      (err) => {
        assert.match(String(err.message), /required variable CALENDAR_APP_PASSWORD is missing a value/, profiles)
        assert.ok(!String(err.message).includes(PASSWORD), 'the refusal carries a secret value')
        return true
      },
    )
  }
})

test('the app role password reaches calendar-service only', () => {
  const r = render('calendar')
  for (const [name, svc] of Object.entries(r.services)) {
    const text = JSON.stringify(svc.environment ?? {})
    if (name === 'calendar-service') assert.ok(text.includes(encodeURIComponent(PASSWORD)) || text.includes(PASSWORD), 'calendar-service lacks its password')
    else assert.ok(!text.includes(PASSWORD), `${name} carries the calendar app role password`)
  }
})
