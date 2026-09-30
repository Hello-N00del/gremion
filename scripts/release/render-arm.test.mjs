#!/usr/bin/env node
// node --test suite: the render arm of check-image-digests (TASK-048b, TRD-350
// on the RENDERED release; TRD-038/440 layering). The renderer is injected
// everywhere: no test here runs docker. The real renders run in the CLI
// (`node scripts/release/check-image-digests.mjs --render`, `make
// lint-image-digests`), where docker is a declared tool.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'

import {
  TEMPLATE_MAP,
  PINS_FIXTURE_DIR,
  RENDER_ENV,
  planRenders,
  judgeRenders,
  renderArm,
  dockerRender,
} from './lib/render.mjs'
import { REPO_ROOT } from '../verify/census/render.mjs'

const D = (c) => c.repeat(64)
const FP = 'ghcr.io/hello-n00del'
const codes = (ps) => [...new Set(ps.map((p) => p.code))].sort()
const TEMPLATES = ['app.env.tmpl', 'mail.env.tmpl', 'ops.env.tmpl', 'state.env.tmpl']
const DERIVED = { state: ['legal', 'vector', 'fallback'], app: ['gremion-ui', 'gremion-public', 'migrate', 'tenant-create'] }
const derive = (p) => DERIVED[p]

/** A clean render per plan id: every derived service by digest, no build. */
function goodRender(id) {
  const svc = (image) => ({ image })
  if (id === 'state') {
    return {
      services: {
        legal: svc(`${FP}/gremion-legal@sha256:${D('7')}`),
        vector: svc(`${FP}/gremion-vector@sha256:${D('8')}`),
        fallback: svc(`${FP}/gremion-fallback@sha256:${D('9')}`),
        // a third-party service beside the first-party ones; deliberately NOT a
        // postgres literal: check-postgres-major scans every tracked text file
        // and a fake digest here reads as digest drift / a split pin.
        nats: svc(`docker.io/library/nats:2.12@sha256:${D('a')}`),
      },
    }
  }
  if (id.startsWith('app-')) {
    return {
      services: {
        'gremion-ui': svc(`${FP}/gremion-ui@sha256:${D('1')}`),
        'gremion-public': svc(`${FP}/gremion-public@sha256:${D('2')}`),
        migrate: svc(`${FP}/gremion-migrate@sha256:${D('3')}`),
        'tenant-create': svc(`${FP}/gremion-migrate@sha256:${D('3')}`),
      },
    }
  }
  return { services: { [id]: svc(`docker.io/library/${id}@sha256:${D('b')}`) } }
}
const renderer = (mutate = (id, doc) => doc) => (plan) => ({ ok: true, doc: mutate(plan.id, goodRender(plan.id)) })
const arm = (opts = {}) => renderArm({ listTemplates: () => TEMPLATES, derive, render: renderer(), ...opts })

test('the committed templates map: state, app (blue and green), ops, mail -- five renders', () => {
  const { plans, problems } = planRenders()
  assert.deepEqual(problems, [])
  assert.deepEqual(plans.map((p) => p.id).sort(), ['app-blue', 'app-green', 'mail', 'ops', 'state'])
  assert.deepEqual(Object.keys(TEMPLATE_MAP).sort(), ['app', 'mail', 'ops', 'state'])
})

test('a clean set of renders passes', () => {
  const res = arm()
  assert.deepEqual(res.problems, [])
  assert.equal(res.renders, 5)
})

test('an unmapped template fails, naming it', () => {
  const res = arm({ listTemplates: () => [...TEMPLATES, 'extra.env.tmpl'] })
  assert.deepEqual(codes(res.problems), ['unmapped-template'])
  assert.match(res.problems[0].where, /extra\.env\.tmpl/)
})

