// TASK-039-FU TDD 1, 2, 3 (static half): the weekly footprint's wiring.
//
//   1. every ops service carries `gremion.footprint: platform_overhead`
//      (TRD-203 second half: the ops containers are counted apart), on the
//      real render and on a copy with one label removed;
//   2. the weekly timer, the service unit and the seeded cron describe ONE
//      moment (Monday 03:00 UTC), and the service is a oneshot of footprint.sh
//      as the deploy user, in token form;
//   3. the names footprint.sh and metrics-textfile.sh hard-code (the Vector
//      volume, the messaging-postgres and postgres services) exist in the
//      state compose file, so a rename (TASK-033 may touch the Vector block)
//      fails HERE and names the line to update in both scripts.
//
// Every guard runs on the real tree (must be clean) and on one broken scratch
// copy per failure (must name it). The suite globs *.test.mjs; no registration.
//
//   node --test compose/observability/footprint.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PROJECTS, renderProject } from '../../scripts/check-pooled-stack.mjs'
import { OPS_SERVICES, readText } from './checks.mjs'

const OPS = PROJECTS.find((p) => p.id === 'ops')
const REAL = renderProject(OPS)
const clone = () => JSON.parse(JSON.stringify(REAL))

const TIMER = 'infra/host/templates/systemd/gremion-footprint.timer'
const SERVICE = 'infra/host/templates/systemd/gremion-footprint.service'
const MIGRATION = 'packages/tenant-store/src/lifecycle/platform-migrations/0005_plt_scheduled_job.sql'
const COMPOSE = 'docker-compose.yml'

// ── 1: the label ────────────────────────────────────────────────────────────

export function footprintLabelViolations(render) {
  const out = []
  const names = Object.keys(render?.services ?? {}).sort()
  if (names.length === 0) out.push('renders zero services -- the label check would pass vacuously')
  if (names.length && JSON.stringify(names) !== JSON.stringify([...OPS_SERVICES].sort())) out.push(`services [${names.join(', ')}], want [${OPS_SERVICES.join(', ')}]`)
  for (const [name, svc] of Object.entries(render?.services ?? {})) {
    const v = svc.labels?.['gremion.footprint']
    if (v !== 'platform_overhead') out.push(`ops/${name}: label gremion.footprint is ${JSON.stringify(v ?? null)}, want "platform_overhead"`)
  }
  return out
}

test('TDD 1: all six ops services carry gremion.footprint: platform_overhead', () => {
  assert.equal(Object.keys(REAL.services).length, 6)
  assert.deepEqual(footprintLabelViolations(REAL), [])
})

test('TDD 1 RED: one removed label, one renamed value and zero services each fail by name', () => {
  const r1 = clone()
  delete r1.services.loki.labels['gremion.footprint']
  assert.match(footprintLabelViolations(r1).join('\n'), /ops\/loki: label gremion\.footprint is null/)
  const r2 = clone()
  r2.services.grafana.labels['gremion.footprint'] = 'tenant'
  assert.match(footprintLabelViolations(r2).join('\n'), /ops\/grafana: label gremion\.footprint is "tenant"/)
  assert.match(footprintLabelViolations({ services: {} }).join('\n'), /renders zero services/)
})

// ── 2: the schedule, one moment ─────────────────────────────────────────────

const DAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 }

