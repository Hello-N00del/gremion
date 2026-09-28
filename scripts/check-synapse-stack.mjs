#!/usr/bin/env node
// The chat module's Synapse in the state project -- static, repo-coupled
// checks (TASK-198, PRD-MSG-002; TRD-425, TRD-178). Two renders of the state
// project, never an `up`:
//
//   1. profile ON: the pooled-stack fixture env with COMPOSE_PROFILES=messaging
//      and the chat keys set. messaging-postgres and matrix must carry the
//      shape the brief grants (G1): the module-postgres anchor's pinned image,
//      its label and profile, a project-scoped data volume (no name:), ONE
//      bind -- the initdb script, read-only; matrix built from
//      modules/messaging/synapse as ghcr.io/hello-n00del/gremion-synapse, on
//      ${STACK}_state only, no ports, limits-l, the honest probe with its
//      start_period, depends_on messaging-postgres healthy, the section 5.2
//      environment and no bind at all.
//   2. profile OFF from .env.example as shipped: must render. A `${VAR:?}` on
//      any chat key would abort EVERY verb of every profile (compose
//      interpolates the whole document), which is why fail-closed lives in
//      the shim, the initdb script and the preflight instead. The raw text of
//      the two service blocks is scanned for `:?` as well.
//
// The wiring half (lint-synapse in `lint:` and CARVE_LINT_TARGETS, every
// module suite named by its recipe, synapse-proof in neither) is checked
// here too, so one guard owns the whole contract.
//
// Run:  node scripts/check-synapse-stack.mjs
// Test: node --test scripts/check-synapse-stack.test.mjs   (make lint-synapse)

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { REPO_ROOT, readEnvFile, renderState } from './compose-edge.mjs'

export const MODULE_DIR = 'modules/messaging/synapse'
export const POOLED_FIXTURE = 'test/host/fixtures/pooled-stack/state.env'
export const IMAGE_REPO = 'ghcr.io/hello-n00del/gremion-synapse'
export const INIT_TARGET = '/docker-entrypoint-initdb.d/10-synapse-db.sh'
export const INIT_SOURCE = `${MODULE_DIR}/postgres-init/10-synapse-db.sh`
export const PROBE = '/synapse-healthcheck.sh'
// start_period (brief section 5.5): SYNAPSE_KC_MAX key-fetch attempts of ~7 s
// each (curl --max-time 5 + sleep 2) plus the first boot measured by the
// scratch proof (phase b), rounded up.
export const KC_MAX_DEFAULT = 30
export const KC_ATTEMPT_S = 7
export const FIRST_BOOT_S = 30
export const START_PERIOD_S = KC_MAX_DEFAULT * KC_ATTEMPT_S + FIRST_BOOT_S
export const LIMITS_L = { memory: 1024 * 1024 * 1024, cpus: 1 }
/** The section 5.2 keys compose hands matrix; value = expected render (null: any). */
export const MATRIX_ENV = (domain) => ({
  SYNAPSE_SERVER_NAME: domain,
  MATRIX_PUBLIC_URL: `https://${domain}`,
  SYNAPSE_DB_HOST: 'messaging-postgres',
  SYNAPSE_DB_PORT: '5432',
  SYNAPSE_DB_NAME: 'synapse',
  SYNAPSE_DB_USER: 'synapse',
  SYNAPSE_DB_PASSWORD: null,
  SYNAPSE_KEYCLOAK_ISSUER_URL: null,
  SYNAPSE_KEYCLOAK_FETCH_URL: null,
  SYNAPSE_OIDC_CLIENT_SECRET: null,
  SYNAPSE_REGISTRATION_SHARED_SECRET: null,
  BOOTSTRAP_MODE: null,
  SYNAPSE_KC_MAX: null,
})
/** Keys the profile-on render sets (fixture values; documentation-only). */
export const PROFILE_ON_ENV = {
  COMPOSE_PROFILES: 'messaging',
  MESSAGING_PG_PASSWORD: 'guard-messaging-pg',
  SYNAPSE_DB_PASSWORD: 'guard-synapse-db',
  SYNAPSE_KEYCLOAK_ISSUER_URL: 'https://guard.example.org/auth/realms/guard',
}

