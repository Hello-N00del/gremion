/**
 * The static guards of the ops project (TASK-039), as pure functions over a
 * `docker compose config --format json` RENDER or over the parsed config
 * files. A library, not a test file: importing it registers no tests (the
 * scripts/compose-edge.mjs / check-compose-edge.test.mjs split). The *.test.mjs
 * files beside it run every guard against the real tree AND against a broken
 * copy per failure the brief names: a guard that cannot be shown failing is
 * not a guard.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(HERE, '..', '..')

/** The six services of the project and the two that may publish a port. */
export const OPS_SERVICES = ['alloy', 'blackbox', 'grafana', 'loki', 'prometheus', 'tempo']
export const PUBLISHED = {
  grafana: [{ hostVar: 'OPS_BIND_IP', target: 3000 }],
  alloy: [
    { hostVar: 'OPS_INGEST_BIND_IP', target: 4317 },
    { hostVar: 'OPS_INGEST_BIND_IP', target: 4318 },
  ],
}

/** The host paths Alloy may mount, read-only (Q16). Keys are container targets. */
export const ALLOY_READONLY_HOST = { '/host/proc': '/proc', '/host/sys': '/sys' }

const DIGEST = /@sha256:[0-9a-f]{64}$/
const services = (r) => Object.entries(r?.services ?? {})
const positive = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(String(v).trim())) && Number(String(v).trim()) > 0

export function readText(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8')
}
export function readYaml(rel) {
  return parseYaml(readText(rel), { merge: true })
}

// ── TDD 1: render shape (TRD-350, TRD-177, TRD-178) ────────────────────────

/** Healthcheck state: 'probe' only for a test that runs a command. */
function probes(hc) {
  if (!hc || hc.disable === true) return false
  const t = Array.isArray(hc.test) ? hc.test : hc.test ? [hc.test] : []
  if (t.length === 0 || t[0] === 'NONE') return false
  return t.length > 1 || (typeof t[0] === 'string' && t[0].length > 0)
}

export function renderShapeViolations(render, label = 'ops') {
  const out = []
  const svcs = services(render)
  if (svcs.length === 0) out.push(`${label}: renders zero services -- every rule would pass vacuously`)
  const names = svcs.map(([n]) => n).sort()
  if (svcs.length && JSON.stringify(names) !== JSON.stringify(OPS_SERVICES)) out.push(`${label}: services [${names.join(', ')}], want [${OPS_SERVICES.join(', ')}]`)
  for (const [name, svc] of svcs) {
    const image = String(svc.image ?? '')
    if (!DIGEST.test(image)) out.push(`${label}/${name}: image ${image || '(none)'} is not digest-pinned`)
    if (/:latest@/.test(image)) out.push(`${label}/${name}: image carries the latest tag`)
    const lim = svc.deploy?.resources?.limits ?? {}
    if (!positive(lim.memory)) out.push(`${label}/${name}: no non-zero memory limit`)
    if (!positive(lim.cpus)) out.push(`${label}/${name}: no non-zero cpus limit`)
    if (!probes(svc.healthcheck)) out.push(`${label}/${name}: no probing healthcheck`)
    if (!(svc.cap_drop ?? []).includes('ALL')) out.push(`${label}/${name}: cap_drop does not include ALL`)
    if (svc.privileged) out.push(`${label}/${name}: privileged`)
    for (const v of svc.volumes ?? []) {
      if (v.type === 'image' && !DIGEST.test(String(v.source ?? ''))) out.push(`${label}/${name}: image mount ${v.source} is not digest-pinned`)
      if (v.type === 'image' && v.read_only !== true) out.push(`${label}/${name}: image mount ${v.source} is not read-only`)
    }
  }
  if (render?.name !== undefined && !String(render.name).endsWith('-ops')) out.push(`${label}: project name ${render.name} is not <STACK>-ops`)
  return out
}

// ── TDD 3: host mounts (Q16, TRD-203, CIS Docker 5.5) ──────────────────────

/** A bind source that is `/` or an ancestor-or-self of /var/lib/docker/volumes. */
function coversDockerVolumes(src) {
  const s = String(src).replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  const v = '/var/lib/docker/volumes'
  return s === '/' || v === s || v.startsWith(`${s}/`) || s.startsWith(`${v}/`) || s.startsWith('/var/lib/docker')
}