test('an image by tag fails and names project/service', () => {
  const res = arm({ render: renderer((id, doc) => (id === 'state' ? { services: { ...doc.services, legal: { image: `${FP}/gremion-legal:dist-v1.2.3` } } } : doc)) })
  assert.deepEqual(codes(res.problems), ['unpinned'])
  assert.equal(res.problems[0].where, 'state/legal')
  const none = arm({ render: renderer((id, doc) => (id === 'ops' ? { services: { ops: {} } } : doc)) })
  assert.deepEqual(codes(none.problems), ['unpinned'])
  assert.equal(none.problems[0].where, 'ops/ops')
})

test('a first-party service that keeps build fails; a build outside the derived set is its own finding', () => {
  const kept = arm({ render: renderer((id, doc) => (id === 'app-green' ? { services: { ...doc.services, migrate: { ...doc.services.migrate, build: { context: '.' } } } } : doc)) })
  assert.deepEqual(codes(kept.problems), ['build-kept'])
  assert.equal(kept.problems[0].where, 'app-green/migrate')
  const underived = arm({ render: renderer((id, doc) => (id === 'state' ? { services: { ...doc.services, sneaky: { image: `${FP}/x@sha256:${D('c')}`, build: { context: './s' } } } } : doc)) })
  assert.deepEqual(codes(underived.problems), ['underived-build'])
})

test('zero renders or a render with zero services fails (no vacuous pass)', () => {
  assert.deepEqual(codes(arm({ listTemplates: () => [] }).problems), ['no-renders'])
  const empty = arm({ render: renderer((id, doc) => (id === 'mail' ? { services: {} } : doc)) })
  assert.deepEqual(codes(empty.problems), ['no-services'])
  const failed = arm({ render: (plan) => (plan.id === 'ops' ? { ok: false, detail: 'exited 15' } : { ok: true, doc: goodRender(plan.id) }) })
  assert.deepEqual(codes(failed.problems), ['render-failed'])
})

test('a derived build: service absent from its render fails (a profile left off drops migrate, tenant-create)', () => {
  const res = arm({
    render: renderer((id, doc) => {
      if (!id.startsWith('app-')) return doc
      const { migrate, 'tenant-create': tc, ...rest } = doc.services
      return { services: rest }
    }),
  })
  assert.deepEqual(codes(res.problems), ['derived-absent'])
  assert.deepEqual(res.problems.map((p) => p.where).sort(), ['app-blue/migrate', 'app-blue/tenant-create', 'app-green/migrate', 'app-green/tenant-create'])
})

test('STATE PURITY: the state render carrying an app service fails, naming it', () => {
  const res = arm({ render: renderer((id, doc) => (id === 'state' ? { services: { ...doc.services, 'gremion-ui': { image: `${FP}/gremion-ui@sha256:${D('1')}` } } } : doc)) })
  assert.deepEqual(codes(res.problems), ['state-purity'])
  assert.match(res.problems[0].message, /gremion-ui/)
})

