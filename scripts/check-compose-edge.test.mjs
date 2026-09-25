/**
 * The ACME edge guard (TASK-022, spec B "Edge" §2; TRD-039, TRD-042, TRD-178).
 *
 *   node --test scripts/check-compose-edge.test.mjs
 *
 * Three guards, each a post-condition read out of an artefact, never an exit
 * code:
 *
 *   1. RENDER. Every port the production traefik publishes carries an explicit
 *      host address: EDGE_BIND_IP / EDGE_BIND_IP6 for web and websecure,
 *      127.0.0.1 for the API and internaltest. A publish with no host address
 *      binds every interface -- an unauthenticated Traefik API on 0.0.0.0 is
 *      the whole routing graph.
 *   2. STATIC FILE. docker/traefik/traefik.yml declares the four entrypoints,
 *      the ping block, the le-http resolver and the directory file provider,
 *      carries the four @MARKER@s the start-up render substitutes, and holds no
 *      host literal. dynamic/tls.yml (the Cloudflare Origin default
 *      certificate) is gone.
 *   3. SERVICE. One read-only mount of /etc/traefik/dynamic, the external
 *      ${STACK}_traefik_acme volume, a ping healthcheck, and Traefik running
 *      from the rendered /tmp copy rather than the committed file.
 *
 * WHY A RENDER AND NOT THE SOURCE FILE. `docker compose config` is the only
 * artefact that is the deployed topology: an overlay, a profile or a merged
 * list can put back what the source file does not show. The render is taken
 * with the FIXED env file test/host/fixtures/edge-render/state.env, shaped like
 * the host's rendered state.env, and with a scrubbed environment, because a
 * shell variable outranks --env-file and the guard must measure the
 * repository, not the machine it runs on.
 *
 * renderState() is exported: TASK-034 (the edge routers) imports it, and it
 * survives TASK-040 moving the traefik block, because it renders whatever
 * COMPOSE_FILE the fixture names.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const FIXTURE = 'test/host/fixtures/edge-render/state.env'
const TRAEFIK_YML = 'docker/traefik/traefik.yml'
const MARKERS = ['@ACME_EMAIL@', '@ACME_CA_SERVER@', '@EDGE_V4_SUBNET@', '@EDGE_V6_SUBNET@']

// Only what docker itself needs to find its daemon. Everything the render reads
// comes from the env file or from `env` below, never from the caller's shell.
const DOCKER_ENV_KEYS = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY']

/**
 * Render a composition exactly as the host runs it:
 *   docker compose --env-file <state.env> config
 * Returns the parsed JSON config. Throws with compose's stderr on a refusal, so
 * a caller can assert on the refusal text (x-required-env names the key).
 *
 * The kernel composition's `legal` service names the git-ignored
 * legal/legal.env as an env_file; compose refuses to render without it. It is
 * created only if absent and removed again, the same precondition ci.yml
 * satisfies with `touch legal/legal.env`.
 */
export function renderState({ envFile = FIXTURE, cwd = REPO_ROOT, env = {} } = {}) {
  const childEnv = {}
  for (const k of DOCKER_ENV_KEYS) if (process.env[k] !== undefined) childEnv[k] = process.env[k]
  Object.assign(childEnv, env)

  const legalEnv = path.join(cwd, 'legal', 'legal.env')
  const created = !existsSync(legalEnv)
  if (created) {
    mkdirSync(path.dirname(legalEnv), { recursive: true })
    writeFileSync(legalEnv, '')
  }
  try {
    const res = spawnSync('docker', ['compose', '--env-file', envFile, 'config', '--format', 'json'], {
      cwd,
      env: childEnv,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    if (res.error) throw new Error(`docker could not be run: ${res.error.message}`)
    if (res.status !== 0) {
      const err = new Error(`docker compose config refused (exit ${res.status}): ${res.stderr.trim()}`)
      err.stderr = res.stderr
      throw err
    }
    return JSON.parse(res.stdout)
  } finally {
    if (created) rmSync(legalEnv, { force: true })
  }
}

/** Reads KEY=VALUE lines of an env file (comments and blanks skipped). */
export function readEnvFile(file) {
  const out = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line)
    if (m) out[m[1]] = m[2]
  }
  return out
}

/**
 * A reader for the YAML subset docker/traefik/traefik.yml is written in: block
 * mappings, block sequences of scalars, quoted or plain scalars, `{}`, and
 * comments. Anything outside that subset throws rather than being skipped, so
 * the static guard can never pass on a file it did not actually read.
 */
