#!/usr/bin/env node
/**
 * The pooled-stack guard (TASK-040; PRD-PLAT-005, TRD-440/038/177/045).
 *
 *   node scripts/check-pooled-stack.mjs
 *
 * ONE state project, TWO app projects (blue/green), and the two non-council
 * projects (ops, mail) -- every one rendered exactly as the host renders it,
 * `docker compose --env-file <project>.env config`, with EVERY profile on
 * (COMPOSE_PROFILES='*'), from the fixed env files under
 * test/host/fixtures/pooled-stack/. A profile-gated service that no render
 * shows is a service no rule reads, so no profile is left off.
 *
 * The rules, each a post-condition read out of a render, never an exit code:
 *
 *   LIMITS (TRD-177)   every service of every render declares a non-zero
 *                      deploy.resources.limits.memory AND .cpus; a render with
 *                      zero services is itself a failure.
 *   STATE PURITY       the state render carries no app-tier service, no global
 *                      `gremion_*` name, no first-party service without an
 *                      image:, mailpit only under profiles: [dev], no
 *                      cloudflared.
 *   APP SHAPE          both colours: traefik.enable=false, the <svc>-<colour>
 *   (TRD-038)          alias on every shared network, COLOUR set, the evict
 *                      label on long-running services, profile-gated one-shots,
 *                      no traefik.http.* label, every depends_on resolved inside
 *                      the render, and NO volume that is not external -- a
 *                      colour switch must never own persisted data.
 *   COLOUR SUFFIX      no app-tier env value names a first-party service
 *                      without its -<colour> suffix.
 *   ISOLATION          the placement table below is the contract: every
 *   (TRD-045)          service of every render is in it, on exactly its
 *                      networks; no non-council service shares a network with
 *                      any service on ${STACK}_state; vector has no network;
 *                      the socket proxy sits on the private socket net only;
 *                      every docker-routed service names
 *                      traefik.docker.network=${STACK}_edge.
 *
 * The running half (container limits, idle RSS, network membership, the TCP
 * probes) is test/host/integration/pooled-stack-proof.sh.
 */

import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPO_ROOT, readEnvFile, renderState } from './compose-edge.mjs'
import { appTierServiceNames, renderColourViolations } from './verify/render/colour-suffix.mjs'

export { REPO_ROOT }

export const FIXTURE_DIR = 'test/host/fixtures/pooled-stack'

/** The five projects the guard renders: env file (repo-relative) and cwd. */
export const PROJECTS = [
  { id: 'state', envFile: `${FIXTURE_DIR}/state.env`, cwd: '.' },
  { id: 'app-blue', colour: 'blue', envFile: `${FIXTURE_DIR}/app-blue.env`, cwd: '.' },
  { id: 'app-green', colour: 'green', envFile: `${FIXTURE_DIR}/app-green.env`, cwd: '.' },
  // TASK-039: the ops project moved to compose/observability/.
  { id: 'ops', envFile: `${FIXTURE_DIR}/ops.env`, cwd: 'compose/observability' },
  { id: 'mail', envFile: `${FIXTURE_DIR}/mail.env`, cwd: 'infra/host/mail' },
]

export const APP_SERVICES = ['gremion-ui', 'gremion-public', 'control-panel', 'migrate', 'tenant-create', 'kernel-api', 'kernel-api-migrate']
export const LONG_RUNNING_APP = ['gremion-ui', 'gremion-public', 'control-panel', 'kernel-api']
/**
 * Services whose source declares the evict endpoint gremion-switch POSTs to
 * (value = the file that is the evidence). kernel-api is deliberately absent:
 * it serves only routes from openapi/kernel-core.json; its evict route is
 * TASK-035's, and the label would make every switch abort on a non-204.
 * Only a literal `routes/api/internal/evict/+server.ts` with a POST export counts
 * as evidence (check-pooled-stack.test.mjs enforces it). gremion-public is
 * deliberately absent: it serves no such route and caches no tenant, so the
 * label would make every gremion-switch abort on a non-204. gremion-ui serves
 * the route (Bearer INTERNAL_PUSH_SECRET, clears the tenant runtime caches) in
 * addition to its tenant_evict NOTIFY listener.
 */
