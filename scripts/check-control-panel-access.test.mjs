/**
 * The control panel's public access path (operator decision 2026-11-12;
 * docs/runbooks/control-panel-access.md): https://control.<domain> behind a TLS
 * CLIENT-CERTIFICATE gate at the edge, then the ops-realm login.
 *
 *   node --test scripts/check-control-panel-access.test.mjs
 *
 * Guards, each read out of an artefact and each shown RED against a broken copy:
 *   1. ROUTER. The rendered etc/edge/control-panel.yml: one TLS option that
 *      REQUIRES and VERIFIES a client certificate (minimum TLS 1.2, the CA file
 *      under the mounted directory), one router on the control host that carries
 *      that option, the host pin first, HSTS, the portal-tier rate limit (a first
 *      load of the panel must fit in its burst), the colour-bound
 *      service panel@file, and a rule that leaves out /healthz and /api/internal.
 *      Nothing else: no middleware, no service, no second router.
 *   2. LABELS. The production compose declares the pin of that router and gives
 *      the ops realm's login path its own, rate-limited router that passes the
 *      router universal on its own.
 *   3. SERVICE. active.yml.tmpl carries the colour-bound service `panel` (probe
 *      /healthz, the ACTIVE colour only) and no router and no middleware.
 *   4. PANEL. ORIGIN is env-driven with the loopback as the default; the panel
 *      has no traefik label.
 *   5. REALM. The ops realm's control-panel client is confidential, code + PKCE,
 *      loa2 default and minimum, exact redirect URIs; every client description
 *      fits Keycloak's 255-character column (a longer one fails the import with
 *      "Database operation failed", measured); the ops realm has no self-service
 *      password reset (operator decision; recovery is the host administrator's).
 *
 * The behaviour of the real Traefik is proved by
 * test/host/integration/control-panel-mtls-proof.sh; the render and the verifier
 * by test/host/render.bats and verify.bats.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { REPO_ROOT, renderState } from './compose-edge.mjs'

const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), 'utf8')
const DOMAIN = 'example.org'

// ── 1. the router file ─────────────────────────────────────────────────────

const TEMPLATE = read('infra/host/templates/edge/control-panel.yml.tmpl')
const CHAIN = ['edge-hostpin-control@docker', 'edge-hsts-platform@docker', 'edge-ratelimit-portal@docker']
const RULE = `Host(\`control.${DOMAIN}\`) && !PathPrefix(\`/healthz\`) && !PathPrefix(\`/api/internal\`)`

/** What gremion-render writes: the two tokens, nothing else. */
function rendered(resolver = 'le-http', host = `control.${DOMAIN}`) {
  return TEMPLATE.replaceAll('${CONTROL_HOST}', host).replaceAll('${TRAEFIK_CERT_RESOLVER}', resolver)
}