const durationS = (v) => {
  if (typeof v === 'number') return v / 1e9 // compose renders nanoseconds
  const m = /^(?:(\d+)m)?(?:(\d+)s)?$/.exec(String(v ?? ''))
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) : NaN
}

/** Violations of the profile-on render. `stack`/`project` from the fixture. */
export function renderViolations(render, { stack, project, domain }) {
  const out = []
  const svcs = render?.services ?? {}
  const pg = svcs['messaging-postgres']
  const mx = svcs.matrix
  if (!pg) out.push('messaging-postgres is absent from the profile-on render')
  if (!mx) out.push('matrix is absent from the profile-on render')
  const vols = render?.volumes ?? {}
  for (const key of ['messaging-pg-data', 'synapse-data']) {
    const v = vols[key]
    if (!v) out.push(`top-level volume ${key} is not declared`)
    else if (v.external) out.push(`volume ${key} is external -- it must be the state project's own`)
    else if (v.name !== `${project}_${key}`) out.push(`volume ${key} realises as ${v.name}, want ${project}_${key} (no name: -- the backup enumeration reads the project label)`)
  }
  const onlyState = (name, svc) => {
    const keys = Array.isArray(svc.networks) ? svc.networks : Object.keys(svc.networks ?? {})
    const nets = keys.map((k) => render.networks?.[k]?.name ?? k)
    if (svc.network_mode !== undefined || JSON.stringify(nets) !== JSON.stringify([`${stack}_state`]))
      out.push(`${name}: networks [${nets.join(', ')}], want [${stack}_state] only`)
    if ((svc.ports ?? []).length) out.push(`${name}: publishes ports -- reachable from every non-council network`)
  }
  const profile = (name, svc) => {
    const p = svc.profiles ?? []
    if (p.length !== 1 || p[0] !== 'messaging') out.push(`${name}: profiles [${p.join(', ')}], want [messaging]`)
  }
  if (pg) {
    profile('messaging-postgres', pg)
    onlyState('messaging-postgres', pg)
    if (String(pg.labels?.['org.gremion.postgres']) !== 'module:messaging')
      out.push(`messaging-postgres: label org.gremion.postgres is ${JSON.stringify(pg.labels?.['org.gremion.postgres'] ?? null)}, want module:messaging`)
    if (!/^postgres:18-alpine@sha256:[0-9a-f]{64}$/.test(String(pg.image))) out.push(`messaging-postgres: image ${pg.image} is not the pinned 18-alpine digest`)
    const e = pg.environment ?? {}
    if (!e.POSTGRES_USER) out.push('messaging-postgres: POSTGRES_USER renders empty')
    for (const k of ['POSTGRES_PASSWORD', 'SYNAPSE_DB_PASSWORD']) if (!(k in e)) out.push(`messaging-postgres: environment lacks ${k}`)
    const vs = pg.volumes ?? []
    const data = vs.find((v) => v.target === '/var/lib/postgresql')
    if (!data || data.type !== 'volume' || data.source !== 'messaging-pg-data') out.push('messaging-postgres: messaging-pg-data is not mounted at /var/lib/postgresql')
    const binds = vs.filter((v) => v.type === 'bind')
    const init = binds.find((v) => v.target === INIT_TARGET)
    if (!init) out.push(`messaging-postgres: no bind of the initdb script at ${INIT_TARGET}`)
    else {
      if (!init.read_only) out.push('messaging-postgres: the initdb script bind is not read-only')
      if (path.relative(REPO_ROOT, init.source) !== INIT_SOURCE) out.push(`messaging-postgres: the initdb bind's source is ${init.source}, want ${INIT_SOURCE}`)
    }
    if (binds.length !== 1) out.push(`messaging-postgres: ${binds.length} bind mounts, want exactly the initdb script`)
    const test = pg.healthcheck?.test ?? []
    if (!String(test.join(' ')).includes('pg_isready -h 127.0.0.1')) out.push('messaging-postgres: not the anchor\'s TCP pg_isready healthcheck')
  }
  if (mx) {
    profile('matrix', mx)
    onlyState('matrix', mx)
    const img = String(mx.image ?? '')
    if (!img.startsWith(`${IMAGE_REPO}:`)) out.push(`matrix: image ${img || '(none)'}, want ${IMAGE_REPO}:<IMAGE_TAG>`)
    const ctx = mx.build?.context ? path.relative(REPO_ROOT, mx.build.context) : null
    if (ctx !== MODULE_DIR) out.push(`matrix: build context ${ctx}, want ${MODULE_DIR}`)
    const lim = mx.deploy?.resources?.limits ?? {}
    if (Number(lim.memory) !== LIMITS_L.memory || Number(lim.cpus) !== LIMITS_L.cpus)
      out.push(`matrix: limits ${JSON.stringify(lim)}, want limits-l (1G / 1.0)`)
    const dep = mx.depends_on?.['messaging-postgres']
    if (!dep || dep.condition !== 'service_healthy') out.push('matrix: not depends_on messaging-postgres: service_healthy')
    const vs = mx.volumes ?? []
    if (vs.length !== 1 || vs[0].type !== 'volume' || vs[0].source !== 'synapse-data' || vs[0].target !== '/data')
      out.push(`matrix: volumes ${JSON.stringify(vs.map((v) => `${v.type}:${v.source}:${v.target}`))}, want exactly synapse-data:/data (no bind, no repo mount)`)
    const hc = mx.healthcheck ?? {}
    const t = hc.test ?? []
    if (JSON.stringify(t) !== JSON.stringify(['CMD', PROBE])) out.push(`matrix: healthcheck ${JSON.stringify(t)}, want ["CMD", "${PROBE}"]`)
    if (JSON.stringify(t).includes('/_matrix/client/versions')) out.push('matrix: the healthcheck reads /versions, which answers 200 with login broken')
    if (durationS(hc.start_period) !== START_PERIOD_S) out.push(`matrix: start_period ${hc.start_period}, want ${START_PERIOD_S}s (${KC_MAX_DEFAULT} x ${KC_ATTEMPT_S} s + ${FIRST_BOOT_S} s)`)
    const env = mx.environment ?? {}
    for (const [k, want] of Object.entries(MATRIX_ENV(domain))) {
      if (!(k in env)) out.push(`matrix: environment lacks ${k} (section 5.2)`)
      else if (want !== null && String(env[k]) !== want) out.push(`matrix: environment ${k}=${JSON.stringify(env[k])}, want ${JSON.stringify(want)}`)
    }
    for (const k of Object.keys(env)) if (/^LIVEKIT_|^SYNAPSE_MEDIA_S3_/.test(k)) out.push(`matrix: environment carries the dropped key ${k}`)
  }
  return out
}