export function mountViolations(render, label = 'ops') {
  const out = []
  for (const [name, svc] of services(render)) {
    if (svc.pid === 'host') out.push(`${label}/${name}: pid: host`)
    if (svc.network_mode === 'host') out.push(`${label}/${name}: network_mode: host`)
    if ((svc.devices ?? []).length) out.push(`${label}/${name}: maps a host device`)
    for (const v of svc.volumes ?? []) {
      if (v.type === 'bind' && coversDockerVolumes(v.source)) out.push(`${label}/${name}: binds ${v.source}, which is / or covers the Docker data root`)
      if (v.type === 'bind' && /docker\.sock/.test(String(v.source))) out.push(`${label}/${name}: binds the Docker socket ${v.source}`)
      if (v.type === 'volume') {
        const def = render.volumes?.[v.source] ?? {}
        const real = String(def.name ?? v.source ?? '')
        if (/pg-data|_data$|postgres/.test(real)) out.push(`${label}/${name}: mounts the data volume ${real}`)
        if (v.read_only !== true) out.push(`${label}/${name}: named volume ${real} mounted writable`)
      }
    }
  }
  const alloy = render?.services?.alloy
  if (alloy) {
    for (const [target, host] of Object.entries(ALLOY_READONLY_HOST)) {
      const m = (alloy.volumes ?? []).find((v) => v.target === target)
      if (!m || m.source !== host || m.read_only !== true) out.push(`${label}/alloy: ${host} is not mounted read-only at ${target}`)
    }
    const textfile = (alloy.volumes ?? []).find((v) => v.target === '/textfile')
    if (!textfile || textfile.read_only !== true || !String(textfile.source).endsWith('/runtime/textfile')) out.push(`${label}/alloy: the host collector's runtime/textfile is not mounted read-only at /textfile`)
    const vector = (alloy.volumes ?? []).find((v) => v.target === '/vector-logs')
    const vdef = vector ? render.volumes?.[vector.source] ?? {} : {}
    if (!vector || vector.type !== 'volume' || vector.read_only !== true || !String(vdef.name ?? '').endsWith('-state_vector-processed-logs') || vdef.external !== true) {
      out.push(`${label}/alloy: Vector's output volume is not mounted read-only (external <STACK>-state_vector-processed-logs)`)
    }
    // Every other host bind of Alloy lives under the host root's runtime/ops or
    // etc/secrets/ops, or is its own config from the release tree.
    for (const v of alloy.volumes ?? []) {
      if (v.type !== 'bind' || Object.prototype.hasOwnProperty.call(ALLOY_READONLY_HOST, v.target) || v.target === '/textfile') continue
      const src = String(v.source).replace(/\\/g, '/')
      if (!/\/runtime\/ops\/(alloy-data|grafana-logs)$|\/etc\/secrets\/ops\/otlp-ingest-token$|\/docker\/alloy\/config\.alloy$/.test(src)) out.push(`${label}/alloy: bind ${v.source} is outside the Q16 allow-list`)
    }
  }
  return out
}

// ── ports (TRD-111: only Grafana, on loopback; Q15: only the OTLP ingest) ──

/**
 * `hostIps` maps the env keys to the values the render was taken with, so a
 * published port can be traced back to the variable it must come from.
 */
export function portViolations(render, hostIps, label = 'ops') {
  const out = []
  for (const [name, svc] of services(render)) {
    const want = PUBLISHED[name] ?? []
    const ports = svc.ports ?? []
    if (ports.length !== want.length) out.push(`${label}/${name}: publishes ${ports.length} port(s), want ${want.length}`)
    for (const p of ports) {
      const w = want.find((x) => x.target === Number(p.target))
      if (!w) {
        out.push(`${label}/${name}: publishes ${p.host_ip ?? '*'}:${p.published}->${p.target}, which no rule allows`)
        continue
      }
      if (!p.host_ip || p.host_ip === '0.0.0.0' || p.host_ip === '::') out.push(`${label}/${name}: port ${p.target} binds a wildcard address`)
      else if (p.host_ip !== hostIps[w.hostVar]) out.push(`${label}/${name}: port ${p.target} binds ${p.host_ip}, not ${w.hostVar} (${hostIps[w.hostVar]})`)
      if (String(p.published) !== String(w.target)) out.push(`${label}/${name}: port ${p.target} published as ${p.published}`)
    }
  }
  return out
}