export const EVICT_IMPLEMENTERS = {
  'gremion-ui': 'gremion-ui/src/routes/api/internal/evict/+server.ts',
  'control-panel': 'apps/control-panel/src/routes/api/internal/evict/+server.ts',
}
export const ONE_SHOTS = { migrate: 'migrate', 'tenant-create': 'tenant-create', 'kernel-api-migrate': 'kernel-api-migrate' }
export const MODULE_POSTGRES_IDS = ['board', 'calendar', 'content', 'finance', 'newsletter', 'vault', 'messaging']
/**
 * TASK-084-a: dedicated service servers (governance-postgres), state-tier stores like the module servers.
 * The pilot adds nextcloud-postgres (label service:nextcloud, profile nextcloud). It is a SERVICE server,
 * not a module's: MODULE_POSTGRES_IDS drives the module_pg_admin_<id> files of tenant-create, and
 * Nextcloud's own database is not a per-customer module database.
 */
export const SERVICE_POSTGRES_IDS = ['governance', 'nextcloud']
/** The leaf services app.env.tmpl names (content-service ... vault-service). */
export const LEAF_SERVICES = ['content', 'finance', 'files', 'votes', 'messages', 'newsletter', 'calendar', 'board', 'vault'].map(
  (l) => `${l}-service`,
)
export const FIRST_PARTY_IMAGE = /^ghcr\.io\/hello-n00del\/gremion-/
/**
 * The pilot's module leaves in the APP project (docker-compose.app.yml): service -> the one compose profile
 * that gates it. Calendar, content and newsletter run as leaves (the evidence case table of the isolation
 * task and the running path are the same code); every other module is in-process. A leaf is long-running
 * but profile-gated, which the APP SHAPE rule would otherwise refuse, so this table is its exemption.
 */
export const LEAF_PROFILES = {
  'calendar-service': 'calendar',
  'content-service': 'content',
  'newsletter-service': 'newsletter',
}

