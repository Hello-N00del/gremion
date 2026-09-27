// TASK-036 TDD items 1-5: the census verdicts, judged on fixture renders with
// injected image-inspection results. No docker here.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyService, runCensus } from './census.mjs'

const HC = { test: ['CMD', 'true'], interval: '10s' }
const IMG_HC = { Test: ['CMD-SHELL', 'wget -qO- http://127.0.0.1/healthz'], Interval: 1e10 }
const img = (healthcheck = null) => ({ ok: true, healthcheck })
const imgFail = { ok: false, detail: 'Error: No such image: x' }

function project(name, services, extra = {}) {
  return { project: name, render: { project: name, ok: true, services }, exempt: [], notes: [], ...extra }
}

function census(projects, images = {}) {
  const imageMap = new Map()
  for (const p of projects) {
    for (const svc of Object.keys(p.render.services ?? {})) {
      const key = `${p.project}/${svc}`
      imageMap.set(key, key in images ? images[key] : img())
    }
  }
  return runCensus({ projects, images: imageMap })
}

test('1. every service probed by compose -> pass, one line per service', () => {
  const r = census([project('state', { a: { image: 'a', healthcheck: HC, restart: 'unless-stopped' }, b: { image: 'b', healthcheck: HC } })])
  assert.equal(r.unparseable, false)
  assert.equal(r.collected, 2)
  assert.equal(r.passed, 2)
  assert.equal(r.failed, 0)
  assert.deepEqual(r.lines, ['probed a (compose) [state]', 'probed b (compose) [state]'])
})

test('2. no healthcheck, disable:true, or ["NONE"] -> FAIL naming the service', () => {
  for (const { name, service } of [
    { name: 'bare', service: { image: 'x', restart: 'unless-stopped' } },
    { name: 'disabled', service: { image: 'x', healthcheck: { disable: true } } },
    { name: 'none', service: { image: 'x', healthcheck: { test: ['NONE'] } } },
  ]) {
    const r = census([project('state', { ok: { image: 'o', healthcheck: HC }, [name]: service })])
    assert.equal(r.failed, 1, name)
    assert.equal(r.passed, 1, name)
    assert.ok(r.lines.includes(`UNPROBED ${name} [state]`), `${name}: ${r.lines.join(' | ')}`)
  }
})

test('2b. compose disable:true over an image HEALTHCHECK is UNPROBED', () => {
  const r = census([project('state', { x: { image: 'x', healthcheck: { disable: true } } })], { 'state/x': img(IMG_HC) })
  assert.equal(r.failed, 1)
  assert.deepEqual(r.lines, ['UNPROBED x [state]'])
})

test('3. image arm: HEALTHCHECK -> probed (image); null or NONE -> UNPROBED', () => {
  const probed = census([project('ops', { cad: { image: 'c' } })], { 'ops/cad': img(IMG_HC) })
  assert.deepEqual(probed.lines, ['probed cad (image) [ops]'])
  assert.equal(probed.passed, 1)
  const inherits = census([project('ops', { cad: { image: 'c', healthcheck: { interval: '5s' } } })], { 'ops/cad': img(IMG_HC) })
  assert.deepEqual(inherits.lines, ['probed cad (image) [ops]'], 'a compose healthcheck without test inherits the image probe')
  const nul = census([project('ops', { ne: { image: 'n' } })], { 'ops/ne': img(null) })
  assert.deepEqual(nul.lines, ['UNPROBED ne [ops]'])
  const none = census([project('ops', { ne: { image: 'n' } })], { 'ops/ne': img({ Test: ['NONE'] }) })
  assert.deepEqual(none.lines, ['UNPROBED ne [ops]'])
})

test('3b. an image that could not be inspected is unparseable, even with a compose healthcheck', () => {
  const r = census([project('state', { a: { image: 'a', healthcheck: HC } })], { 'state/a': imgFail })
  assert.equal(r.unparseable, true)
  assert.match(r.problems.join('\n'), /image of a \[state\] could not be inspected/)
  const missing = runCensus({ projects: [project('state', { a: { image: 'a', healthcheck: HC } })], images: new Map() })
  assert.equal(missing.unparseable, true, 'no inspection result at all is never a pass')
})