/** Every way the router file can stop being the gate, as one list. */
function routerViolations(doc, want = RULE) {
  const out = []
  const top = Object.keys(doc ?? {}).sort()
  if (JSON.stringify(top) !== '["http","tls"]') out.push(`top-level keys are ${JSON.stringify(top)}, want http and tls only`)
  const options = doc?.tls?.options ?? {}
  if (JSON.stringify(Object.keys(doc?.tls ?? {})) !== '["options"]') out.push('tls declares more than options (a certificate or a store)')
  if (JSON.stringify(Object.keys(options)) !== '["control-panel-mtls"]') out.push(`TLS options are ${JSON.stringify(Object.keys(options))}, want control-panel-mtls only`)
  const o = options['control-panel-mtls'] ?? {}
  if (o.clientAuth?.clientAuthType !== 'RequireAndVerifyClientCert') out.push(`clientAuthType is ${JSON.stringify(o.clientAuth?.clientAuthType)}: only RequireAndVerifyClientCert refuses a connection with no certificate`)
  if (JSON.stringify(o.clientAuth?.caFiles) !== '["/etc/traefik/dynamic/mtls/operator-ca.pem"]') out.push(`caFiles are ${JSON.stringify(o.clientAuth?.caFiles)}`)
  if (o.minVersion !== 'VersionTLS12') out.push(`minVersion is ${JSON.stringify(o.minVersion)}`)
  if (JSON.stringify(Object.keys(doc?.http ?? {}).sort()) !== '["routers"]') out.push(`http declares ${JSON.stringify(Object.keys(doc?.http ?? {}))}, want routers only (no middleware may live in a file Traefik reloads, no service here)`)
  const routers = doc?.http?.routers ?? {}
  if (JSON.stringify(Object.keys(routers)) !== '["control-panel"]') out.push(`routers are ${JSON.stringify(Object.keys(routers))}`)
  const r = routers['control-panel'] ?? {}
  if (r.rule !== want) out.push(`rule is ${JSON.stringify(r.rule)}, want ${JSON.stringify(want)}`)
  if (JSON.stringify(r.entryPoints) !== '["websecure"]') out.push(`entryPoints are ${JSON.stringify(r.entryPoints)}`)
  if (r.service !== 'panel@file') out.push(`service is ${JSON.stringify(r.service)}`)
  if (JSON.stringify(r.middlewares) !== JSON.stringify(CHAIN)) out.push(`middlewares are ${JSON.stringify(r.middlewares)}, want ${JSON.stringify(CHAIN)} (the pin FIRST)`)
  if (r.tls?.options !== 'control-panel-mtls') out.push(`the router's TLS option is ${JSON.stringify(r.tls?.options)}: without it the host is served without asking for a certificate`)
  if (!r.tls?.certResolver) out.push('the router names no certResolver: a bare tls serves the default certificate, silently')
  return out
}

test('router: the rendered file is the gate, and only the gate', () => {
  assert.deepEqual(routerViolations(parseYaml(rendered())), [])
})