// ── the placement table (TRD §2.1 topology, §2.2 workload classes) ─────────
//
// class: council-store | council | council-edge | council-logs | dev |
//        council-app | council-oneshot | non-council
// networks: LOGICAL names, resolved per project by resolveNet() below.
//   state  -> ${STACK}_state      edge -> ${STACK}_edge
//   socket -> ${STACK}-state_socket (project-scoped, private to traefik)
//   app    -> ${STACK}-app-<colour>_app
//   ops    -> ${STACK}-ops_ops    mail -> ${STACK}-mail_mail
//   none   -> network_mode: none
const store = { class: 'council-store', networks: ['state'] }
export const PLACEMENT = {
  state: {
    postgres: store,
    ...Object.fromEntries(MODULE_POSTGRES_IDS.map((id) => [`${id}-postgres`, store])),
    ...Object.fromEntries(SERVICE_POSTGRES_IDS.map((id) => [`${id}-postgres`, store])),
    pgbouncer: store,
    // TASK-024: the NATS broker is state-tier data (JetStream store) reached
    // only over ${STACK}_state by name, like the databases.
    nats: store,
    // The pilot's Nextcloud cache (profile nextcloud); its server, nextcloud-postgres, is a
    // SERVICE_POSTGRES_IDS row above.
    'nextcloud-redis': store,
    keycloak: { class: 'council', networks: ['edge', 'state'] },
    // TASK-198: the chat module's Synapse (profiles: [messaging]); the app tier
    // reaches it on _state. It publishes nothing, but Traefik routes /_matrix on the
    // platform host to it, so it is on _edge as well (docker-compose.prod.yml).
    matrix: { class: 'council', networks: ['edge', 'state'] },
    // The pilot's file and office services (docs/ops/pilot-services.md). Nextcloud is reached
    // only by name on _state (no router); Collabora is routed per tenant host through the
    // edge's file provider, so it is on _edge too; Element Call has no router (gremion-ui
    // proxies it) and sits on _state.
    nextcloud: { class: 'council', networks: ['state'] },
    collabora: { class: 'council', networks: ['edge', 'state'] },
    'element-call': { class: 'council', networks: ['state'] },
    // LiveKit publishes its RTC ports on the edge addresses and is routed on _edge; it has no
    // data store and no route to one (not on _state).
    livekit: { class: 'council-edge', networks: ['edge'] },
    legal: { class: 'council-edge', networks: ['edge'] },
    fallback: { class: 'council-edge', networks: ['edge'] },
    traefik: { class: 'council-edge', networks: ['edge', 'socket'] },
    'docker-socket-proxy': { class: 'council-edge', networks: ['socket'] },
    vector: { class: 'council-logs', networks: ['none'] },
    mailpit: { class: 'dev', networks: ['state'] },
  },
  app: {
    'gremion-ui': { class: 'council-app', networks: ['app', 'edge', 'state'] },
    'gremion-public': { class: 'council-app', networks: ['app', 'edge', 'state'] },
    // TASK-043 Q12: no edge network, no published port, no Traefik route.
    'control-panel': { class: 'council-app', networks: ['app', 'state'] },
    migrate: { class: 'council-oneshot', networks: ['state'] },
    'tenant-create': { class: 'council-oneshot', networks: ['edge', 'state'] },
    // TASK-077 G7: the kernel API serves tenancy + the module registry to the
    // app tier and the modules; internal only (no edge, no port, no router).
    'kernel-api': { class: 'council-app', networks: ['app', 'state'] },
    'kernel-api-migrate': { class: 'council-oneshot', networks: ['state'] },
    // The pilot's module leaves (LEAF_PROFILES): internal only, reached by their colour-suffixed
    // alias on _app and _state, no edge network, no port, no Traefik route.
    ...Object.fromEntries(Object.keys(LEAF_PROFILES).map((l) => [l, { class: 'council-app', networks: ['app', 'state'] }])),
  },
  // TASK-039: the observability stack. On `ops` only: no ops service shares a
  // network with _state or with Keycloak (TRD-203, TRD-111); the OTLP ingest
  // is a published port, never a shared network (Q15).
  ops: Object.fromEntries(
    ['grafana', 'prometheus', 'loki', 'tempo', 'alloy', 'blackbox'].map((s) => [s, { class: 'non-council', networks: ['ops'] }]),
  ),
  mail: { stalwart: { class: 'non-council', networks: ['mail'] } },
}

/** The placement-table section a project id reads. */
export const tableFor = (projectId) => (projectId.startsWith('app-') ? 'app' : projectId)

export function resolveNet(logical, stack, projectId) {
  switch (logical) {
    case 'state':
    case 'edge':
      return `${stack}_${logical}`
    case 'socket':
      return `${stack}-state_socket`
    case 'app':
      return `${stack}-${projectId}_app`
    case 'ops':
      return `${stack}-ops_ops`
    case 'mail':
      return `${stack}-mail_mail`
    case 'none':
      return 'none'
    default:
      throw new Error(`unknown logical network ${logical}`)
  }
}

// ── helpers over one render ────────────────────────────────────────────────

const services = (r) => Object.entries(r?.services ?? {})
const labelsOf = (svc) => {
  const l = svc.labels ?? {}
  if (Array.isArray(l)) {
    return Object.fromEntries(l.map((s) => [String(s).split('=')[0], String(s).split('=').slice(1).join('=')]))
  }
  return l
}

/** The RESOLVED network names a rendered service is attached to. */
export function serviceNetworks(render, svc) {
  if (svc.network_mode !== undefined) return [String(svc.network_mode)]
  const keys = Array.isArray(svc.networks) ? svc.networks : Object.keys(svc.networks ?? {})
  return keys.map((k) => render.networks?.[k]?.name ?? k).sort()
}

