#!/usr/bin/env node
// node --test suite for the Traefik stack-scope guard (incident 2026-10-29).
//
// Fixture trees prove the guard refuses the exact defect it exists for (a routed
// container with no org.gremion.stack label, a docker provider with no
// constraint); the real-tree tests then hold the repository to it, and name the
// routed services that MUST be seen so a parser that dropped a file cannot pass
// vacuously. The render tests read the deployed topology (`docker compose
// config`) for two different STACK values.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { checkStackScope, labelMap, isRouted, CONSTRAINT, KERNEL_ROOT } from './check-traefik-stack-scope.mjs'
import { renderState } from './compose-edge.mjs'

const GOOD_TRAEFIK_YML = `providers:\n  docker:\n    endpoint: "tcp://docker-socket-proxy:2375"\n    exposedByDefault: false\n    constraints: "${CONSTRAINT}"\n`
const GOOD_STATE = 'services:\n  traefik:\n    environment:\n      STACK: ${STACK:?STACK required}\n    command:\n      - >-\n        sed -e "s|@STACK@|x|g" a > b\n'
const LABELLED_LEGAL = 'services:\n  legal:\n    labels:\n      - "traefik.enable=true"\n      - "org.gremion.stack=s"\n'

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'tr-stack-'))
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('refuses a routed service (list labels, traefik.enable=true) with no org.gremion.stack label', () => {
  const t = tree({
    'docker/traefik/traefik.yml': GOOD_TRAEFIK_YML,
    'docker-compose.yml': GOOD_STATE,
    'docker-compose.prod.yml': 'services:\n  legal:\n    labels:\n      - "traefik.enable=true"\n      - "traefik.http.services.legal.loadbalancer.server.port=8080"\n',
  })
  try {
    const r = checkStackScope(t.root)
    assert.equal(r.problems.length, 1)
    assert.match(r.problems[0], /docker-compose\.prod\.yml: service 'legal' .*no org\.gremion\.stack label/)
  } finally {
    t.cleanup()
  }
})

test('refuses a map-form service that declares only traefik.http.* (no traefik.enable) and one with an empty label value', () => {
  const t = tree({
    'docker/traefik/traefik.yml': GOOD_TRAEFIK_YML,
    'docker-compose.yml': GOOD_STATE,
    'test/host/fixtures/x/docker-compose.prod.yml':
      'services:\n  a:\n    labels:\n      traefik.http.routers.a.rule: "Host(`a`)"\n  b:\n    labels:\n      traefik.enable: "true"\n      org.gremion.stack: ""\n',
  })
  try {
    const r = checkStackScope(t.root)
    assert.equal(r.problems.length, 2)
    assert.match(r.problems[0], /service 'a'/)
    assert.match(r.problems[1], /service 'b'/)
  } finally {
    t.cleanup()
  }
})

test('passes labelled services (both label forms) and unlabelled traefik.enable=false services', () => {
  const t = tree({
    'docker/traefik/traefik.yml': GOOD_TRAEFIK_YML,
    'docker-compose.yml': GOOD_STATE,
    'docker-compose.prod.yml': 'services:\n  legal:\n    labels:\n      - "traefik.enable=true"\n      - "org.gremion.stack=${STACK:?STACK required}"\n',
    'compose/control-panel/standalone.yml':
      'services:\n  panel:\n    labels:\n      traefik.enable: "true"\n      org.gremion.stack: "${PANEL_STACK:?PANEL_STACK required}"\n',
    'docker-compose.app.yml': 'services:\n  ui:\n    labels:\n      traefik.enable: "false"\n',
  })
  try {
    const r = checkStackScope(t.root)
    assert.deepEqual(r.problems, [])
    assert.equal(r.routed.length, 2)
  } finally {
    t.cleanup()
  }
})

test('refuses a traefik.yml whose docker provider has no constraint, or the wrong one', () => {
  for (const yml of [
    'providers:\n  docker:\n    exposedByDefault: false\n',
    'providers:\n  docker:\n    constraints: "Label(`org.gremion.stack`,`fixed`)"\n',
  ]) {
    const t = tree({ 'docker/traefik/traefik.yml': yml, 'docker-compose.yml': GOOD_STATE, 'docker-compose.prod.yml': LABELLED_LEGAL })
    try {
      const r = checkStackScope(t.root)
      assert.equal(r.problems.length, 1)
      assert.match(r.problems[0], /providers\.docker\.constraints/)
    } finally {
      t.cleanup()
    }
  }
})