/** TRD-203 / TRD-111: every ops service on the project's own network only. */
export function networkViolations(render, stack, label = 'ops') {
  const out = []
  const opsNet = `${stack}-ops_ops`
  for (const [name, svc] of services(render)) {
    if (svc.network_mode !== undefined) {
      out.push(`${label}/${name}: network_mode ${svc.network_mode}`)
      continue
    }
    const nets = Object.keys(svc.networks ?? {}).map((k) => render.networks?.[k]?.name ?? k)
    if (JSON.stringify(nets) !== JSON.stringify([opsNet])) out.push(`${label}/${name}: networks [${nets.join(', ')}], want [${opsNet}] only`)
  }
  for (const [key, def] of Object.entries(render?.networks ?? {})) {
    if (def?.external) out.push(`${label}: network ${key} (${def.name}) is external -- a shared network, never the project's own`)
  }
  return out
}

// ── access (TRD-111, Q4/Q5) ────────────────────────────────────────────────

/** Every Grafana auth provider switch other than generic OAuth. */
const OTHER_PROVIDERS = /^GF_AUTH_(GITHUB|GITLAB|GOOGLE|GRAFANA_COM|GRAFANANET|AZUREAD|OKTA|LDAP|JWT|PROXY|SAML|EXTENDED_JWT)_ENABLED$/

export function grafanaAccessViolations(env, label = 'grafana') {
  const out = []
  const is = (k, v) => String(env[k] ?? '') === v
  if (!is('GF_AUTH_DISABLE_LOGIN_FORM', 'true')) out.push(`${label}: the login form is not disabled`)
  if (!is('GF_AUTH_BASIC_ENABLED', 'false')) out.push(`${label}: basic auth is not off`)
  if (!is('GF_AUTH_ANONYMOUS_ENABLED', 'false')) out.push(`${label}: anonymous access is not off`)
  if (!is('GF_SECURITY_DISABLE_INITIAL_ADMIN_CREATION', 'true')) out.push(`${label}: a local admin is created`)
  if (!is('GF_USERS_ALLOW_SIGN_UP', 'false')) out.push(`${label}: local sign-up is allowed`)
  if (!is('GF_AUTH_GENERIC_OAUTH_ENABLED', 'true')) out.push(`${label}: generic OAuth is not the sign-in`)
  for (const [k, v] of Object.entries(env)) {
    if (OTHER_PROVIDERS.test(k) && String(v) !== 'false') out.push(`${label}: a second provider is on (${k}=${v})`)
    if (/^GF_AUTH_(?!GENERIC_OAUTH_)[A-Z_]+_(AUTH_URL|TOKEN_URL|API_URL)$/.test(k)) out.push(`${label}: a second issuer URL (${k})`)
  }
  const platform = /^https:\/\/[^/]+\/auth\/realms\/platform\/protocol\/openid-connect\/(auth|token|userinfo)$/
  for (const k of ['GF_AUTH_GENERIC_OAUTH_AUTH_URL', 'GF_AUTH_GENERIC_OAUTH_TOKEN_URL', 'GF_AUTH_GENERIC_OAUTH_API_URL']) {
    if (!platform.test(String(env[k] ?? ''))) out.push(`${label}: ${k}=${env[k] ?? '(unset)'} is not the platform realm by its public https URL`)
  }
  if (!is('GF_AUTH_GENERIC_OAUTH_CLIENT_ID', 'grafana')) out.push(`${label}: the client id is not grafana`)
  if (env.GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET !== undefined) out.push(`${label}: the client secret is an environment value, not a file`)
  if (!String(env.GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET__FILE ?? '').startsWith('/run/secrets/')) out.push(`${label}: no client secret file`)
  const pathExpr = String(env.GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH ?? '')
  if (!/contains\(realm_access\.roles\[\*\], *'operator'\)/.test(pathExpr)) out.push(`${label}: the role path does not require the realm role operator`)
  if (!/acr *== *'loa2'/.test(pathExpr)) out.push(`${label}: the role path does not require acr == 'loa2'`)
  if (!/&& *'Admin' *\|\| *''$/.test(pathExpr)) out.push(`${label}: the role path does not map a refusal to ''`)
  if (!is('GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_STRICT', 'true')) out.push(`${label}: role_attribute_strict is off (a refused role would become Viewer)`)
  if (env.GF_SMTP_PASSWORD !== undefined) out.push(`${label}: the SMTP password is an environment value, not a file`)
  return out
}