const positive = (v) => {
  if (v === undefined || v === null || v === '') return false
  const n = Number(String(v).trim())
  return Number.isFinite(n) && n > 0
}

// ── LIMITS (TRD-177) ───────────────────────────────────────────────────────

export function limitsViolations(render, label = 'render') {
  const out = []
  const svcs = services(render)
  if (svcs.length === 0) out.push(`${label}: renders zero services -- the limit rule would pass vacuously`)
  for (const [name, svc] of svcs) {
    const lim = svc.deploy?.resources?.limits ?? {}
    if (!positive(lim.memory)) out.push(`${label}/${name}: no non-zero deploy.resources.limits.memory (got ${JSON.stringify(lim.memory ?? null)})`)
    if (!positive(lim.cpus)) out.push(`${label}/${name}: no non-zero deploy.resources.limits.cpus (got ${JSON.stringify(lim.cpus ?? null)})`)
  }
  return out
}

// ── STATE PURITY ───────────────────────────────────────────────────────────

/** No volume or network in ANY render carries a global gremion_* name. */
export function globalNameViolations(render, label = 'render') {
  const out = []
  for (const kind of ['volumes', 'networks']) {
    for (const [key, def] of Object.entries(render?.[kind] ?? {})) {
      if (String(def?.name ?? '').startsWith('gremion_')) out.push(`${label}: ${kind}.${key} carries the global name ${def.name}`)
    }
  }
  return out
}

export function statePurityViolations(render, label = 'state') {
  const out = [...globalNameViolations(render, label)]
  const svcs = render?.services ?? {}
  if (Object.keys(svcs).length === 0) out.push(`${label}: renders zero services`)
  for (const s of APP_SERVICES) if (svcs[s]) out.push(`${label}: carries the app-tier service ${s} (it lives only in docker-compose.app.yml)`)
  if (svcs.cloudflared) out.push(`${label}: carries cloudflared, which is not in the topology (PRD §10.2 "Edge CDN: none")`)
  for (const [name, svc] of services(render)) {
    const firstParty = svc.build !== undefined || FIRST_PARTY_IMAGE.test(String(svc.image ?? ''))
    if (firstParty && !svc.image) out.push(`${label}/${name}: first-party service without an image: key`)
  }
  if (svcs.mailpit) {
    const p = svcs.mailpit.profiles ?? []
    if (p.length !== 1 || p[0] !== 'dev') out.push(`${label}/mailpit: not gated under profiles: [dev] (has [${p.join(', ')}]) -- TRD topology "mailpit: not deployed"`)
  }
  return out
}

// ── APP SHAPE (TRD-038) ────────────────────────────────────────────────────