/** The raw text of one top-level service block of a compose file. */
export function serviceBlock(text, name) {
  const lines = text.split(/\r?\n/)
  const i = lines.findIndex((l) => l === `  ${name}:`)
  if (i < 0) return null
  let j = i + 1
  while (j < lines.length && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[j]) && !/^\S/.test(lines[j])) j++
  return lines.slice(i, j).join('\n')
}

/** `${VAR:?...}` inside the chat service blocks (comments excluded). */
export function requiredFormViolations(text) {
  const out = []
  for (const name of ['messaging-postgres', 'matrix']) {
    const block = serviceBlock(text, name)
    if (block === null) {
      out.push(`docker-compose.yml has no ${name} service block`)
      continue
    }
    const code = block.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n')
    for (const m of code.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):?\?/g))
      out.push(`${name}: \${${m[1]}:?} binds every profile and verb -- fail-closed lives in the shim, initdb and preflight`)
  }
  return out
}

/** The module suites lint-synapse must run (declared = collected). */
export function moduleSuites(root = REPO_ROOT) {
  return readdirSync(path.join(root, MODULE_DIR, 'test'))
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
    .map((f) => `${MODULE_DIR}/test/${f}`)
}

/** The recipe lines of one Makefile target. */
export function recipeOf(makefile, target) {
  const lines = makefile.split(/\r?\n/)
  const i = lines.findIndex((l) => l.startsWith(`${target}:`))
  if (i < 0) return null
  const out = []
  for (let j = i + 1; j < lines.length && lines[j].startsWith('\t'); j++) out.push(lines[j])
  return out.join('\n')
}