test('router: the template substitutes exactly two tokens', () => {
  const tokens = [...new Set([...TEMPLATE.matchAll(/\$\{([A-Za-z_]+)\}/g)].map((m) => m[1]))].toSorted((x, y) => x.localeCompare(y))
  assert.deepEqual(tokens, ['CONTROL_HOST', 'TRAEFIK_CERT_RESOLVER'])
  assert.ok(!/\$\{/.test(rendered()), 'a token survives the render')
})

test('router: every way of weakening the gate is named (guard efficacy, on broken copies)', () => {
  const broken = (mutate) => {
    const d = parseYaml(rendered())
    mutate(d)
    return routerViolations(d).join(' | ')
  }
  const cases = [
    [(d) => (d.tls.options['control-panel-mtls'].clientAuth.clientAuthType = 'VerifyClientCertIfGiven'), /clientAuthType is "VerifyClientCertIfGiven"/],
    [(d) => (d.tls.options['control-panel-mtls'].clientAuth.clientAuthType = 'RequestClientCert'), /clientAuthType is "RequestClientCert"/],
    [(d) => delete d.tls.options['control-panel-mtls'].clientAuth, /clientAuthType is undefined/],
    [(d) => (d.tls.options['control-panel-mtls'].minVersion = 'VersionTLS10'), /minVersion is "VersionTLS10"/],
    [(d) => (d.tls.options['control-panel-mtls'].clientAuth.caFiles = ['/etc/ssl/certs/ca-certificates.crt']), /caFiles are/],
    [(d) => delete d.http.routers['control-panel'].tls.options, /the router's TLS option is undefined/],
    [(d) => (d.http.routers['control-panel'].tls.options = 'default'), /the router's TLS option is "default"/],
    [(d) => (d.http.routers['control-panel'].rule = `Host(\`control.${DOMAIN}\`)`), /rule is/],
    [(d) => (d.http.routers['control-panel'].rule = RULE.replace(' && !PathPrefix(`/healthz`)', '')), /rule is/],
    [(d) => (d.http.routers['control-panel'].rule = RULE.replace(' && !PathPrefix(`/api/internal`)', '')), /rule is/],
    [(d) => d.http.routers['control-panel'].middlewares.reverse(), /the pin FIRST/],
    [(d) => d.http.routers['control-panel'].middlewares.pop(), /middlewares are/],
    [(d) => (d.http.routers['control-panel'].middlewares[2] = 'edge-ratelimit-app@docker'), /middlewares are/],
    [(d) => (d.http.routers['control-panel'].service = 'app@file'), /service is "app@file"/],
    [(d) => delete d.http.routers['control-panel'].tls.certResolver, /names no certResolver/],
    [(d) => (d.http.middlewares = { 'edge-hostpin-control': {} }), /http declares/],
    [(d) => (d.http.services = { panel: {} }), /http declares/],
    [(d) => (d.http.routers.other = { rule: 'Host(`x.example.org`)' }), /routers are/],
    [(d) => (d.tls.certificates = [{ certFile: '/x' }]), /tls declares more than options/],
  ]
  for (const [mutate, want] of cases) assert.match(broken(mutate), want, `${want.source}: not caught`)
})

test('router: a configured control host (CONTROL_PANEL_HOST, outside the platform domain) renders the same gate for exactly that host', () => {
  const host = 'panel.example.com'
  const rule = `Host(\`${host}\`) && !PathPrefix(\`/healthz\`) && !PathPrefix(\`/api/internal\`)`
  const doc = parseYaml(rendered('le-http', host))
  assert.deepEqual(routerViolations(doc, rule), [])
  assert.doesNotMatch(rendered('le-http', host), new RegExp(`control\\.${DOMAIN.replaceAll('.', '\\.')}`))
  // the default name's rule is a violation against the configured host (the guard can fail)
  assert.match(routerViolations(parseYaml(rendered()), rule).join(' | '), /rule is/)
})

// ── 2. the production labels ───────────────────────────────────────────────

const labels = () => renderState().services.traefik.labels
const keycloakLabels = () => renderState().services.keycloak.labels

test('labels: the traefik container declares the control pin, stamping the control host', () => {
  const l = labels()
  assert.equal(l['traefik.http.middlewares.edge-hostpin-control.headers.customrequestheaders.X-Forwarded-Host'], 'control.guard.example.org')
  // with CONTROL_PANEL_HOST set the pin stamps that host, and an empty value is the default again
  // (compose's own interpolation, read from the real `docker compose config`)
  const custom = renderState({ env: { CONTROL_PANEL_HOST: 'panel.example.com' } }).services.traefik.labels
  assert.equal(custom['traefik.http.middlewares.edge-hostpin-control.headers.customrequestheaders.X-Forwarded-Host'], 'panel.example.com')
  const empty = renderState({ env: { CONTROL_PANEL_HOST: '' } }).services.traefik.labels
  assert.equal(empty['traefik.http.middlewares.edge-hostpin-control.headers.customrequestheaders.X-Forwarded-Host'], 'control.guard.example.org')
  // and every name the router chains is declared there (spec B B-09)
  for (const ref of CHAIN) assert.ok(Object.keys(l).some((k) => k.startsWith(`traefik.http.middlewares.${ref.split('@')[0]}.`)), `${ref} is not declared on the traefik container`)
})

test('labels: the ops realm login path has its own router, with the auth rate limit, and passes the router universal on its own', () => {
  const l = keycloakLabels()
  const r = Object.fromEntries(Object.entries(l).filter(([k]) => k.startsWith('traefik.http.routers.keycloak-ops.')).map(([k, v]) => [k.slice('traefik.http.routers.keycloak-ops.'.length), String(v)]))
  const apex = 'guard.example.org'
  assert.equal(r.rule, `Host(\`${apex}\`) && PathPrefix(\`/auth/realms/platform/\`)`, 'the prefix ends in a slash: a customer realm that merely starts with "platform" stays on the other router')
  assert.equal(r.entrypoints, 'websecure')
  assert.equal(r.service, 'keycloak')
  assert.equal(r.tls, 'true')
  assert.ok(r['tls.certresolver'], 'a router that names no resolver serves the default certificate, silently')
  const chain = r.middlewares.split(',')
  assert.equal(chain[0], 'edge-hostpin-apex@docker', 'the pin is first')
  assert.ok(chain.includes('edge-hsts-platform@docker'), 'HSTS')
  assert.ok(chain.includes('edge-ratelimit-auth@docker'), 'the auth tier: the one throttle in front of the operator sign-in')
  for (const ref of chain) assert.ok(Object.keys(labels()).some((k) => k.startsWith(`traefik.http.middlewares.${ref.split('@')[0]}.`)), `${ref} is not declared on the traefik container`)
  // it must outrank the public keycloak router (100) and stay below the admin router (110)
  const pri = Number(r.priority)
  assert.ok(pri > Number(l['traefik.http.routers.keycloak.priority']), 'it does not outrank the keycloak router')
  assert.ok(pri < Number(l['traefik.http.routers.keycloak-admin.priority']), 'it outranks the admin router')
  assert.equal(l['traefik.http.middlewares.kc-admin-allowlist.ipallowlist.sourcerange'] !== undefined, true)
})

// ── 3. active.yml ──────────────────────────────────────────────────────────

test('active.yml: the panel service follows the ACTIVE colour, probes /healthz, and no router or middleware is declared', () => {
  const text = read('infra/host/templates/edge/active.yml.tmpl')
    .replaceAll('${ACTIVE_COLOUR}', 'blue')
    .replaceAll('${INACTIVE_COLOUR}', 'green')
    .replaceAll('${PUBLIC_BASE_PATH}', '')
  const doc = parseYaml(text)
  const s = doc.http.services.panel
  assert.equal(s.loadBalancer.servers[0].url, 'http://control-panel-blue:3000')
  assert.equal(s.loadBalancer.healthCheck.path, '/healthz')
  assert.deepEqual(Object.keys(doc.http.services).sort(), ['app', 'app-next', 'panel', 'public', 'public-next'])
  assert.equal(doc.http.middlewares, undefined, 'a middleware in active.yml vanishes between two switch writes')
  for (const [name, r] of Object.entries(doc.http.routers)) assert.notEqual(r.service, 'panel@file', `router ${name} routes to the panel from active.yml: the control router lives in control-panel.yml, behind the TLS option`)
  assert.ok(!Object.keys(doc.http.services).includes('panel-next'))
})

// ── 4. the panel service ───────────────────────────────────────────────────

test('panel: ORIGIN is env-driven with the loopback default, there is no traefik label, and the edge network is joined only by the opt-in overlay, under the colour alias', () => {
  const doc = parseYaml(read('docker-compose.app.yml'))
  const p = doc.services['control-panel']
  assert.equal(p.environment.ORIGIN, '${CONTROL_PANEL_ORIGIN:-http://127.0.0.1:3043}')
  assert.equal(String(p.labels['traefik.enable']), 'false')
  assert.deepEqual(Object.keys(p.labels).filter((k) => k.startsWith('traefik.http.')), [])
  assert.deepEqual(Object.keys(p.networks).sort(), ['app', 'state'], 'by default the panel is not a peer of the services on the edge network')
  assert.deepEqual(p.ports ?? [], [])
  const overlay = parseYaml(read('docker-compose.control-public.yml'))
  assert.deepEqual(Object.keys(overlay), ['services'])
  assert.deepEqual(Object.keys(overlay.services), ['control-panel'])
  assert.deepEqual(overlay.services['control-panel'], { networks: { edge: { aliases: ['control-panel-${COLOUR:?COLOUR required}'] } } })
})

test('throttle: the control router takes the portal tier, whose burst admits the requests of one first load of the panel; the auth tier would not', () => {
  const l = labels()
  const tier = (name) => ({ average: Number(l[`traefik.http.middlewares.${name}.ratelimit.average`]), burst: Number(l[`traefik.http.middlewares.${name}.ratelimit.burst`]) })
  // the limiter the RENDERED router chains: read from the template, not from this file's own CHAIN constant
  const chained = parseYaml(rendered()).http.routers['control-panel'].middlewares.filter((m) => m.startsWith('edge-ratelimit-'))
  assert.equal(chained.length, 1, 'exactly one rate limit in the control router chain')
  const limiter = chained[0].split('@')[0]
  assert.equal(limiter, 'edge-ratelimit-portal')
  // One first load, COUNTED from a production build of apps/control-panel (vite build, adapter-node) on its
  // heaviest page: the closure of the root layout, the shell layout and that page's node, read from the
  // server nodes' imports and stylesheets lists. 12 requests (the document, the two entry scripts, three
  // route nodes, four shared chunks, two stylesheets) plus the icon request make 13, all sent at once from
  // one address. A build that grows past this is a reason to count again, not to lower the number.
  const FIRST_LOAD = 13
  assert.ok(tier(limiter).burst >= FIRST_LOAD, `${limiter}: burst ${tier(limiter).burst} does not admit ${FIRST_LOAD} requests at once`)
  assert.ok(tier('edge-ratelimit-auth').burst < FIRST_LOAD, 'the premise of the choice: the auth tier would answer the tail of a first load with 429')
  assert.ok(tier(limiter).average > tier('edge-ratelimit-auth').average, 'the portal tier is still a limit, and the more generous one')
  assert.ok(tier(limiter).average <= 300, 'still a throttle on one address, not the app tier')
})

// ── 5. the ops realm ───────────────────────────────────────────────────────

const REALM = JSON.parse(read('docker/keycloak/realm-export.ops.json'))
const client = (id) => REALM.clients.find((c) => c.clientId === id)

test('realm: the control-panel client is confidential, code + PKCE, loa2 default and minimum, with exact redirect URIs', () => {
  const c = client('control-panel')
  assert.equal(c.publicClient, false)
  assert.equal(c.standardFlowEnabled, true)
  assert.equal(c.implicitFlowEnabled, false)
  assert.equal(c.directAccessGrantsEnabled, false)
  assert.equal(c.serviceAccountsEnabled, false)
  assert.equal(c.attributes['pkce.code.challenge.method'], 'S256')
  assert.equal(c.attributes['default.acr.values'], 'loa2')
  assert.equal(c.attributes['minimum.acr.value'], 'loa2')
  // the same two as the grafana client, the other operator-only surface
  assert.equal(client('grafana').attributes['default.acr.values'], c.attributes['default.acr.values'])
  assert.equal(client('grafana').attributes['minimum.acr.value'], c.attributes['minimum.acr.value'])
  // the template carries the loopback origin; init stamps the install's one origin over it, exact, never a wildcard host
  assert.deepEqual(c.redirectUris, ['http://127.0.0.1:3043/*'])
  assert.deepEqual(c.webOrigins, ['http://127.0.0.1:3043'])
  for (const u of [...c.redirectUris, ...c.webOrigins]) assert.ok(!/^[a-z]+:\/\/[^/]*\*/.test(u), `${u}: a wildcard host`)
  assert.ok(c.protocolMappers.some((m) => m.name === 'acr'))
})

test('realm: every client description and name fits the 255-character column (a longer one fails the whole import)', () => {
  for (const c of REALM.clients) {
    assert.ok((c.description ?? '').length <= 255, `${c.clientId}: description is ${c.description.length} characters`)
    assert.ok((c.name ?? '').length <= 255, `${c.clientId}: name is too long`)
  }
})

test('realm: the ops realm enables only the required actions it uses (measured on the pinned Keycloak: the import yields exactly this list)', () => {
  const byAlias = Object.fromEntries((REALM.requiredActions ?? []).map((a) => [a.alias, a]))
  // what the realm uses: the password, the authenticator and the profile and e-mail ones
  for (const alias of ['CONFIGURE_TOTP', 'UPDATE_PASSWORD', 'UPDATE_PROFILE', 'VERIFY_EMAIL', 'VERIFY_PROFILE']) {
    assert.equal(byAlias[alias]?.enabled, true, `${alias} must stay enabled`)
  }
  // what it does not use: switched off
  for (const alias of ['webauthn-register', 'webauthn-register-passwordless', 'CONFIGURE_RECOVERY_AUTHN_CODES']) {
    assert.equal(byAlias[alias]?.enabled, false, `${alias} must be listed and disabled`)
  }
  // the list is the server's whole default set: a list that named only some would drop the rest from the realm
  assert.deepEqual(
    Object.keys(byAlias).sort(),
    ['CONFIGURE_RECOVERY_AUTHN_CODES', 'CONFIGURE_TOTP', 'TERMS_AND_CONDITIONS', 'UPDATE_EMAIL', 'UPDATE_PASSWORD', 'UPDATE_PROFILE', 'VERIFY_EMAIL', 'VERIFY_PROFILE', 'delete_account', 'delete_credential', 'idp_link', 'update_user_locale', 'webauthn-register', 'webauthn-register-passwordless'].sort(),
  )
  assert.equal((REALM.requiredActions ?? []).filter((a) => a.defaultAction).length, 0, 'no action is forced on every user')
})

test('realm: no self-service password reset in the ops realm, no registration, brute force protection on', () => {
  assert.equal(REALM.resetPasswordAllowed, false)
  assert.equal(REALM.registrationAllowed, false)
  assert.equal(REALM.bruteForceProtected, true)
})

test('upgrade runbook step 8a: the by-hand ops-realm upgrade names every setting this template changed, and both init refusals point at it', () => {
  // `gremion-tenant init` refuses an ops realm whose fingerprint is not this template's, so a host made from an
  // earlier template needs the kcadm steps of upgrade.md 8a. They are a copy of what the template says: when the
  // template gains a setting the steps must name it, or the runbook is untrue and init stays refused.
  const doc = read('docs/ops/runbook/upgrade.md')
  const at = doc.indexOf('8a. **')
  assert.ok(at > 0, 'upgrade.md has a step 8a')
  const step = doc.slice(at, doc.indexOf('\n9. **', at))
  // The COMMANDS, not the prose around them: a setting mentioned in a sentence is not applied.
  const commands = codeBlockCommandLines(step)
  assert.ok(commands.length > 5, 'step 8a has bash blocks with commands')
  const loop = commands.find((l) => l.startsWith('for a in '))
  assert.ok(loop, 'step 8a loops over the required-action aliases in a command line')
  for (const a of REALM.requiredActions.filter((x) => x.enabled === false)) {
    assert.ok(loop.replace(/;\s*do$/, '').split(/\s+/).includes(a.alias), `step 8a's command loop must disable ${a.alias} (a command line, not prose)`)
  }
  assert.ok(commands.some((l) => /kcadm update "authentication\/required-actions\/\$\{a\}" -r platform -s enabled=false/.test(l)), 'the loop body disables the action')
  assert.ok(commands.some((l) => l.includes('kcadm update realms/platform -s resetPasswordAllowed=false')), 'step 8a must switch off the self-service password reset, in a command')
  const client = REALM.clients.find((c) => c.clientId === 'control-panel')
  for (const k of ['minimum.acr.value', 'default.acr.values']) {
    assert.ok(commands.some((l) => l.startsWith('kcadm update "clients/') && l.includes(`'attributes."${k}"=${client.attributes[k]}'`)), `step 8a must set the control-panel client's ${k} in a command`)
  }
  // the client's description is read out of the template itself (never a copy that can go stale) and applied
  assert.ok(commands.some((l) => l.startsWith('desc="$(jq') && l.includes('docker/keycloak/realm-export.ops.json')), 'step 8a reads the description from the release template')
  assert.ok(commands.some((l) => l.startsWith('kcadm update "clients/') && l.includes('-s "description=${desc}"')), 'step 8a must update the control-panel client description')
  assert.ok(commands.some((l) => l.includes('gremion.ops-realm.sha256') && l.startsWith('kcadm update realms/platform')), 'step 8a must re-stamp the fingerprint, in a command')
  // M2a: the precondition runs first: the stored fingerprint is compared with the PREVIOUS template's for this origin
  const iStamp = commands.findIndex((l) => l.startsWith('kcadm update realms/platform') && l.includes('gremion.ops-realm.sha256'))
  const iRead = commands.findIndex((l) => l.startsWith('stored="$(kcadm get realms/platform'))
  const iGuard = commands.findIndex((l) => /^if \[ "\$stored" != "\$prev_fp" \]; then$/.test(l))
  const iFirstWrite = commands.findIndex((l) => l.startsWith('kcadm update '))
  assert.ok(iRead >= 0 && iGuard > iRead && iGuard < iFirstWrite && iFirstWrite < iStamp, 'the stored-fingerprint guard comes before the first kcadm write')
  assert.ok(commands.some((l) => l.includes('git show "${prev}:docker/keycloak/realm-export.ops.json"')), 'the previous template is read from git')
  assert.ok(commands.some((l) => l.startsWith('prev_fp="$( { git show') && l.includes("printf '\\n%s' \"$origin\"") && l.includes('sha256sum')), 'the previous fingerprint uses the recipe init uses (template, newline, origin)')
  assert.ok(commands.some((l) => l.startsWith('fp="$( { cat /opt/gremion/current/docker/keycloak/realm-export.ops.json; printf')), 'the re-stamp uses the same recipe on the current template')
  for (const rel of ['infra/host/bin/gremion-tenant', 'gremion-ui/scripts/ops-realm-refusal.ts']) {
    assert.ok(read(rel).includes('docs/ops/runbook/upgrade.md, step 8a'), `${rel}: the ops-realm refusal must name step 8a`)
  }
  // the TypeScript side imports the shared refusal, so the message cannot drift from the tested one
  assert.ok(read('gremion-ui/scripts/tenant-provision.ts').includes('opsRealmRefusal('), 'tenant-provision.ts builds its ops-realm refusal with opsRealmRefusal')
})

test('CONTROL_PANEL_HOST: the key an operator sets is documented where they look, and every reader of the control host takes it from the one resolver', () => {
  for (const rel of ['docs/runbooks/control-panel-access.md', 'infra/host/templates/env/state.env.tmpl', 'docs/ops/host-tooling.md']) {
    assert.ok(read(rel).includes('CONTROL_PANEL_HOST'), `${rel} names CONTROL_PANEL_HOST`)
  }
  const runbook = read('docs/runbooks/control-panel-access.md')
  for (const need of ['Choosing the host name', 'lowercase DNS host name', 'includeSubDomains', 'Do not give the name to a customer', 'Fixed at the ops realm']) {
    assert.ok(runbook.includes(need), `the runbook says "${need}"`)
  }
  // no tool builds the control host by hand any more: each takes it from the resolved value
  for (const rel of ['infra/host/bin/gremion-render', 'infra/host/bin/gremion-verify', 'infra/host/ops/render-ops.sh']) {
    assert.ok(!/["'`]control\.\$\{PLATFORM_DOMAIN\}["'`]/.test(read(rel).replace(/printf 'control\.%s'[^\n]*|control\.\$\{PLATFORM_DOMAIN\}\}/g, '')), `${rel} builds control.<domain> by hand`)
  }
})

/** The command lines of every ```bash block in <text>: no comment, no blank, in order. */
function codeBlockCommandLines(text) {
  const out = []
  let inBlock = false
  for (const raw of text.split('\n')) {
    if (/^```bash\s*$/.test(raw)) { inBlock = true; continue }
    if (/^```\s*$/.test(raw)) { inBlock = false; continue }
    if (!inBlock) continue
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    out.push(line)
  }
  return out
}

test('no allow-list key: the control host is gated by the client certificate, nothing reads an IP list', () => {
  // The state template once carried CONTROL_ALLOWLIST_CIDRS with a comment saying it
  // restricted control.<domain>. Nothing reads it and the control router ignores it, so
  // a key that looks like a restriction is a restriction nobody has. Keep it out of every
  // template, script and doc an operator reads (the design specs are history).
  for (const rel of ['infra/host/templates/env/state.env.tmpl', 'infra/host/templates/env/app.env.tmpl', 'docs/ops/host-tooling.md', 'compose/observability/prometheus/prometheus.yml', 'infra/host/templates/edge/control-panel.yml.tmpl']) {
    assert.ok(!/CONTROL_ALLOWLIST_CIDRS/.test(read(rel)), `${rel} must not name CONTROL_ALLOWLIST_CIDRS`)
  }
  assert.ok(!/allowlist is enforced/i.test(read('compose/observability/prometheus/prometheus.yml')), 'the probe comment must not claim an allow-list')
})