export function appShapeViolations(render, colour, stack, label = `app-${colour}`) {
  const out = [...globalNameViolations(render, label)]
  const svcs = render?.services ?? {}
  const shared = new Set([`${stack}_edge`, `${stack}_state`])
  for (const s of APP_SERVICES) if (!svcs[s]) out.push(`${label}: ${s} is absent from the render`)
  for (const [name, svc] of services(render)) {
    const labels = labelsOf(svc)
    if (String(labels['traefik.enable']) !== 'false') out.push(`${label}/${name}: traefik.enable is ${JSON.stringify(labels['traefik.enable'] ?? null)}, want "false" (app tier is reached only through etc/edge/active.yml)`)
    const routerKeys = Object.keys(labels).filter((k) => k.startsWith('traefik.http.'))
    if (routerKeys.length) out.push(`${label}/${name}: carries docker-provider labels ${routerKeys.join(', ')}`)
    if (String(svc.environment?.COLOUR ?? '') !== colour) out.push(`${label}/${name}: environment.COLOUR is ${JSON.stringify(svc.environment?.COLOUR ?? null)}, want ${colour}`)
    for (const [key, att] of Object.entries(svc.networks ?? {})) {
      const net = render.networks?.[key]?.name ?? key
      if (!shared.has(net)) continue
      const aliases = att?.aliases ?? []
      if (!aliases.includes(`${name}-${colour}`)) out.push(`${label}/${name}: no ${name}-${colour} alias on ${net}`)
    }
    if (name in EVICT_IMPLEMENTERS && String(labels['gremion.evict']) !== 'true') out.push(`${label}/${name}: long-running service without gremion.evict=true`)
    if (String(labels['gremion.evict']) === 'true' && !(name in EVICT_IMPLEMENTERS)) out.push(`${label}/${name}: carries gremion.evict=true but is not a known evict implementer (gremion-switch requires a 204 from it; a service with no /api/internal/evict aborts every switch)`)
    if (ONE_SHOTS[name]) {
      const p = svc.profiles ?? []
      if (p.length !== 1 || p[0] !== ONE_SHOTS[name]) out.push(`${label}/${name}: one-shot not gated under profiles: [${ONE_SHOTS[name]}] (has [${p.join(', ')}])`)
      if (String(svc.restart ?? '') !== 'no') out.push(`${label}/${name}: one-shot restart is ${JSON.stringify(svc.restart ?? null)}, want "no"`)
    } else if (name in LEAF_PROFILES) {
      // A leaf is gated by exactly its own module profile: gremion-init-secrets renders the profile
      // for a pilot module into COMPOSE_PROFILES, so an `up` starts it for that module only.
      const p = svc.profiles ?? []
      if (p.length !== 1 || p[0] !== LEAF_PROFILES[name]) out.push(`${label}/${name}: leaf not gated under profiles: [${LEAF_PROFILES[name]}] (has [${p.join(', ')}])`)
    } else if ((svc.profiles ?? []).length) {
      out.push(`${label}/${name}: long-running service is profile-gated ([${svc.profiles.join(', ')}]) -- up would not start it`)
    }
    for (const dep of Object.keys(svc.depends_on ?? {})) {
      if (!svcs[dep]) out.push(`${label}/${name}: depends_on ${dep}, which this project does not contain (cross-project ordering is TASK-023's boot retry)`)
    }
    for (const v of svc.volumes ?? []) {
      if (v.type !== 'volume') continue
      const def = v.source ? render.volumes?.[v.source] : undefined
      if (!v.source) out.push(`${label}/${name}: anonymous volume at ${v.target} -- the colour would own persisted data`)
      else if (!def?.external) out.push(`${label}/${name}: volume ${v.source} is not external -- the colour would own persisted data (TRD-038)`)
    }
  }
  for (const [key, def] of Object.entries(render?.volumes ?? {})) {
    if (!def?.external) out.push(`${label}: top-level volume ${key} is not external (TRD-038)`)
  }
  return out
}

// ── COLOUR SUFFIX ──────────────────────────────────────────────────────────

export function colourSuffixViolations(render, colour, label = `app-${colour}`) {
  // TASK-053 G2: the ONE reference predicate lives in
  // scripts/verify/render/colour-suffix.mjs. Its name set is the union of this
  // list, the render's first-party-image services and app.env.tmpl's
  // -${COLOUR} hosts (a strict superset of the list-bound scan this replaced);
  // HOST tokens only (URL authority, whole *HOST value), longest name first.
  const names = appTierServiceNames({ renders: [render], extra: [...APP_SERVICES, ...LEAF_SERVICES] })
  return renderColourViolations(render, colour, names, label)
}

// ── ISOLATION (TRD-045) ────────────────────────────────────────────────────

/**
 * TASK-084-a: the services whose /run/secrets/tenants bind mount (read-only on
 * all but tenant-create) has the per-customer governance credential directory as its
 * host source or a PARENT of it. Pure path math on the rendered sources: such a
 * mount would hand every governance credential to the tenant data plane.
 */
