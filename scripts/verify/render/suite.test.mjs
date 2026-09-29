// TASK-053: the render-guards suite end to end over an INJECTED renderer (the
// real `docker compose config` runs only when verify runs the suite).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { evaluateSuite } from '../lib/guard.mjs'
import { APP_ENV_TEMPLATE } from './colour-suffix.mjs'
import { RELEASE_PINS_FIXTURE, RELEASE_UI_IMAGE } from './harness.mjs'
import { GUARD_IDS, runRenderGuardsSuite } from './suite.mjs'

const P = 'ghcr.io/hello-n00del/gremion-'
const build = { context: '.' }

function appServices(colour, released) {
  const env = (extra = {}) => ({ COLOUR: colour, ...extra })
  return {
    'gremion-ui': released
      ? { image: RELEASE_UI_IMAGE, environment: env({ INTERNAL_BASE_URL: `http://gremion-ui-${colour}:3000`, LEGAL_URL: 'http://legal:3000' }) }
      : { image: `${P}ui:dist`, build, environment: env() },
    'gremion-public': { image: `${P}public@sha256:2222`, environment: env() },
    migrate: { image: `${P}migrate@sha256:3333`, environment: env() },
    'tenant-create': { image: `${P}migrate:dist`, build, environment: env() },
  }
}

/** Reacts to COMPOSE_FILE like compose: the release fixture pins gremion-ui. */
function fakeRender(p, { env = {} } = {}) {
  if (p.colour) return { services: appServices(p.colour, String(env.COMPOSE_FILE ?? '').includes(RELEASE_PINS_FIXTURE)) }
  if (p.id === 'state') {
    return {
      services: {
        postgres: { image: 'postgres:18' },
        legal: { image: `${P}legal:dist`, build },
        vector: { image: `${P}vector:dist`, build },
        fallback: { image: `${P}fallback:dist`, build },
      },
    }
  }
  return { services: { [`${p.id}-svc`]: { image: 'third/party:1' } } }
}

const quiet = () => {}
const suite = (opts = {}) => runRenderGuardsSuite({ render: fakeRender, toolAvailableFn: () => true, log: quiet, ...opts })

test('the suite is green over a conforming stack, one check per (guard, project)', () => {
  const out = suite()
  assert.equal(out.failed, 0, out.detail)
  // harness 5 + drift 5 + colour 3 (blue, green, template) + build 3 (state, blue, green)
  assert.equal(out.collected, 16)
  assert.equal(evaluateSuite(out).status, 'pass')
  assert.match(out.detail, /build-absence state: judged 0, allowance 3 \(first-party 3\)/)
  assert.match(out.detail, /build-absence app-blue: judged 3, allowance 1/)
})

test('state renders never contribute names: legal referenced from the app tier passes', () => {
  const out = suite()
  assert.doesNotMatch(out.detail, /(derived|judged) app-tier names[^\n]*\blegal\b/)
  assert.equal(out.failed, 0, out.detail)
})

test('the seeded defect fails naming gremion-ui, KERNEL_API_URL and kernel-api (known only by image)', () => {
  const seeded = (p, o) => {
    const r = fakeRender(p, o)
    if (p.colour) {
      r.services['kernel-api'] = { image: `${P}kernel-api:dist`, environment: { COLOUR: p.colour } }
      r.services['gremion-ui'].environment.KERNEL_API_URL = 'http://kernel-api:3000'
    }
    return r
  }
  const out = suite({ render: seeded })
  assert.equal(evaluateSuite(out).status, 'fail')
  assert.match(out.detail, /FAIL colour-suffix: app-blue\/gremion-ui: environment\.KERNEL_API_URL names kernel-api without the -blue suffix/)
  assert.match(out.detail, /FAIL colour-suffix: app-green\/gremion-ui: environment\.KERNEL_API_URL names kernel-api without the -green suffix/)
})

test('the suite judges TASK-040 APP_SERVICES + LEAF_SERVICES too: a leaf missing from the template is still a derived name', () => {
  // The template here names no leaf at all, so only the forwarded pooled-stack
  // lists can know files-service (r2, 2026-09-29: the same union G2 uses).
  const templateText = 'INTERNAL_BASE_URL=http://gremion-ui-${COLOUR}:3000\n'
  const leaky = (p, o) => {
    const r = fakeRender(p, o)
    if (p.colour) r.services['gremion-ui'].environment.FILES_URL = 'http://files-service:8080'
    return r
  }
  const out = suite({ render: leaky, templateText })
  assert.match(out.detail, /judged app-tier names[^\n]*\bfiles-service\b/)
  assert.doesNotMatch(out.detail, /derived app-tier names[^\n]*\bfiles-service\b/)
  assert.match(out.detail, /FAIL colour-suffix: app-blue\/gremion-ui: environment\.FILES_URL names files-service without the -blue suffix/)
  assert.equal(evaluateSuite(out).status, 'fail')
})

