/**
 * The control panel's host is never a customer host (state.env CONTROL_PANEL_HOST, default
 * control.<PLATFORM_DOMAIN>; a custom one may lie OUTSIDE the platform domain, where the reserved labels
 * never reach it).
 *
 *   node --test scripts/check-panel-host-reserved.test.mjs
 *
 * The refusal itself is unit-tested where it lives (packages/tenancy-core, packages/provisioning,
 * apps/control-panel, gremion-ui registry.domain.integration.test.ts). What those cannot see is the WIRING:
 * that every process which binds a host to a customer is handed the control host next to PLATFORM_DOMAIN,
 * and that each path asks the check. Each guard below reads an artefact and was shown RED against a copy
 * with the wiring removed. Two paths have a behavioural test of their own wiring and are not repeated here:
 * the "Neuer Mandant" action (apps/control-panel customers/new/page.server.test.ts) and request-verify
 * (gremion-ui request-verbs-council.test.ts, which feeds the host through the context's env seam).
 *   1. COMPOSE. tenant-create (the executor's create and the registry writes) and the control panel (the
 *      "Neuer Mandant" form) receive CONTROL_PANEL_HOST next to PLATFORM_DOMAIN; tenant-create also the origin.
 *   2. SCRIPTS. gremion-ui's tenant-create CLI hands the check to the create engine and to the router
 *      renderer, built from the script's own env seam (reqEnv / optEnv), and request-verify builds it
 *      through its context, never from the whole process.env.
 *   3. REGISTRY. registry.addTenantDomain reads the control host from the platform env next to PLATFORM_DOMAIN.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const count = (src, needle) => src.split(needle).length - 1
/** A parsed YAML value as text: a string as it is, anything else (absent, a number, a map) as '' so the match fails. */
const asText = (v) => (typeof v === 'string' ? v : '')

const SERVICES = parseYaml(read('docker-compose.app.yml')).services

/** The environment of one service as a plain map (compose accepts a map or KEY=value lines). */
function envOf(name) {
  const e = SERVICES[name]?.environment
  assert.ok(e, `docker-compose.app.yml has no environment for ${name}`)
  if (!Array.isArray(e)) return e
  return Object.fromEntries(e.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
}

test('COMPOSE: tenant-create gets CONTROL_PANEL_HOST and the origin next to PLATFORM_DOMAIN', () => {
  const e = envOf('tenant-create')
  assert.match(asText(e.PLATFORM_DOMAIN), /PLATFORM_DOMAIN/)
  assert.match(asText(e.CONTROL_PANEL_HOST), /\$\{CONTROL_PANEL_HOST(:-)?\}/)
  assert.match(asText(e.CONTROL_PANEL_ORIGIN), /\$\{CONTROL_PANEL_ORIGIN(:-)?\}/)
})

test('COMPOSE: the control panel gets PLATFORM_DOMAIN and CONTROL_PANEL_HOST for the "Neuer Mandant" form', () => {
  const e = envOf('control-panel')
  assert.match(asText(e.PLATFORM_DOMAIN), /PLATFORM_DOMAIN/)
  assert.match(asText(e.CONTROL_PANEL_HOST), /\$\{CONTROL_PANEL_HOST(:-)?\}/)
})

test('SCRIPTS: the tenant-create CLI hands the check to the create engine and to the router renderer, from its env seam', () => {
  const src = read('gremion-ui/scripts/tenant-provision.ts')
  assert.equal(count(src, 'isReservedHost: reservedHosts()'), 2, 'liveDeps and render-router both pass the check')
  assert.match(src, /reservedHostCheck\(\{\s*PLATFORM_DOMAIN: reqEnv\('PLATFORM_DOMAIN'\),\s*CONTROL_PANEL_HOST: optEnv\('CONTROL_PANEL_HOST'\),\s*CONTROL_PANEL_ORIGIN: optEnv\('CONTROL_PANEL_ORIGIN'\),?\s*\}\)/)
  assert.ok(!/reservedHostCheck\(process\.env\)/.test(src), 'a check built from the whole process.env skips the script env seam')
  assert.ok(!/isReservedPlatformHost\(h, platformDomain\)/.test(src), 'a check built from PLATFORM_DOMAIN alone is back')
})

test('SCRIPTS: request-verify builds the check through the context env seam, not process.env', () => {
  const src = read('gremion-ui/scripts/tenant-provision-requests.ts')
  assert.equal(count(src, 'isReservedHost: reservedHostCheck(panelHostEnv(ctx))'), 1)
  assert.ok(!/reservedHostCheck\(process\.env\)/.test(src), 'process.env read directly: a request of another kind needs no PLATFORM_DOMAIN there')
})

test('REGISTRY: addTenantDomain reads the control host from the platform env', () => {
  const src = read('gremion-ui/src/lib/server/tenant/registry.ts')
  assert.match(src, /controlPanelHosts: controlPanelHosts\(\{\s*CONTROL_PANEL_HOST: platformEnv\('CONTROL_PANEL_HOST'\),\s*CONTROL_PANEL_ORIGIN: platformEnv\('CONTROL_PANEL_ORIGIN'\),?\s*\}\)/)
  const names = read('gremion-ui/src/lib/server/env/platform-env.ts')
  assert.ok(names.includes("'CONTROL_PANEL_HOST'") && names.includes("'CONTROL_PANEL_ORIGIN'"), 'platformEnv does not serve them')
})
