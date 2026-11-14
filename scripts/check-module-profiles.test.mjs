// infra/host/module-profiles.json is the ONE place the pilot's compose profile names are stated:
// gremion-init-secrets renders COMPOSE_PROFILES from it, gremion-services wire adds its post-realm
// profiles. This pins it against the two things it must agree with, so a module or a profile cannot
// be added or renamed in one place only:
//   - every catalogue id (modules/*/module.json) is classified, and nothing else is;
//   - every profile it names (and its knownProfiles list) is a profile a compose file defines, and
//     every module-level profile a compose file defines is named, so a service gated behind a profile
//     no module asks for is a service nothing ever starts.
// An off-module profile is never rendered, a pilot module always asks for something, and the
// post-realm profile (messaging: Synapse refuses a blank issuer at boot) is never a pre-realm one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAP = JSON.parse(readFileSync(join(ROOT, 'infra/host/module-profiles.json'), 'utf8'))
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.prod.yml', 'docker-compose.app.yml']
/** Profiles that gate infrastructure and one-shots, never a module. */
const SYSTEM_PROFILES = new Set(['production', 'dev', 'migrate', 'tenant-create', 'kernel-api-migrate'])

const composeProfiles = () => {
  const out = new Set()
  for (const f of COMPOSE_FILES) {
    const doc = parse(readFileSync(join(ROOT, f), 'utf8'), { merge: true, logLevel: 'error' })
    for (const svc of Object.values(doc?.services ?? {})) for (const p of svc?.profiles ?? []) out.add(String(p))
  }
  return out
}

const catalogueIds = () =>
  readdirSync(join(ROOT, 'modules'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      try {
        return JSON.parse(readFileSync(join(ROOT, 'modules', e.name, 'module.json'), 'utf8')).id
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

test('module profiles: every catalogue id is classified and nothing else is; pilot=false carries a reason and no profile', () => {
  const ids = catalogueIds()
  assert.ok(ids.length >= 10, `the guard sees ${ids.length} catalogue ids (${ids.join(', ')})`)
  assert.deepEqual(Object.keys(MAP.modules).sort(), ids)
  for (const [id, m] of Object.entries(MAP.modules)) {
    assert.equal(typeof m.pilot, 'boolean', `${id}: pilot`)
    assert.ok(Array.isArray(m.profiles) && Array.isArray(m.postRealm), `${id}: profiles and postRealm are lists`)
    assert.ok(String(m.reason ?? '').length > 20, `${id}: the reason is recorded`)
    if (!m.pilot) assert.deepEqual([...m.profiles, ...m.postRealm], [], `${id}: an off module renders no profile`)
    else assert.ok(m.profiles.length + m.postRealm.length > 0, `${id}: a pilot module asks for at least one profile`)
  }
  // the profile-rendering pilot set: sign-in modules and the six the plan's evidence names; finance, vault, board, elections, handover render no profile (board is selectable at create but needs none)
  const pilot = Object.entries(MAP.modules).filter(([, m]) => m.pilot).map(([id]) => id).sort()
  assert.deepEqual(pilot, ['calendar', 'content', 'files', 'messaging', 'publishing', 'votes'])
})

test('module profiles: board is selectable at create but needs no profile and no leaf (it runs in-process on kernel tables)', () => {
  const board = MAP.modules.board
  assert.deepEqual([board.profiles, board.postRealm], [[], []])
  assert.match(board.reason, /selectable at create/)
  assert.doesNotMatch(board.reason, /no isolation gate lift/)
})

test('module profiles: every named profile is known and defined by a compose file, and every module profile a compose file defines is known', () => {
  const defined = composeProfiles()
  const known = new Set(MAP.knownProfiles)
  assert.equal(known.size, MAP.knownProfiles.length, 'knownProfiles has no duplicate')
  const named = new Set(Object.values(MAP.modules).flatMap((m) => [...m.profiles, ...m.postRealm]))
  for (const p of named) assert.ok(known.has(p), `${p} is named by a module but not in knownProfiles`)
  for (const p of known) assert.ok(defined.has(p), `${p} is in knownProfiles but no compose file defines it`)
  const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  const moduleLevel = [...defined].filter((p) => !SYSTEM_PROFILES.has(p)).sort(byCodeUnit)
  assert.deepEqual(moduleLevel, [...known].sort(byCodeUnit),'knownProfiles is exactly the set of module-level profiles the compose files define')
  // the profiles the pilot actually starts exist in the compose files that name them
  for (const p of ['calendar', 'content', 'newsletter', 'nextcloud', 'collabora', 'video', 'messaging']) assert.ok(defined.has(p), p)
})

test('module profiles: the off modules\' profiles are never rendered, and the post-realm profile is never a pre-realm one', () => {
  const rendered = new Set(Object.values(MAP.modules).filter((m) => m.pilot).flatMap((m) => m.profiles))
  for (const off of ['board', 'finance', 'vault']) assert.ok(!rendered.has(off), `${off} is rendered`)
  assert.ok(!rendered.has('messaging'), 'messaging (messaging-postgres and matrix) is post-realm: only gremion-services wire adds it')
  assert.deepEqual(MAP.modules.messaging.postRealm, ['messaging'])
  assert.deepEqual(MAP.modules.messaging.profiles, ['video'])
  // finance and vault are the operator's "stay as they are": no profile, whichever way they are asked
  for (const id of ['finance', 'vault', 'board', 'elections', 'handover']) assert.equal(MAP.modules[id].pilot, false, id)
  // calendar, content and publishing run as leaves: the state server and the app leaf share one profile
  assert.deepEqual([MAP.modules.calendar.profiles, MAP.modules.content.profiles, MAP.modules.publishing.profiles], [['calendar'], ['content'], ['newsletter']])
})

test('module profiles: the env templates keep the bare production profile (profile names live in the map only)', () => {
  for (const t of ['state.env.tmpl', 'app.env.tmpl']) {
    const text = readFileSync(join(ROOT, 'infra/host/templates/env', t), 'utf8')
    const lines = text.split(/\r?\n/).filter((l) => l.startsWith('COMPOSE_PROFILES='))
    assert.deepEqual(lines, ['COMPOSE_PROFILES=production'], t)
  }
})