export function parseYamlSubset(text) {
  const scalar = (raw) => {
    const v = raw.trim()
    if (v === '{}') return {}
    if (v === '[]') return []
    if (v === 'true') return true
    if (v === 'false') return false
    if (/^-?\d+$/.test(v)) return Number(v)
    const q = /^"(.*)"$/.exec(v) || /^'(.*)'$/.exec(v)
    if (q) return q[1]
    if (/^[[{|>]/.test(v)) throw new Error(`unsupported YAML construct: ${v}`)
    return v
  }
  // Strip a trailing comment that sits outside quotes.
  const uncomment = (line) => {
    let inS = false
    let inD = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (c === "'" && !inD) inS = !inS
      else if (c === '"' && !inS) inD = !inD
      else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
    }
    return line
  }
  const lines = text
    .split(/\r?\n/)
    .map(uncomment)
    .filter((l) => l.trim() !== '')
    .map((l) => {
      if (/\t/.test(l.match(/^\s*/)[0])) throw new Error('tab indentation')
      return { indent: l.match(/^ */)[0].length, body: l.trim() }
    })

  let i = 0
  function block(indent) {
    if (i >= lines.length || lines[i].indent < indent) return null
    const own = lines[i].indent
    if (lines[i].body.startsWith('- ')) {
      const arr = []
      while (i < lines.length && lines[i].indent === own && lines[i].body.startsWith('- ')) {
        arr.push(scalar(lines[i].body.slice(2)))
        i++
      }
      return arr
    }
    const obj = {}
    while (i < lines.length && lines[i].indent === own) {
      const m = /^("[^"]*"|'[^']*'|[^:]+):(?:\s+(.*))?$/.exec(lines[i].body)
      if (!m) throw new Error(`unparseable line: ${lines[i].body}`)
      const key = m[1].replace(/^["']|["']$/g, '')
      if (key in obj) throw new Error(`duplicate key: ${key}`)
      i++
      if (m[2] !== undefined && m[2] !== '') obj[key] = scalar(m[2])
      else {
        const child = i < lines.length && lines[i].indent > own ? block(lines[i].indent) : null
        obj[key] = child
      }
    }
    if (i < lines.length && lines[i].indent > own) throw new Error(`bad indentation at: ${lines[i].body}`)
    return obj
  }
  const doc = block(0)
  if (i !== lines.length) throw new Error(`trailing content at: ${lines[i].body}`)
  return doc ?? {}
}

// ── helpers over the render ────────────────────────────────────────────────

let cached
function state() {
  cached ??= renderState()
  return cached
}
function traefik() {
  const svc = state().services?.traefik
  assert.ok(svc, 'the production render has no traefik service -- is the fixture COMPOSE_PROFILES=production?')
  return svc
}
const fixtureEnv = () => readEnvFile(path.join(REPO_ROOT, FIXTURE))
const WILDCARD = new Set(['', '0.0.0.0', '::', '[::]'])
const normIp = (ip) => String(ip ?? '').replace(/^\[|\]$/g, '')
const commandText = (svc) => [].concat(svc.entrypoint ?? [], svc.command ?? []).join(' ')

// ── 0. the tools the guards stand on ───────────────────────────────────────

test('parseYamlSubset reads nesting, lists, quoting and comments, and refuses what it cannot read', () => {
  const doc = parseYamlSubset(
    ['# c', 'a:', '  b: "x # not a comment"  # comment', '  c:', '    - "1"', '    - two', '  d: {}', 'e: false'].join('\n'),
  )
  assert.deepEqual(doc, { a: { b: 'x # not a comment', c: ['1', 'two'], d: {} }, e: false })
  assert.throws(() => parseYamlSubset('a: [1, 2]'), /unsupported/)
  assert.throws(() => parseYamlSubset('a: 1\na: 2'), /duplicate/)
})

test('renderState renders the fixture through the production profile, independent of the caller shell', () => {
  const cfg = state()
  assert.ok(cfg.services?.traefik && cfg.services?.['docker-socket-proxy'], 'traefik and its socket proxy render')
  // A value in the caller's shell must not leak in: a shell variable outranks
  // --env-file in compose, so without the scrub this would decide the render.
  process.env.EDGE_BIND_IP = '198.51.100.99'
  try {
    const again = renderState()
    const ips = (again.services.traefik.ports ?? []).map((p) => normIp(p.host_ip))
    assert.ok(!ips.includes('198.51.100.99'), 'the caller shell decided a bind address')
  } finally {
    delete process.env.EDGE_BIND_IP
  }
})

// ── 1. render guard: every publish is bound ────────────────────────────────

test('guard 1: every traefik publish carries an explicit, non-wildcard host address', () => {
  const ports = traefik().ports ?? []
  assert.ok(ports.length > 0, 'traefik publishes nothing -- the guard would pass vacuously')
  for (const p of ports) {
    assert.ok(!WILDCARD.has(normIp(p.host_ip)), `publish ${p.published}->${p.target} binds all interfaces (host_ip=${JSON.stringify(p.host_ip ?? '')})`)
  }
})

test('guard 1: web and websecure bind EDGE_BIND_IP and EDGE_BIND_IP6, and nothing else', () => {
  const env = fixtureEnv()
  const want = [
    `${env.EDGE_BIND_IP} ${env.EDGE_HTTP_PORT}->80`,
    `${env.EDGE_BIND_IP6} ${env.EDGE_HTTP_PORT}->80`,
    `${env.EDGE_BIND_IP} ${env.EDGE_HTTPS_PORT}->443`,
    `${env.EDGE_BIND_IP6} ${env.EDGE_HTTPS_PORT}->443`,
  ].sort()
  const got = (traefik().ports ?? [])
    .filter((p) => p.target === 80 || p.target === 443)
    .map((p) => `${normIp(p.host_ip)} ${p.published}->${p.target}`)
    .sort()
  assert.deepEqual(got, want)
})

test('guard 1: the API (:8080) and internaltest (:8081) publish on 127.0.0.1 only; ping (:8082) is not published', () => {
  const env = fixtureEnv()
  const ports = traefik().ports ?? []
  const of = (target) => ports.filter((p) => p.target === target).map((p) => `${normIp(p.host_ip)}:${p.published}`)
  assert.deepEqual(of(8080), [`127.0.0.1:${env.TRAEFIK_API_PORT}`])
  assert.deepEqual(of(8081), [`127.0.0.1:${env.INTERNALTEST_PORT}`])
  assert.deepEqual(of(8082), [])
  const unexpected = ports.filter((p) => ![80, 443, 8080, 8081].includes(p.target))
  assert.deepEqual(unexpected, [], 'traefik publishes a port no guard reasons about')
})

test('guard 1: an empty bind address is refused at render, never published on every interface', () => {
  for (const key of ['EDGE_BIND_IP', 'EDGE_BIND_IP6']) {
    assert.throws(() => renderState({ env: { [key]: '' } }), new RegExp(`${key} required`), `${key}='' rendered`)
  }
})

