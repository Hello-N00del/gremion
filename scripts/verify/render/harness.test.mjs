// TASK-053: the render harness. The renderer is INJECTED (these files also run
// in verify's `unit` suite); a fake renderer stands in for `docker compose
// config` and reacts to COMPOSE_FILE the way compose does: the release pins
// fixture resets gremion-ui's build and pins its digest, and layered over the
// state project it adds the three services it names (phantoms).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { APP_SERVICES, PROJECTS } from '../../check-pooled-stack.mjs'
import { HarnessError, RELEASE_PINS_FIXTURE, RELEASE_UI_IMAGE, renderAll, renderEnvFor, swappedComposeFile, SWAP_PINS } from './harness.mjs'

function fakeRender(p, { env = {} } = {}) {
  const released = String(env.COMPOSE_FILE ?? '').includes(RELEASE_PINS_FIXTURE)
  if (p.id.startsWith('app-')) {
    const ui = released ? { image: RELEASE_UI_IMAGE } : { image: 'ghcr.io/hello-n00del/gremion-ui:dist-v0.0.0', build: { context: '.' } }
    return { services: { 'gremion-ui': ui, 'gremion-public': { image: 'ghcr.io/hello-n00del/gremion-public:x' } } }
  }
  const services = { postgres: { image: 'postgres:18' } }
  if (released) for (const s of ['gremion-ui', 'gremion-public', 'migrate']) services[s] = { image: `ghcr.io/hello-n00del/gremion-${s}:x` }
  return { services }
}

function capture(render = fakeRender) {
  const calls = []
  const wrapped = (p, opts) => {
    calls.push({ id: p.id, env: opts?.env })
    return render(p, opts)
  }
  return { calls, wrapped }
}

const kindOf = (fn) => {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof HarnessError, `not a HarnessError: ${err}`)
    return { kind: err.kind, message: err.message }
  }
  assert.fail('the harness did not refuse')
}

test('renders every TASK-040 project once and returns {project -> render} plus counts', () => {
  const { calls, wrapped } = capture()
  const out = renderAll({ render: wrapped })
  assert.deepEqual(calls.map((c) => c.id), PROJECTS.map((p) => p.id))
  assert.deepEqual(Object.keys(out.renders), ['state', 'app-blue', 'app-green', 'ops', 'mail'])
  assert.equal(out.counts['app-blue'], 2)
  assert.equal(out.counts.state, 1)
})

test('0 projects is unparseable, never an empty pass', () => {
  const r = kindOf(() => renderAll({ projects: [], render: fakeRender }))
  assert.equal(r.kind, 'unparseable')
  assert.match(r.message, /0 projects/)
})

test('a project rendering {"services":{}} is unparseable, naming it', () => {
  const r = kindOf(() => renderAll({ render: (p, o) => (p.id === 'ops' ? { services: {} } : fakeRender(p, o)) }))
  assert.equal(r.kind, 'unparseable')
  assert.match(r.message, /ops: renders zero services/)
})

test('a thrown render is unparseable, naming the project', () => {
  const r = kindOf(() =>
    renderAll({
      render: (p, o) => {
        if (p.id === 'mail') throw new Error('docker compose config refused (exit 15): required variable X')
        return fakeRender(p, o)
      },
    }),
  )
  assert.equal(r.kind, 'unparseable')
  assert.match(r.message, /^mail: render failed: docker compose config refused/)
})

test('docker that cannot be run is toolMissing, never a skip', () => {
  const r = kindOf(() =>
    renderAll({
      render: () => {
        throw new Error('docker could not be run: spawnSync docker ENOENT')
      },
    }),
  )
  assert.equal(r.kind, 'toolMissing')
})

test('a renderer returning a Promise is refused (verify is synchronous)', () => {
  const r = kindOf(() => renderAll({ render: async (p, o) => fakeRender(p, o) }))
  assert.equal(r.kind, 'unparseable')
  assert.match(r.message, /returned a Promise/)
})

test('the pins swap is app-only and carries COMPOSE_PATH_SEPARATOR ":"', () => {
  const { calls, wrapped } = capture()
  renderAll({ render: wrapped })
  const byId = Object.fromEntries(calls.map((c) => [c.id, c.env]))
  for (const id of ['app-blue', 'app-green']) {
    assert.equal(byId[id].COMPOSE_PATH_SEPARATOR, ':')
    assert.equal(byId[id].COMPOSE_FILE, `docker-compose.app.yml:${RELEASE_PINS_FIXTURE}`)
  }
  for (const id of ['state', 'ops', 'mail']) assert.deepEqual(byId[id], {}, `${id} keeps TASK-040's own pins`)
  assert.deepEqual(Object.keys(SWAP_PINS).sort(), ['app-blue', 'app-green'])
})

test('the swapped app render has no gremion-ui build and carries the fixture digest (post-condition)', () => {
  const out = renderAll({ render: fakeRender })
  for (const id of ['app-blue', 'app-green']) {
    const ui = out.renders[id].services['gremion-ui']
    assert.equal(ui.build, undefined)
    assert.equal(ui.image, RELEASE_UI_IMAGE)
  }
  // A renderer that ignored the swap (build survives, tag not digest) fails.
  const r = kindOf(() => renderAll({ render: (p, o) => fakeRender(p, { ...o, env: {} }) }))
  assert.equal(r.kind, 'unparseable')
  assert.match(r.message, /app-blue: the pins swap did not take -- gremion-ui still renders a build: key/)
  assert.match(r.message, /want the fixture digest/)
})

test('the state render contains no APP_SERVICES entry; swapping pins for state is caught as phantoms', () => {
  const out = renderAll({ render: fakeRender })
  for (const s of APP_SERVICES) assert.equal(out.renders.state.services[s], undefined, s)
  const r = kindOf(() => renderAll({ render: fakeRender, swap: { ...SWAP_PINS, state: RELEASE_PINS_FIXTURE } }))
  assert.match(r.message, /state: carries the app-tier service gremion-ui \(a pins layer added a phantom service\)/)
})

test('a parent COMPOSE_PROFILES=dev (or COMPOSE_FILE) changes nothing the harness passes', () => {
  const saved = { p: process.env.COMPOSE_PROFILES, f: process.env.COMPOSE_FILE }
  process.env.COMPOSE_PROFILES = 'dev'
  process.env.COMPOSE_FILE = 'docker-compose.app.dev.yml'
  try {
    const { calls, wrapped } = capture()
    renderAll({ render: wrapped })
    for (const c of calls) {
      assert.equal(c.env.COMPOSE_PROFILES, undefined, `${c.id}: renderProject's COMPOSE_PROFILES='*' must win`)
      if (c.env.COMPOSE_FILE) assert.doesNotMatch(c.env.COMPOSE_FILE, /dev/)
    }
  } finally {
    if (saved.p === undefined) delete process.env.COMPOSE_PROFILES
    else process.env.COMPOSE_PROFILES = saved.p
    if (saved.f === undefined) delete process.env.COMPOSE_FILE
    else process.env.COMPOSE_FILE = saved.f
  }
})

test('swappedComposeFile replaces the pins slot by basename and refuses a list without one', () => {
  assert.equal(swappedComposeFile('a.yml:x/docker-compose.state-pins.yml', 'P'), 'a.yml:P')
  assert.throws(() => swappedComposeFile('docker-compose.app.yml', 'P'), /no pins slot/)
  assert.deepEqual(renderEnvFor({ id: 'ops', envFile: 'x' }), {})
})