/** `OnCalendar=Mon *-*-* 03:00:00 UTC` -> { dow, hour, minute, second, tz }, or null when it is not that shape. */
export function parseOnCalendar(unit) {
  const m = /^OnCalendar=(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \*-\*-\* (\d\d):(\d\d):(\d\d) (UTC)$/m.exec(unit)
  return m ? { dow: DAYS[m[1]], hour: +m[2], minute: +m[3], second: +m[4], tz: m[5] } : null
}

/** The seeded cron of the footprint_measurement row -> { minute, hour, dow } for a weekly `m h * * d`, or null. */
export function seededCron(sql) {
  const m = /VALUES \('platform', 'footprint_measurement', '(\d+) (\d+) \* \* ([0-6])'/.exec(sql)
  return m ? { minute: +m[1], hour: +m[2], dow: +m[3] } : null
}

export function scheduleViolations({ timer, service, migration }) {
  const out = []
  const cal = parseOnCalendar(timer)
  if (!cal) out.push('timer: OnCalendar is not "<Day> *-*-* HH:MM:SS UTC" (weekly would fire 00:00 local and disagree with the seeded cron)')
  if (!/^Persistent=true$/m.test(timer)) out.push('timer: Persistent=true is missing (a host that was down at the moment must still record)')
  if (!/^Unit=gremion-footprint\.service$/m.test(timer)) out.push('timer: Unit= is not gremion-footprint.service')
  const cron = seededCron(migration)
  if (!cron) out.push('migration: the seeded footprint_measurement cron is not a weekly "m h * * d" literal')
  if (cal && cron && (cal.dow !== cron.dow || cal.hour !== cron.hour || cal.minute !== cron.minute || cal.second !== 0 || cal.tz !== 'UTC')) {
    out.push(`timer (${JSON.stringify(cal)}) and the seeded cron (${JSON.stringify(cron)}) are not the same moment`)
  }
  if (!/^Type=oneshot$/m.test(service)) out.push('service: Type=oneshot is missing')
  if (!/^User=\$\{DEPLOY_USER\}$/m.test(service)) out.push('service: User=${DEPLOY_USER} is missing')
  if (!/^SupplementaryGroups=docker$/m.test(service)) out.push('service: SupplementaryGroups=docker is missing')
  if (!/^Environment=GREMION_ROOT=\$\{GREMION_ROOT\}$/m.test(service)) out.push('service: Environment=GREMION_ROOT=${GREMION_ROOT} is missing')
  if (!/^ExecStart=\$\{GREMION_ROOT\}\/current\/infra\/host\/ops\/footprint\.sh$/m.test(service)) out.push('service: ExecStart is not ${GREMION_ROOT}/current/infra/host/ops/footprint.sh')
  if (/\/opt\/gremion/.test(service)) out.push('service: a literal /opt/gremion (the unit is rendered in token form)')
  const t = /^TimeoutStartSec=(\d+)$/m.exec(service)
  if (!t || +t[1] > 220) out.push('service: TimeoutStartSec is missing or above 220 s (a stuck call must die inside the 4-minute rule)')
  return out
}

test('TDD 2: the timer, the service and the seeded cron are one moment, Monday 03:00 UTC, in token form', () => {
  const input = { timer: readText(TIMER), service: readText(SERVICE), migration: readText(MIGRATION) }
  assert.deepEqual(scheduleViolations(input), [])
  assert.deepEqual(parseOnCalendar(input.timer), { dow: 1, hour: 3, minute: 0, second: 0, tz: 'UTC' })
  assert.deepEqual(seededCron(input.migration), { minute: 0, hour: 3, dow: 1 })
})

test('TDD 2 RED: OnCalendar=weekly, a changed seed cron, a lost Persistent and a literal root each fail by name', () => {
  const base = { timer: readText(TIMER), service: readText(SERVICE), migration: readText(MIGRATION) }
  const fails = (mutate, re) => {
    const i = { ...base }
    mutate(i)
    assert.match(scheduleViolations(i).join('\n'), re)
  }
  fails((i) => (i.timer = i.timer.replace(/^OnCalendar=.*$/m, 'OnCalendar=weekly')), /OnCalendar is not/)
  fails((i) => (i.timer = i.timer.replace('03:00:00 UTC', '04:00:00 UTC')), /not the same moment/)
  // the seed is the VALUES literal, not the lead comment that also quotes the cron
  const seedLiteral = /(VALUES \('platform', 'footprint_measurement', )'0 3 \* \* 1'/
  assert.match(base.migration, seedLiteral)
  fails((i) => (i.migration = i.migration.replace(seedLiteral, "$1'0 0 * * 1'")), /not the same moment/)
  fails((i) => (i.migration = i.migration.replace(seedLiteral, "$1'0 3 * * *'")), /not a weekly/)
  fails((i) => (i.timer = i.timer.replace(/^Persistent=true$/m, '')), /Persistent=true is missing/)
  fails((i) => (i.service = i.service.replace(/^ExecStart=\$\{GREMION_ROOT\}/m, 'ExecStart=/opt/gremion')), /ExecStart is not/)
  fails((i) => (i.service = i.service.replace(/^Type=oneshot$/m, 'Type=simple')), /Type=oneshot is missing/)
  fails((i) => (i.service = i.service.replace(/^TimeoutStartSec=.*$/m, '')), /TimeoutStartSec is missing/)
})

// ── 3: the names the scripts hard-code ──────────────────────────────────────

/** Top-level keys of a compose section, read as text: the 2-space-indented `name:` lines under `<section>:`. */
export function composeKeys(text, section) {
  const keys = new Set()
  let inside = false
  for (const line of text.split('\n')) {
    if (/^[a-z][a-z-]*:/.test(line)) inside = line.startsWith(`${section}:`)
    else if (inside) {
      const m = /^ {2}([A-Za-z0-9_.-]+):/.exec(line)
      if (m) keys.add(m[1])
    }
  }
  return keys
}

/** The service and volume names the two host scripts hard-code, pulled out of the scripts themselves. */
export function hardCodedNames(footprintSh, metricsSh) {
  const services = new Set()
  const volumes = new Set()
  // state_container and state_container_strict (ops-lib.sh) both name a compose service
  for (const m of footprintSh.matchAll(/state_container(?:_strict)? ([a-z][a-z-]*)/g)) services.add(m[1])
  for (const m of metricsSh.matchAll(/state_container(?:_strict)? ([a-z][a-z-]*)/g)) services.add(m[1])
  for (const m of footprintSh.matchAll(/\$\{STACK_NAME\}-state_([a-z][a-z-]*)/g)) volumes.add(m[1])
  for (const m of metricsSh.matchAll(/endswith\("([a-z][a-z-]*)"\)/g)) volumes.add(m[1])
  return { services, volumes }
}

export function driftViolations(composeText, footprintSh, metricsSh) {
  const out = []
  const services = composeKeys(composeText, 'services')
  const volumes = composeKeys(composeText, 'volumes')
  const names = hardCodedNames(footprintSh, metricsSh)
  if (names.services.size === 0 || names.volumes.size === 0) out.push('found no hard-coded service or volume name in the scripts -- the drift guard would pass vacuously')
  for (const s of names.services) {
    if (!services.has(s)) out.push(`service "${s}" (state_container in infra/host/ops/footprint.sh or metrics-textfile.sh) is not a services: key of ${COMPOSE}; update both scripts`)
  }
  for (const v of names.volumes) {
    // metrics-textfile.sh matches the suffix "pg-data"; footprint.sh names the Vector volume whole
    if (v === 'pg-data') {
      if (![...volumes].some((k) => k.endsWith('pg-data'))) out.push(`no volume ending in pg-data in ${COMPOSE}; metrics-textfile.sh tracks them by that suffix`)
    } else if (!volumes.has(v)) out.push(`volume "${v}" (infra/host/ops/footprint.sh or metrics-textfile.sh) is not a volumes: key of ${COMPOSE}; update both scripts`)
  }
  return out
}

test('TDD 3: the Vector volume and the postgres services the host scripts hard-code exist in docker-compose.yml', () => {
  const compose = readText(COMPOSE)
  const names = hardCodedNames(readText('infra/host/ops/footprint.sh'), readText('infra/host/ops/metrics-textfile.sh'))
  assert.ok(names.services.has('messaging-postgres') && names.services.has('postgres'), `scripts name services ${[...names.services].join(', ')}`)
  assert.ok(names.volumes.has('vector-processed-logs'), `scripts name volumes ${[...names.volumes].join(', ')}`)
  assert.deepEqual(driftViolations(compose, readText('infra/host/ops/footprint.sh'), readText('infra/host/ops/metrics-textfile.sh')), [])
})

test('TDD 3 RED: a renamed Vector volume and a renamed messaging-postgres service each fail naming the name', () => {
  const compose = readText(COMPOSE)
  const f = readText('infra/host/ops/footprint.sh')
  const m = readText('infra/host/ops/metrics-textfile.sh')
  const renamedVolume = compose.replace(/^ {2}vector-processed-logs:/m, '  vector-logs:')
  assert.notEqual(renamedVolume, compose, 'the scratch copy must differ from the real file')
  assert.match(driftViolations(renamedVolume, f, m).join('\n'), /volume "vector-processed-logs" .* is not a volumes: key/)
  const renamedService = compose.replace(/^ {2}messaging-postgres:/m, '  messaging-db:')
  assert.notEqual(renamedService, compose)
  assert.match(driftViolations(renamedService, f, m).join('\n'), /service "messaging-postgres" .* is not a services: key/)
  assert.match(driftViolations(compose, 'echo hi', 'echo hi').join('\n'), /pass vacuously/)
})