/** The grafana client of docker/keycloak/realm-export.ops.json (Q5). */
export function grafanaClientViolations(realm) {
  const out = []
  if (realm?.realm !== 'platform') out.push(`realm ${realm?.realm}: the grafana client belongs to the platform realm only`)
  const c = (realm?.clients ?? []).find((x) => x.clientId === 'grafana')
  if (!c) return [...out, 'realm-export.ops.json carries no grafana client']
  // Keycloak stores a client description in VARCHAR(255): a longer one makes
  // creating the whole realm fail (measured by observability-proof.sh).
  for (const cl of realm.clients ?? []) {
    if (String(cl.description ?? '').length > 255) out.push(`${cl.clientId}: description is ${String(cl.description).length} characters, Keycloak's column holds 255`)
  }
  if (c.publicClient !== false) out.push('grafana: not a confidential client')
  if (c.standardFlowEnabled !== true) out.push('grafana: the code flow is off')
  for (const k of ['implicitFlowEnabled', 'directAccessGrantsEnabled', 'serviceAccountsEnabled']) if (c[k] !== false) out.push(`grafana: ${k} is not false`)
  if (JSON.stringify(c.redirectUris) !== JSON.stringify(['http://127.0.0.1:3000/login/generic_oauth'])) out.push(`grafana: redirectUris ${JSON.stringify(c.redirectUris)} is not exactly the loopback callback`)
  const a = c.attributes ?? {}
  if (a['pkce.code.challenge.method'] !== 'S256') out.push('grafana: PKCE S256 is not required')
  if (a['default.acr.values'] !== 'loa2') out.push('grafana: default ACR is not loa2')
  if (a['minimum.acr.value'] !== 'loa2') out.push('grafana: minimum ACR is not loa2')
  if (c.fullScopeAllowed !== false) out.push('grafana: fullScopeAllowed is not false')
  if (c.secret !== undefined) out.push('grafana: the template carries a client secret (Keycloak generates it; gremion-tenant writes it to etc/secrets/grafana)')
  const mappers = c.protocolMappers ?? []
  const acr = mappers.find((m) => m.protocolMapper === 'oidc-acr-mapper')
  if (acr?.config?.['id.token.claim'] !== 'true') out.push('grafana: no acr mapper into the ID token')
  const roles = mappers.find((m) => m.protocolMapper === 'oidc-usermodel-realm-role-mapper')
  if (roles?.config?.['id.token.claim'] !== 'true' || roles?.config?.['claim.name'] !== 'realm_access.roles' || roles?.config?.multivalued !== 'true') {
    out.push('grafana: no multivalued realm-role mapper into the ID token at realm_access.roles')
  }
  const scope = (realm.scopeMappings ?? []).filter((s) => s.client === 'grafana')
  if (scope.length !== 1 || JSON.stringify(scope[0].roles) !== JSON.stringify(['operator'])) out.push('grafana: its scope is not exactly the realm role operator')
  return out
}

// ── alerting (TRD-182, TDD 4/6) ────────────────────────────────────────────

export const RECORD_PREFIX = 'gremion:cond:'
/** Conditions with no absent() arm, each with its reason in rules.yml. */
export const NO_ABSENT = new Set([
  'gremion:cond:third_party_unreachable',
  // TASK-079: a host without an events service has no gauge; an absent() arm would fire there for ever.
  'gremion:cond:outbox_dead_lettered',
  'gremion:cond:inbox_dead_lettered',
  'gremion:cond:inbox_stalled',
  'gremion:cond:dead_letter_queue',
])

export function recordingRuleViolations(rulesDoc) {
  const out = []
  const rules = (rulesDoc?.groups ?? []).flatMap((g) => g.rules ?? [])
  if (rules.length === 0) out.push('rules.yml: zero recording rules')
  for (const r of rules) {
    if (!String(r.record ?? '').startsWith(RECORD_PREFIX)) out.push(`rules.yml: ${r.record ?? r.alert}: not a ${RECORD_PREFIX}* recording rule (alerting is Grafana's)`)
    if (!NO_ABSENT.has(r.record) && !/absent\(/.test(String(r.expr))) out.push(`rules.yml: ${r.record} has no absent() arm -- a blind collector would read healthy`)
    if (!/"component"|component/.test(String(r.expr))) out.push(`rules.yml: ${r.record} sets no component label`)
  }
  return out
}

const DURATION = /^(\d+)(ms|s|m|h|d|w|y)$/
export function seconds(d) {
  const m = DURATION.exec(String(d ?? '').trim())
  if (!m) return NaN
  const f = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 }[m[2]]
  return Number(m[1]) * f
}