test('suite path: an empty derivation is vacuous even though the 13 hand-listed extras are passed (r3, 2026-09-29)', () => {
  // Prefix drift on every service but the pinned gremion-ui (the swap
  // post-condition keeps that one) plus an empty template read: 1 derived name.
  const drifted = (p, o) => {
    const r = fakeRender(p, o)
    if (p.colour) for (const n of ['gremion-public', 'migrate', 'tenant-create']) r.services[n].image = `ghcr.io/elsewhere/${n}:x`
    return r
  }
  const out = suite({ render: drifted, templateText: '' })
  assert.match(out.detail, /FAIL colour-suffix: colour-suffix: only 1 app-tier name\(s\) derived \(gremion-ui\); fewer than 3 is vacuous/)
  assert.equal(evaluateSuite(out).status, 'fail')
})

test('the real template with an unsuffixed CONTENT_SERVICE_URL fails the suite at app.env.tmpl:39', () => {
  const templateText = readFileSync(APP_ENV_TEMPLATE, 'utf8').replace('http://content-service-${COLOUR}:8080', 'http://content-service:8080')
  const out = suite({ templateText })
  assert.match(out.detail, /FAIL colour-suffix: app\.env\.tmpl:39: CONTENT_SERVICE_URL names content-service without the -\$\{COLOUR\} suffix/)
  assert.equal(evaluateSuite(out).status, 'fail')
})

test('missing docker is toolMissing and renders nothing', () => {
  let rendered = 0
  const out = suite({ toolAvailableFn: () => false, render: (...a) => (rendered++, fakeRender(...a)) })
  assert.equal(out.toolMissing, 'docker')
  assert.equal(rendered, 0)
  assert.equal(evaluateSuite(out).reason, 'missing tool: docker')
})

test('docker that cannot be run mid-render is toolMissing', () => {
  const out = suite({
    render: () => {
      throw new Error('docker could not be run: ENOENT')
    },
  })
  assert.equal(out.toolMissing, 'docker')
})

test('a thrown render is unparseable, naming the project -- never a pass', () => {
  const out = suite({
    render: (p, o) => {
      if (p.id === 'state') throw new Error('docker compose config refused (exit 1): boom')
      return fakeRender(p, o)
    },
  })
  assert.equal(out.unparseable, true)
  assert.match(out.detail, /state: render failed/)
  assert.equal(evaluateSuite(out).status, 'fail')
})

test('0 projects is unparseable', () => {
  const out = suite({ projects: [] })
  assert.equal(out.unparseable, true)
  assert.equal(evaluateSuite(out).status, 'fail')
})

test('an unpinned app render (the swap did not take) is unparseable, not judged green', () => {
  const out = suite({ render: (p, o) => fakeRender(p, { ...o, env: {} }) })
  assert.equal(out.unparseable, true)
  assert.match(out.detail, /the pins swap did not take/)
})

test('a malformed allowances.json is unparseable', () => {
  const out = suite({
    loadAllowancesFn: () => {
      throw new Error('allowances.json: no "rows" array')
    },
  })
  assert.equal(out.unparseable, true)
})

test('a missing colour fails the colour-suffix guard (both colours are judged)', () => {
  const blueOnly = [
    { id: 'state', envFile: 'test/host/fixtures/pooled-stack/state.env', cwd: '.' },
    { id: 'app-blue', colour: 'blue', envFile: 'test/host/fixtures/pooled-stack/app-blue.env', cwd: '.' },
  ]
  const out = suite({ projects: blueOnly })
  assert.match(out.detail, /no app render for green/)
  assert.equal(evaluateSuite(out).status, 'fail')
})

test('the runner is synchronous and the guard ids are exported (>= 5)', () => {
  assert.notEqual(runRenderGuardsSuite.constructor.name, 'AsyncFunction')
  assert.ok(GUARD_IDS.length >= 5)
  assert.ok(GUARD_IDS.includes('G-053-colour-suffix'))
})