test('4. vacuity: a project rendering {"services":{}} fails, even next to a healthy one', () => {
  const r = census([project('state', {}), project('ops', { a: { image: 'a', healthcheck: HC } })])
  assert.equal(r.unparseable, true)
  assert.match(r.problems.join('\n'), /state rendered 0 services/)
})

test('4b. vacuity: a failed render (non-zero exit or empty stdout) fails', () => {
  const failed = { project: 'mail', render: { project: 'mail', ok: false, detail: 'docker compose config exited 1: boom' }, exempt: [], notes: [] }
  const r = census([failed, project('ops', { a: { image: 'a', healthcheck: HC } })])
  assert.equal(r.unparseable, true)
  assert.match(r.problems.join('\n'), /mail: render failed: docker compose config exited 1/)
})

test('4c. vacuity: zero projects fails', () => {
  const r = runCensus({ projects: [], images: new Map() })
  assert.equal(r.unparseable, true)
  assert.match(r.problems.join('\n'), /no production project/)
})

test('4d. an allowed (dated-allowance) project contributes no services and no failure', () => {
  const allowed = { project: 'app', render: { project: 'app', ok: true, allowed: true, services: {} }, exempt: [], notes: ['app: absent -- dated allowance'] }
  const r = census([allowed, project('ops', { a: { image: 'a', healthcheck: HC } })])
  assert.equal(r.unparseable, false)
  assert.equal(r.collected, 1)
  assert.ok(r.lines.includes('app: absent -- dated allowance'))
})

test('5. exemptions: exact names, one-shots only, and each name must exist in its own project', () => {
  const oneShot = { image: 'm' }
  // exact match: minio-mc does not exempt minio-mc-x
  const sub = census([project('state', { 'minio-mc-x': { image: 'm' } }, { exempt: ['minio-mc'] })])
  assert.ok(sub.lines.includes('UNPROBED minio-mc-x [state]'), sub.lines.join(' | '))
  assert.equal(sub.failed, 2, 'the unprobed service and the stale exemption both fail')
  // a one-shot on the list is exempt
  const ok = census([project('state', { job: oneShot, ok2: { image: 'x', healthcheck: HC } }, { exempt: ['job'] })])
  assert.deepEqual(ok.lines, ['exempt job [state]', 'probed ok2 (compose) [state]'])
  assert.equal(ok.failed, 0)
  assert.equal(ok.passed, 2)
  // restart: "no" is still a one-shot
  assert.equal(census([project('state', { job: { image: 'm', restart: 'no' } }, { exempt: ['job'] })]).failed, 0)
  // a restarting service on the list fails
  const restarting = census([project('state', { job: { image: 'm', restart: 'unless-stopped' } }, { exempt: ['job'] })])
  assert.equal(restarting.failed, 1)
  assert.match(restarting.problems.join('\n'), /job \[state\] is exempt but restart: unless-stopped/)
  // a name absent from ITS project's render fails, even if another project has it
  const cross = census([project('state', { a: { image: 'a', healthcheck: HC } }, { exempt: ['job'] }), project('ops', { job: oneShot }, { exempt: ['job'] })])
  assert.match(cross.problems.join('\n'), /HEALTH_EXEMPT_SERVICES \(state\) names job, which state does not render/)
  // an empty list exempts nothing
  const none = census([project('state', { job: oneShot }, { exempt: [] })])
  assert.deepEqual(none.lines, ['UNPROBED job [state]'])
})

test('classifyService reports the probe source', () => {
  assert.equal(classifyService({ name: 'a', service: { healthcheck: HC }, image: img(IMG_HC), exempt: false }).via, 'compose')
  assert.equal(classifyService({ name: 'a', service: {}, image: img(IMG_HC), exempt: false }).via, 'image')
  assert.equal(classifyService({ name: 'a', service: {}, image: imgFail, exempt: false }).status, 'unparseable')
})