export function wiringViolations(makefile, carveTargets, suites) {
  const out = []
  const lint = (makefile.match(/^lint:([^\n]*)$/m)?.[1] ?? '').trim().split(/\s+/)
  const phony = [...makefile.matchAll(/^\.PHONY:([^\n]*(?:\\\n[^\n]*)*)/gm)].flatMap((m) => m[1].replace(/\\\n/g, ' ').trim().split(/\s+/))
  if (!lint.includes('lint-synapse')) out.push('lint-synapse is not a prerequisite of `lint:`')
  if (lint.includes('synapse-proof')) out.push('synapse-proof is in `lint:` -- the scratch proof is never part of lint')
  for (const t of ['lint-synapse', 'synapse-proof']) if (!phony.includes(t)) out.push(`${t} is not .PHONY`)
  const recipe = recipeOf(makefile, 'lint-synapse')
  if (recipe === null) out.push('the Makefile defines no lint-synapse target')
  else {
    for (const s of [...suites, 'scripts/check-synapse-stack.test.mjs']) if (!recipe.includes(s)) out.push(`lint-synapse does not run ${s}`)
    if (!recipe.includes("grep -c '^test('")) out.push('lint-synapse does not compare declared test( counts with collected ones')
    if (!recipe.includes('node scripts/check-synapse-stack.mjs')) out.push('lint-synapse does not run node scripts/check-synapse-stack.mjs')
  }
  const proof = recipeOf(makefile, 'synapse-proof')
  if (proof === null) out.push('the Makefile defines no synapse-proof target')
  else if (!proof.includes(`${MODULE_DIR}/test/scratch-proof.sh`) || !proof.includes('docker-compose.yml')) out.push('synapse-proof does not run the module scratch proof with the compose path passed in')
  const row = carveTargets.find((t) => t.name === 'lint-synapse')
  if (!row) out.push('CARVE_LINT_TARGETS has no lint-synapse row')
  else if (row.kind !== 'make' || row.target !== 'lint-synapse' || row.tool !== 'docker') out.push(`CARVE_LINT_TARGETS lint-synapse row is ${JSON.stringify(row)}, want {kind:'make', target:'lint-synapse', tool:'docker'}`)
  if (carveTargets.some((t) => t.name === 'synapse-proof' || t.target === 'synapse-proof')) out.push('synapse-proof is in CARVE_LINT_TARGETS -- the scratch proof is never part of verify')
  return out
}

export function renderProfileOn(extra = {}) {
  return renderState({ envFile: POOLED_FIXTURE, env: { ...PROFILE_ON_ENV, ...extra } })
}

/** .env.example as shipped (profile off) -- throws on a compose refusal. */
export function renderExample() {
  return renderState({ envFile: '.env.example' })
}

export async function runAll() {
  const problems = []
  const fx = readEnvFile(POOLED_FIXTURE)
  const ctx = { stack: fx.STACK, project: fx.COMPOSE_PROJECT_NAME, domain: fx.PLATFORM_DOMAIN }
  let on = null
  try {
    on = renderProfileOn()
    problems.push(...renderViolations(on, ctx))
  } catch (e) {
    problems.push(`profile-on render failed: ${String(e.message).split('\n')[0]}`)
  }
  try {
    const off = renderExample()
    if (off.services?.matrix || off.services?.['messaging-postgres']) problems.push('.env.example renders the chat services with the messaging profile off')
  } catch (e) {
    problems.push(`.env.example (profile off) does not render: ${String(e.message).split('\n')[0]}`)
  }
  problems.push(...requiredFormViolations(readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8')))
  const { CARVE_LINT_TARGETS } = await import('./verify/suites/carve-lint.mjs')
  problems.push(...wiringViolations(readFileSync(path.join(REPO_ROOT, 'Makefile'), 'utf8'), CARVE_LINT_TARGETS, moduleSuites()))
  return { problems, services: on ? Object.keys(on.services ?? {}).length : 0 }
}

const SELF = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const { problems, services } = await runAll()
  if (problems.length) {
    for (const p of problems) console.error(`FAIL ${p}`)
    console.error(`[synapse-stack] ${problems.length} violation(s)`)
    process.exit(1)
  }
  if (services === 0) {
    console.error('[synapse-stack] the profile-on render has zero services -- refusing to pass vacuously')
    process.exit(1)
  }
  console.log(`[synapse-stack] OK: messaging-postgres and matrix as granted; .env.example renders with the profile off; lint-synapse wired (${services} service(s) in the profile-on render)`)
}