export function grafanaRuleViolations(grafanaDoc, rulesDoc) {
  const out = []
  const records = new Set((rulesDoc?.groups ?? []).flatMap((g) => g.rules ?? []).map((r) => r.record))
  const rules = (grafanaDoc?.groups ?? []).flatMap((g) => g.rules ?? [])
  if (rules.length === 0) out.push('grafana rules: zero rules')
  const used = new Set()
  const titles = new Set()
  for (const r of rules) {
    const t = r.title
    if (titles.has(t)) out.push(`grafana rules: duplicate title ${t}`)
    titles.add(t)
    const a = (r.data ?? []).find((d) => d.refId === 'A')
    const b = (r.data ?? []).find((d) => d.refId === r.condition)
    const expr = String(a?.model?.expr ?? '')
    if (a?.datasourceUid !== 'prometheus') out.push(`${t}: query A does not read the prometheus datasource`)
    if (!records.has(expr)) out.push(`${t}: query A (${expr}) is not one recording rule of rules.yml`)
    used.add(expr)
    const ev = b?.model?.conditions?.[0]?.evaluator
    if (b?.model?.type !== 'threshold' || b?.model?.expression !== 'A' || ev?.type !== 'gt' || Number(ev?.params?.[0]) !== 0) out.push(`${t}: the condition is not threshold(A) > 0`)
    if (r.noDataState !== 'Alerting') out.push(`${t}: noDataState is ${r.noDataState}, want Alerting (no data is not healthy)`)
    if (r.execErrState !== 'Alerting') out.push(`${t}: execErrState is ${r.execErrState}, want Alerting`)
    if (!(seconds(r.for) > 0)) out.push(`${t}: no pending period (for)`)
    if (r.isPaused) out.push(`${t}: paused`)
  }
  for (const rec of records) if (!used.has(rec)) out.push(`grafana rules: ${rec} has no Grafana rule -- a condition nobody alerts on`)
  return out
}

/** TDD 6: the policy (TRD-182). */
export function policyViolations(policyDoc) {
  const out = []
  const p = policyDoc?.policies?.[0]
  if (!p) return ['policies.yaml: no root policy']
  const g = p.group_by ?? []
  if (!g.includes('alertname')) out.push(`policy: group_by [${g.join(', ')}] lacks alertname`)
  if (!g.includes('component')) out.push(`policy: group_by [${g.join(', ')}] lacks component`)
  if (seconds(p.repeat_interval) < seconds('8760h')) out.push(`policy: repeat_interval ${p.repeat_interval} is under 8760h (an open condition would be re-sent)`)
  if (!(seconds(p.group_wait) > 0) || !(seconds(p.group_interval) > 0)) out.push('policy: group_wait or group_interval missing')
  if (p.receiver !== 'platform') out.push(`policy: receiver ${p.receiver}, want platform (render-ops.sh renders it)`)
  return out
}

/** The contact point render-ops.sh writes: every integration sends resolves. */
export function contactPointViolations(contactDoc) {
  const out = []
  const cps = contactDoc?.contactPoints ?? []
  const cp = cps.find((c) => c.name === 'platform')
  if (!cp) return ['contact points: no platform contact point']
  if ((cp.receivers ?? []).length === 0) out.push('contact point platform: no integration')
  for (const r of cp.receivers ?? []) {
    if (r.disableResolveMessage !== false) out.push(`contact point platform/${r.uid}: resolve notices are off`)
  }
  return out
}

// ── retention (R29-I6: 30 days at most, worst case) ────────────────────────

export const CEILING_S = 30 * 86400
export const LOKI_CLASSES = ['access', 'application', 'audit', 'finance', 'security']