export function tenantMountsExposeGovernance(render, governanceHostDir) {
  const norm = (p) => path.posix.normalize(String(p).replaceAll('\\', '/')).replace(/\/$/, '')
  const gov = norm(governanceHostDir)
  const out = []
  for (const [name, svc] of Object.entries(render.services ?? {})) {
    for (const v of svc.volumes ?? []) {
      if (v.target !== '/run/secrets/tenants' || v.type !== 'bind') continue
      const rel = path.posix.relative(norm(v.source), gov)
      // only a real parent step ('..' or '../x') means the governance directory is outside the mount source
      if (rel === '' || (rel !== '..' && !rel.startsWith('../'))) out.push(name)
    }
  }
  return [...new Set(out)]
}

/**
 * renders: [{ id, render }] over every project. The placement table is the
 * contract; every service must be in it, on exactly its networks.
 */
export function isolationViolations(renders, stack) {
  const out = []
  const stateNet = `${stack}_state`
  const edgeNet = `${stack}_edge`
  const onState = new Set() // resolved nets of every service attached to _state
  const nonCouncil = []
  for (const { id, render } of renders) {
    const table = PLACEMENT[tableFor(id)]
    if (!table) {
      out.push(`${id}: a project the placement table does not classify`)
      continue
    }
    if (services(render).length === 0) out.push(`${id}: renders zero services -- isolation would pass vacuously`)
    for (const [name, svc] of services(render)) {
      const row = table[name]
      const nets = serviceNetworks(render, svc)
      if (!row) {
        out.push(`${id}/${name}: not in the placement table (TRD-045 contract) -- classify it before it ships`)
        continue
      }
      const want = row.networks.map((n) => resolveNet(n, stack, id)).sort()
      if (JSON.stringify(nets) !== JSON.stringify(want)) out.push(`${id}/${name}: networks [${nets.join(', ')}], placement table says [${want.join(', ')}]`)
      if (nets.includes(stateNet)) for (const n of nets) onState.add(n)
      // A host port on a _state service is a route to it from every other
      // bridge network (measured on the scratch proof, Docker 29: a published
      // postgres answered pg_isready from the ops network; unpublished, it
      // did not). Dev publishes through the override, which no host renders.
      if (nets.includes(stateNet) && (svc.ports ?? []).length) {
        const pub = svc.ports.map((p) => `${p.host_ip ?? '*'}:${p.published ?? '?'}->${p.target}`).join(', ')
        out.push(`${id}/${name}: on ${stateNet} and publishes host port(s) ${pub} -- reachable from every non-council network`)
      }
      if (row.class === 'non-council') nonCouncil.push({ id, name, nets })
      const labels = labelsOf(svc)
      if (String(labels['traefik.enable']) === 'true') {
        if (labels['traefik.docker.network'] !== edgeNet) out.push(`${id}/${name}: docker-routed without traefik.docker.network=${edgeNet} (got ${JSON.stringify(labels['traefik.docker.network'] ?? null)})`)
        if (!nets.includes(edgeNet)) out.push(`${id}/${name}: docker-routed but not on ${edgeNet}`)
      }
    }
  }
  for (const { id, name, nets } of nonCouncil) {
    const shared = nets.filter((n) => onState.has(n) && n !== 'none')
    if (shared.length) out.push(`${id}/${name}: non-council service shares [${shared.join(', ')}] with a service on ${stateNet}`)
  }
  return out
}

// ── PUBLISHES (spec A section A: nothing binds 0.0.0.0) ───────────────────

const WILDCARD_HOST_IPS = new Set(['', '0.0.0.0', '::', '[::]'])
const normHostIp = (ip) => {
  const v = String(ip ?? '').replace(/^\[|\]$/g, '')
  // an all-zero IPv6 spelling (`::0`, `0:0:0:0:0:0:0:0`) is the wildcard too
  return v.includes(':') && /^[0:]+$/.test(v) ? '::' : v
}

/**
 * Every published port of every service of one render names a host address that is not a wildcard.
 * A publish with no host address binds every interface, and compose renders an EMPTY interpolated
 * address (`:7881:7881`) exactly like that. The pilot's LiveKit publishes its RTC ports on the
 * edge addresses, so this reads the rendered `host_ip`, never the source text.
 */