test('argv: -f per COMPOSE_FILE entry, pins slot replaced by the emitted fixture, --project-directory, --env-file, never the dev override', () => {
  const { plans } = planRenders()
  const byId = Object.fromEntries(plans.map((p) => [p.id, p]))
  const files = (p) => p.argv.flatMap((a, i) => (a === '-f' ? [p.argv[i + 1]] : []))
  assert.deepEqual(files(byId.state).map((f) => basename(f)), ['docker-compose.yml', 'docker-compose.prod.yml', 'docker-compose.state-pins.yml'])
  assert.equal(files(byId.state)[2], join(REPO_ROOT, PINS_FIXTURE_DIR, 'docker-compose.state-pins.yml'))
  assert.equal(files(byId['app-blue'])[1], join(REPO_ROOT, PINS_FIXTURE_DIR, 'docker-compose.pins.yml'))
  for (const p of plans) {
    assert.equal(p.argv[p.argv.indexOf('--env-file') + 1], join(REPO_ROOT, RENDER_ENV), p.id)
    assert.ok(p.argv.includes('--project-directory'), p.id)
    assert.ok(!p.argv.some((a) => /override/.test(a)), `${p.id}: the dev override must never be passed`)
    assert.deepEqual(p.argv.slice(-3), ['config', '--format', 'json'])
  }
  const pname = (p) => p.argv[p.argv.indexOf('--project-name') + 1]
  assert.deepEqual(plans.map(pname).sort(), ['release-render-app-blue', 'release-render-app-green', 'release-render-mail', 'release-render-ops', 'release-render-state'])
  assert.equal(byId.ops.argv[byId.ops.argv.indexOf('--project-directory') + 1], join(REPO_ROOT, 'infra/host/ops'))
  assert.equal(byId.mail.argv[byId.mail.argv.indexOf('--project-directory') + 1], join(REPO_ROOT, 'infra/host/mail'))
  // an override (the tag-pinned reference) swaps the slot's file, nothing else
  const ref = planRenders({ pinsOverride: { 'docker-compose.state-pins.yml': join(REPO_ROOT, PINS_FIXTURE_DIR, 'docker-compose.pins.yml') } })
  const st = ref.plans.find((p) => p.id === 'state')
  assert.equal(files(st)[2], join(REPO_ROOT, PINS_FIXTURE_DIR, 'docker-compose.pins.yml'))
})

test('a pins slot with no emitted fixture, or a template without COMPOSE_FILE, fails the plan', () => {
  const read = (over) => (p) => (p.endsWith('state.env.tmpl') ? over : readFileSync(p, 'utf8'))
  const nofix = planRenders({ readText: read('COMPOSE_PROJECT_NAME=${STACK}-state\nCOMPOSE_FILE=docker-compose.yml:docker-compose.other-pins.yml\n') })
  assert.ok(nofix.problems.some((p) => p.code === 'no-pins-fixture' && /docker-compose\.other-pins\.yml/.test(p.message)), JSON.stringify(nofix.problems))
  const nokey = planRenders({ readText: read('X=1\n') })
  assert.ok(nokey.problems.some((p) => p.code === 'no-compose-file'), JSON.stringify(nokey.problems))
  const noname = planRenders({ readText: read('COMPOSE_FILE=docker-compose.yml\n') })
  assert.ok(noname.problems.some((p) => p.code === 'no-project-name'), JSON.stringify(noname.problems))
  const unexpanded = planRenders({ readText: read('COMPOSE_PROJECT_NAME=${NOPE}-state\nCOMPOSE_FILE=docker-compose.yml\n') })
  assert.ok(unexpanded.problems.some((p) => p.code === 'no-project-name'), JSON.stringify(unexpanded.problems))
})

test('env: no parent COMPOSE_* or interpolated variable, COMPOSE_PROFILES=*, COLOUR per colour; both colours rendered', () => {
  const saved = { ...process.env }
  Object.assign(process.env, { COMPOSE_FILE: 'nope.yml', COMPOSE_PROFILES: 'dev', COMPOSE_PROJECT_NAME: 'leak', STACK: 'leak', IMAGE_TAG: 'leak' })
  try {
    const { plans } = planRenders()
    for (const p of plans) {
      assert.equal(p.env.COMPOSE_PROFILES, '*', p.id)
      for (const k of ['COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'STACK', 'IMAGE_TAG']) assert.equal(p.env[k], undefined, `${p.id}: ${k} leaked`)
    }
    const colours = plans.filter((p) => p.id.startsWith('app-')).map((p) => p.env.COLOUR).sort()
    assert.deepEqual(colours, ['blue', 'green'])
    assert.equal(plans.find((p) => p.id === 'state').env.COLOUR, undefined)
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  }
})

test('missing docker is a failure, never a skip', () => {
  const { plans } = planRenders()
  const res = dockerRender(plans[0], { spawn: () => ({ error: Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }) }) })
  assert.equal(res.ok, false)
  assert.equal(res.toolMissing, 'docker')
  const arm2 = renderArm({ listTemplates: () => TEMPLATES, derive, render: (plan) => dockerRender(plan, { spawn: () => ({ error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }) }) })
  assert.ok(arm2.problems.length >= 5 && arm2.problems.every((p) => p.code === 'render-failed' && /docker not found/.test(p.message)), JSON.stringify(arm2.problems))
  // stdout that is not a compose document is a failed render
  const junk = dockerRender(plans[0], { spawn: () => ({ status: 0, stdout: 'not json', stderr: '' }) })
  assert.equal(junk.ok, false)
})