export function lokiRetentionViolations(loki) {
  const out = []
  const c = loki?.compactor ?? {}
  const l = loki?.limits_config ?? {}
  if (c.retention_enabled !== true) out.push('loki: compactor retention is not enabled -- Loki would keep every line for ever')
  const index = (loki?.schema_config?.configs ?? []).map((x) => seconds(x?.index?.period))
  const indexS = Math.max(...index, 0)
  if (!(indexS > 0)) out.push('loki: no index period')
  const extra = indexS + seconds(c.retention_delete_delay ?? '2h') + seconds(c.compaction_interval ?? '10m')
  const check = (what, period) => {
    const p = seconds(period)
    if (!(p > 0)) out.push(`loki: ${what} has no retention period`)
    else if (p + extra > CEILING_S) out.push(`loki: ${what} ${period} reaches ${((p + extra) / 86400).toFixed(2)} d in the worst case, above the 30-day ceiling`)
  }
  check('the global retention_period', l.retention_period)
  const streams = l.retention_stream ?? []
  for (const cls of LOKI_CLASSES) {
    const s = streams.find((x) => String(x.selector).replace(/\s/g, '') === `{class="${cls}"}`)
    if (!s) out.push(`loki: no retention stream for class=${cls}`)
    else check(`class=${cls}`, s.period)
  }
  for (const s of streams) check(`stream ${s.selector}`, s.period)
  return out
}

export function tempoRetentionViolations(tempo, { regularS = 7 * 86400 } = {}) {
  const r = seconds(tempo?.compactor?.compaction?.block_retention)
  if (!(r > 0)) return ['tempo: no block_retention (traces kept for ever)']
  return r > regularS ? [`tempo: block_retention ${tempo.compactor.compaction.block_retention} exceeds the 7-day RC-LOG-TRC window`] : []
}

/**
 * Prometheus' worst case, not its flag: it deletes WHOLE blocks only, a block
 * spans up to 10 % of the retention window (at most 31 d, the default of
 * --storage.tsdb.max-block-duration), and the deletion runs after a compaction
 * (every 2 h). So the oldest sample on disk is window + min(10 %, 31 d) + 2 h.
 */
export const PROM_COMPACTION_S = 2 * 3600
export function promWorstCaseSeconds(value) {
  const s = seconds(value)
  return s + Math.min(s / 10, 31 * 86400) + PROM_COMPACTION_S
}

export function promRetentionViolations(value) {
  const s = seconds(value)
  if (!(s > 0)) return [`prometheus: PROM_RETENTION_TIME ${value} is not a duration`]
  const worst = promWorstCaseSeconds(value)
  return worst > CEILING_S
    ? [`prometheus: PROM_RETENTION_TIME ${value} reaches ${(worst / 86400).toFixed(2)} d in the worst case (window + 10 % block span + 2 h compaction), above the 30-day ceiling`]
    : []
}

// ── TRD-199: no member-facing surface ──────────────────────────────────────

/** What a council render or member-facing source must never name. */
export function opsReferencePattern(stack) {
  return new RegExp(`(\\b(grafana|loki|tempo|alloy)(:[0-9]+|\\b)|${stack.replace(/[^A-Za-z0-9]/g, '.')}-ops_ops|\\bprometheus:9090\\b)`, 'i')
}

export function renderReferenceViolations(renders, stack) {
  const out = []
  const re = opsReferencePattern(stack)
  for (const { id, render } of renders) {
    for (const [name, svc] of services(render)) {
      const text = JSON.stringify({ environment: svc.environment ?? {}, command: svc.command ?? null, entrypoint: svc.entrypoint ?? null, labels: svc.labels ?? {}, extra_hosts: svc.extra_hosts ?? null, networks: svc.networks ?? {} })
      const m = re.exec(text)
      if (m) out.push(`${id}/${name}: references the ops side (${m[0]})`)
    }
    for (const [key, def] of Object.entries(render?.networks ?? {})) {
      if (re.test(String(def?.name ?? key))) out.push(`${id}: joins the ops network ${def?.name ?? key}`)
    }
  }
  return out
}

/** The member-facing source trees (lane note: not apps/control-panel). */
export function memberSourceRoots(root = REPO_ROOT) {
  const roots = ['gremion-ui/src', 'gremion-public/src']
  const mods = path.join(root, 'modules')
  if (existsSync(mods)) for (const m of readdirSync(mods)) if (existsSync(path.join(mods, m, 'app'))) roots.push(`modules/${m}/app`)
  return roots
}

export function sourceReferenceScan(root = REPO_ROOT, roots = memberSourceRoots(root)) {
  const hits = []
  let files = 0
  const re = /grafana|\b(loki|tempo|alloy):[0-9]+/i
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const p = path.join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (/\.(svelte|ts|js|mjs|html|json)$/.test(name)) {
        files++
        const text = readFileSync(p, 'utf8')
        if (re.test(text)) hits.push(path.relative(root, p).replace(/\\/g, '/'))
      }
    }
  }
  for (const r of roots) if (existsSync(path.join(root, r))) walk(path.join(root, r))
  return { files, hits }
}