export function portBindViolations(render, label = 'render') {
  const out = []
  for (const [name, svc] of services(render)) {
    for (const p of svc.ports ?? []) {
      if (WILDCARD_HOST_IPS.has(normHostIp(p.host_ip))) {
        out.push(`${label}/${name}: publishes ${p.published ?? '?'}->${p.target}/${p.protocol ?? 'tcp'} with no host address (${JSON.stringify(p.host_ip ?? '')}), which binds every interface`)
      }
    }
  }
  return out
}

// ── LEAVES (the pilot's calendar, content and newsletter services) ─────────

const urlOrNull = (u) => {
  try {
    return new URL(String(u))
  } catch {
    return null
  }
}

/**
 * The module leaves of one APP render, and the URLs gremion-ui reaches them by. A leaf, when it is in
 * the render, is internal only (no port, no edge network, no docker router label), carries the stack
 * label, and answers to `<leaf>-<colour>` on _app and _state. gremion-ui's <ID>_SERVICE_URL names
 * exactly that alias on the port the leaf listens on, so a URL cannot resolve to nothing. Every leaf
 * is expected in a profile-on render, and every leaf URL must resolve to an alias of the render.
 */
export function leafViolations(render, colour, stack, label = `app-${colour}`) {
  const out = []
  const svcs = render?.services ?? {}
  const ui = svcs['gremion-ui']
  for (const [leaf, profile] of Object.entries(LEAF_PROFILES)) {
    const svc = svcs[leaf]
    if (!svc) {
      out.push(`${label}: leaf ${leaf} is absent from the render (profile ${profile})`)
      continue
    }
    const nets = serviceNetworks(render, svc)
    const want = [`${stack}-app-${colour}_app`, `${stack}_state`].sort()
    if (JSON.stringify(nets) !== JSON.stringify(want)) out.push(`${label}/${leaf}: networks [${nets.join(', ')}], want [${want.join(', ')}] (no edge network)`)
    if ((svc.ports ?? []).length) out.push(`${label}/${leaf}: publishes a port -- a leaf is reachable only by its colour-suffixed name`)
    if (!labelsOf(svc)['org.gremion.stack']) out.push(`${label}/${leaf}: no org.gremion.stack label`)
    const port = String(svc.environment?.PORT ?? '')
    if (port !== '8080') out.push(`${label}/${leaf}: environment.PORT is ${JSON.stringify(port)}, want "8080" (the port gremion-ui's URL names)`)
    for (const key of Object.keys(svc.networks ?? {})) {
      const net = render.networks?.[key]?.name ?? key
      if (want.includes(net) && !(svc.networks[key]?.aliases ?? []).includes(`${leaf}-${colour}`)) {
        out.push(`${label}/${leaf}: no ${leaf}-${colour} alias on ${net}`)
      }
    }
    if (ui) {
      const id = leaf.replace(/-service$/, '').toUpperCase()
      const url = String(ui.environment?.[`${id}_SERVICE_URL`] ?? '')
      const u = urlOrNull(url)
      if (!u) out.push(`${label}/gremion-ui: ${id}_SERVICE_URL is ${JSON.stringify(url)}, not a URL`)
      else if (u.hostname !== `${leaf}-${colour}` || u.port !== '8080') out.push(`${label}/gremion-ui: ${id}_SERVICE_URL ${url} does not name ${leaf}-${colour}:8080`)
    }
  }
  if (ui) {
    // every leaf URL gremion-ui carries must resolve to an alias some service of this render answers to
    const aliases = new Set(Object.values(svcs).flatMap((s) => Object.values(s.networks ?? {}).flatMap((n) => n?.aliases ?? [])))
    for (const [k, v] of Object.entries(ui.environment ?? {})) {
      if (/^(CALENDAR|CONTENT|NEWSLETTER)_SERVICE_URL$/.test(k) && !aliases.has(urlOrNull(v)?.hostname)) {
        out.push(`${label}/gremion-ui: ${k} names ${urlOrNull(v)?.hostname ?? String(v)}, which no service of the render answers to`)
      }
    }
  }
  return out
}