test('refuses a state composition whose traefik service has no STACK source or no @STACK@ sed expression', () => {
  const t = tree({
    'docker/traefik/traefik.yml': GOOD_TRAEFIK_YML,
    'docker-compose.yml': 'services:\n  traefik:\n    environment:\n      ACME_EMAIL: x\n    command:\n      - sed -e "s|@ACME_EMAIL@|x|g" a > b\n',
    'docker-compose.prod.yml': LABELLED_LEGAL,
  })
  try {
    const r = checkStackScope(t.root)
    assert.equal(r.problems.length, 2)
    assert.match(r.problems.join('\n'), /does not pass STACK/)
    assert.match(r.problems.join('\n'), /no sed expression for @STACK@/)
  } finally {
    t.cleanup()
  }
})

test('refuses to pass over zero compose files or zero routed services', () => {
  const none = tree({ 'docker/traefik/traefik.yml': GOOD_TRAEFIK_YML })
  const unrouted = tree({ 'docker/traefik/traefik.yml': GOOD_TRAEFIK_YML, 'docker-compose.yml': GOOD_STATE })
  try {
    assert.match(checkStackScope(none.root).problems.join('\n'), /no compose file found/)
    assert.match(checkStackScope(unrouted.root).problems.join('\n'), /no routed service found/)
  } finally {
    none.cleanup()
    unrouted.cleanup()
  }
})

test('labelMap and isRouted read both label forms', () => {
  assert.deepEqual(labelMap(['a=b=c', 'x']), { a: 'b=c', x: '' })
  assert.deepEqual(labelMap({ a: true, b: null }), { a: 'true', b: '' })
  assert.equal(isRouted({ 'traefik.enable': 'true' }), true)
  assert.equal(isRouted({ 'traefik.enable': 'false' }), false)
  assert.equal(isRouted({ 'traefik.http.middlewares.m.headers.x': '1' }), true)
  assert.equal(isRouted({ 'org.gremion.postgres': 'kernel' }), false)
})

test('the repository: every routed service in every compose file carries org.gremion.stack, and the docker provider is constrained', () => {
  const r = checkStackScope(KERNEL_ROOT)
  assert.deepEqual(r.problems, [])
})

test('the repository: the guard SEES the services that matter (a parser that drops a file cannot pass vacuously)', () => {
  const r = checkStackScope(KERNEL_ROOT)
  const seen = new Set(r.routed.map((x) => `${x.file}#${x.service}`))
  for (const want of [
    'docker-compose.prod.yml#keycloak',
    'docker-compose.prod.yml#legal',
    'docker-compose.prod.yml#traefik',
    'docker-compose.prod.yml#fallback',
    'compose/control-panel/standalone.yml#control-panel',
    'docker-compose.override.yml#keycloak',
    'test/host/fixtures/edge-proto/docker-compose.yml#traefik',
  ]) {
    assert.ok(seen.has(want), `routed service ${want} was not collected; saw ${[...seen].join(', ')}`)
  }
})

test('the render (docker compose config): for two different STACK values every routed service carries exactly that STACK', () => {
  for (const stack of ['guardstack', 'otherstack']) {
    const render = renderState({ env: { STACK: stack } })
    const routed = Object.entries(render.services ?? {}).filter(([, s]) => isRouted(labelMap(s.labels)))
    assert.ok(routed.length >= 4, `only ${routed.length} routed services in the ${stack} render`)
    for (const [name, s] of routed) assert.equal(labelMap(s.labels)['org.gremion.stack'], stack, `${stack}: ${name}`)
    const tr = render.services.traefik
    assert.equal(tr.environment?.STACK, stack, `${stack}: the traefik container is not told its stack`)
    assert.match([].concat(tr.command).join(' '), /s\|@STACK@\|\$\$\{STACK\}\|g/, 'the traefik command must substitute @STACK@ from STACK')
  }
})

test('the traefik command refuses an empty STACK and a STACK carrying a metacharacter (backtick included) before Traefik starts', () => {
  const cmd = [].concat(renderState().services.traefik.command).join(' ')
  // `docker compose config` keeps the container-shell `$${VAR}` escaping, hence the doubled `$`.
  assert.match(cmd, /for v in [^;]*"\$\$\{STACK\}"/, 'the empty-value loop must name STACK')
  assert.match(cmd, /case "[^"]*\$\$\{STACK\}" in [^;]*\*'`'\*\)/, 'the metacharacter case must cover STACK and the backtick')
})