test('Q4: every *_IMAGE key in the render env equals the same key in its env template', () => {
  const env = readFileSync(join(REPO_ROOT, RENDER_ENV), 'utf8')
  const keys = env.split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+_IMAGE)=/)?.[1]).filter(Boolean)
  assert.ok(keys.length > 0, 'the render env declares no *_IMAGE key (STALWART_IMAGE expected)')
  const tmpls = TEMPLATES.map((t) => readFileSync(join(REPO_ROOT, 'infra/host/templates/env', t), 'utf8'))
  for (const k of keys) {
    const want = env.match(new RegExp(`^${k}=(.*)$`, 'm'))[1]
    const found = tmpls.map((t) => t.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]).filter(Boolean)
    assert.ok(found.length >= 1, `${k} is in no env template`)
    for (const f of found) assert.equal(f, want, `${k} drifted from its template`)
  }
})

test('r1: the state render seeds the git-ignored legal/legal.env EMPTY and exclusively (a fresh checkout renders)', () => {
  const { plans } = planRenders()
  const state = plans.find((p) => p.id === 'state')
  assert.deepEqual(state.seed, ['legal/legal.env'])
  const dir = mkdtempSync(join(tmpdir(), 't048b-seed-'))
  try {
    const res = dockerRender({ ...state, dir }, { spawn: () => ({ status: 0, stdout: '{"services":{"a":{}}}', stderr: '' }) })
    assert.equal(res.ok, true)
    assert.equal(readFileSync(join(dir, 'legal/legal.env'), 'utf8'), '')
    writeFileSync(join(dir, 'legal/legal.env'), 'KEEP=1\n')
    dockerRender({ ...state, dir }, { spawn: () => ({ status: 0, stdout: '{"services":{"a":{}}}', stderr: '' }) })
    assert.equal(readFileSync(join(dir, 'legal/legal.env'), 'utf8'), 'KEEP=1\n', 'an existing file is never overwritten')
    const ops = plans.find((p) => p.id === 'ops')
    assert.deepEqual(ops.seed, [])
    dockerRender({ ...ops, dir: join(dir, 'ops') }, { spawn: () => ({ status: 0, stdout: '{"services":{"a":{}}}', stderr: '' }) })
    assert.ok(!existsSync(join(dir, 'ops', 'legal')), 'only the state render seeds')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('r1: an app render carrying a derived STATE service fails (layers merged the other way)', () => {
  const res = arm({ render: renderer((id, doc) => (id === 'app-blue' ? { services: { ...doc.services, legal: { image: `${FP}/gremion-legal@sha256:${D('7')}` } } } : doc)) })
  assert.deepEqual(codes(res.problems), ['app-purity'])
  assert.equal(res.problems[0].where, 'app-blue/legal')
})

test('r1: a --render-pins override no pins slot consumes fails (a typo must not turn the RED reference GREEN)', () => {
  const res = arm({ pinsOverride: { 'docker-compose.state_pins.yml': join(REPO_ROOT, PINS_FIXTURE_DIR, 'docker-compose.pins.yml') } })
  assert.deepEqual(codes(res.problems), ['unused-override'])
  assert.match(res.problems[0].message, /docker-compose\.state_pins\.yml/)
})