// ── the CLI ────────────────────────────────────────────────────────────────

/** Renders one project with every profile on, from its fixed env file. */
export function renderProject(p, { env = {} } = {}) {
  const cwd = path.join(REPO_ROOT, p.cwd)
  // renderState seeds <cwd>/legal/legal.env for the root file's legal service;
  // ops and mail render from their own directories, where it is only litter.
  const legalDir = path.join(cwd, 'legal')
  const litter = p.cwd !== '.' && !existsSync(legalDir)
  try {
    return renderState({ envFile: p.envFile, cwd, env: { COMPOSE_PROFILES: '*', ...env } })
  } finally {
    if (litter) rmSync(legalDir, { recursive: true, force: true })
  }
}

export function runAll({ render = renderProject } = {}) {
  const problems = []
  const renders = []
  const stack = readEnvFile(`${FIXTURE_DIR}/state.env`).STACK
  if (!stack) problems.push(`${FIXTURE_DIR}/state.env declares no STACK`)
  for (const p of PROJECTS) {
    if (p.colour && !existsSync(path.join(REPO_ROOT, 'docker-compose.app.yml'))) {
      problems.push(`${p.id}: docker-compose.app.yml is absent -- no app tier to render`)
      continue
    }
    let r
    try {
      r = render(p)
    } catch (e) {
      problems.push(`${p.id}: render failed: ${String(e.message).split('\n')[0]}`)
      continue
    }
    renders.push({ id: p.id, render: r })
    problems.push(...limitsViolations(r, p.id))
    problems.push(...portBindViolations(r, p.id))
    if (p.colour) {
      // TASK-084-a: the governance credential directory is tenant-create's alone, and no tenant mount reaches it
      const gov = (r.services?.['tenant-create']?.volumes ?? []).find((v) => v.target === '/run/secrets/governance')
      if (!gov) problems.push(`${p.id}: tenant-create mounts no /run/secrets/governance`)
      else {
        for (const name of tenantMountsExposeGovernance(r, gov.source)) {
          problems.push(`${p.id}: ${name} mounts /run/secrets/tenants from a path that is, or contains, the governance credential directory ${gov.source}`)
        }
        for (const [name, svc] of Object.entries(r.services ?? {})) {
          if (name !== 'tenant-create' && (svc.volumes ?? []).some((v) => v.target === '/run/secrets/governance' || v.source === gov.source)) {
            problems.push(`${p.id}: ${name} mounts the governance credential directory`)
          }
        }
      }
    }
    if (p.id === 'state') problems.push(...statePurityViolations(r, p.id))
    else if (p.colour) {
      problems.push(...appShapeViolations(r, p.colour, stack, p.id))
      problems.push(...colourSuffixViolations(r, p.colour, p.id))
      problems.push(...leafViolations(r, p.colour, stack, p.id))
    } else problems.push(...globalNameViolations(r, p.id))
  }
  problems.push(...isolationViolations(renders, stack))
  const counts = Object.fromEntries(renders.map(({ id, render: r }) => [id, Object.keys(r.services ?? {}).length]))
  return { problems, counts }
}

const SELF = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const { problems, counts } = runAll()
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (problems.length) {
    for (const p of problems) console.error(`FAIL ${p}`)
    console.error(`[pooled-stack] ${problems.length} violation(s) over ${total} rendered service(s) ${JSON.stringify(counts)}`)
    process.exit(1)
  }
  if (total === 0) {
    console.error('[pooled-stack] zero services rendered -- refusing to pass vacuously')
    process.exit(1)
  }
  console.log(`[pooled-stack] OK: ${total} service(s) across ${Object.keys(counts).length} project(s) ${JSON.stringify(counts)}`)
}
