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

export const APP_SERVICES = ['gremion-ui', 'gremion-public', 'control-panel', 'migrate', 'tenant-create']
export const LONG_RUNNING_APP = ['gremion-ui', 'gremion-public', 'control-panel']
export const ONE_SHOTS = { migrate: 'migrate', 'tenant-create': 'tenant-create' }
export const MODULE_POSTGRES_IDS = ['board', 'calendar', 'content', 'finance', 'newsletter', 'vault']
/** The leaf services app.env.tmpl names (content-service ... vault-service). */
export const LEAF_SERVICES = ['content', 'finance', 'files', 'votes', 'messages', 'newsletter', 'calendar', 'board', 'vault'].map(
  (l) => `${l}-service`,
)
export const FIRST_PARTY_IMAGE = /^ghcr\.io\/hello-n00del\/gremion-/

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
    pgbouncer: store,
    // TASK-024: the NATS broker is state-tier data (JetStream store) reached
    // only over ${STACK}_state by name, like the databases.
    nats: store,
    keycloak: { class: 'council', networks: ['edge', 'state'] },
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
    if (LONG_RUNNING_APP.includes(name) && String(labels['gremion.evict']) !== 'true') out.push(`${label}/${name}: long-running service without gremion.evict=true`)
    if (ONE_SHOTS[name]) {
      const p = svc.profiles ?? []
      if (p.length !== 1 || p[0] !== ONE_SHOTS[name]) out.push(`${label}/${name}: one-shot not gated under profiles: [${ONE_SHOTS[name]}] (has [${p.join(', ')}])`)
      if (String(svc.restart ?? '') !== 'no') out.push(`${label}/${name}: one-shot restart is ${JSON.stringify(svc.restart ?? null)}, want "no"`)
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
    if (p.id === 'state') problems.push(...statePurityViolations(r, p.id))
    else if (p.colour) {
      problems.push(...appShapeViolations(r, p.colour, stack, p.id))
      problems.push(...colourSuffixViolations(r, p.colour, p.id))
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
