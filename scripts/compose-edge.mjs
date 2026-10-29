/**
 * The ACME edge render helpers (TASK-022), shared by the edge guard
 * (scripts/check-compose-edge.test.mjs) and TASK-034's router guard.
 *
 * A library, not a test file, so that importing it registers no tests: the
 * same split scripts/check-cve-floors.mjs / .test.mjs uses.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** The fixed env file the production render is taken with (absolute). */
export const FIXTURE = path.join(REPO_ROOT, 'test/host/fixtures/edge-render/state.env')

// Only what docker itself needs to find its daemon. Everything the render reads
// comes from the env file or from `env` below, never from the caller's shell.
const DOCKER_ENV_KEYS = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY']
// The docker CLI on Windows finds its config and cli-plugins through these.
const WIN32_ENV_KEYS = ['SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramData', 'PATHEXT', 'TEMP', 'TMP']

/**
 * Render a composition exactly as the host runs it:
 *   docker compose --env-file <state.env> config
 * Returns the parsed JSON config. Throws with compose's stderr on a refusal, so
 * a caller can assert on the refusal text (x-required-env names the key).
 *
 * Precedence: `env` outranks the env file (compose lets a process variable
 * override --env-file), which is how a caller renders a single deviation --
 * e.g. `{ env: { EDGE_BIND_IP: '' } }`. A relative `envFile` resolves against
 * REPO_ROOT, like `cwd`'s default.
 *
 * The kernel composition's `legal` service names the git-ignored
 * legal/legal.env as an env_file; compose refuses to render without it. It is
 * created EMPTY if absent (exclusively, so concurrent renders cannot race) and
 * left in place -- exactly the file ci.yml's `touch legal/legal.env` leaves.
 */
export function renderState({ envFile = FIXTURE, cwd = REPO_ROOT, env = {} } = {}) {
  const childEnv = {}
  for (const k of DOCKER_ENV_KEYS) if (process.env[k] !== undefined) childEnv[k] = process.env[k]
  Object.assign(childEnv, env)

  for (const k of process.platform === 'win32' ? WIN32_ENV_KEYS : []) {
    if (process.env[k] !== undefined) childEnv[k] = process.env[k]
  }
  Object.assign(childEnv, env)

  const legalEnv = path.join(cwd, 'legal', 'legal.env')
  mkdirSync(path.dirname(legalEnv), { recursive: true })
  try {
    writeFileSync(legalEnv, '', { flag: 'wx' })
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
  }
  const res = spawnSync('docker', ['compose', '--env-file', path.resolve(REPO_ROOT, envFile), 'config', '--format', 'json'], {
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
}

/**
 * Does a RENDERED bind mount refuse to create a missing host directory, i.e. was
 * it declared `bind.create_host_path: false`? Compose does not render that
 * declaration the same way across versions: a recent one prints
 * `create_host_path: false`, an older one (the one on the GitHub runner) drops
 * the false, because the field is omit-empty, and prints `bind: {}`. The
 * default, true, is printed by both (`create_host_path: true`), so "absent or
 * false" is the same fact in every version and `true` is the defect. A mount
 * with no `bind` object at all is not a declaration this guard can vouch for,
 * so it does not pass.
 */
export function bindRefusesMissingHostDir(mount) {
  return mount?.type === 'bind' && typeof mount.bind === 'object' && mount.bind !== null && mount.bind.create_host_path !== true
}

/**
 * F1-FIX-11 (H21, S5#28): the Docker API proxy network contract, read out of a
 * RENDER. The proxy runs with CONTAINERS=1, so any container that can reach it
 * can read /containers/{id}/json -- every injected secret. The contract:
 *   - a dedicated network `socketNet` with `internal: true`;
 *   - exactly {docker-socket-proxy, traefik} are attached to it;
 *   - docker-socket-proxy is attached to no other network and is not on a
 *     network_mode (host/bridge would also put it beside everything else).
 * Returns the list of violations (empty = holds).
 */
export function socketIsolationViolations(render, socketNet = 'socket') {
  const out = []
  const svcs = render?.services ?? {}
  const net = render?.networks?.[socketNet]
  if (!net) return [`networks.${socketNet} is not declared`]
  if (net.internal !== true) out.push(`networks.${socketNet} is not internal: true (it has a route off the host)`)
  if (net.external === true) out.push(`networks.${socketNet} is external: some other project could join it`)
  if (!svcs['docker-socket-proxy']) out.push('docker-socket-proxy is not in the render -- the guard would pass vacuously')
  if (!svcs.traefik) out.push('traefik is not in the render -- the guard would pass vacuously')
  const members = Object.entries(svcs)
    .filter(([, s]) => Object.keys(s.networks ?? {}).includes(socketNet))
    .map(([n]) => n)
    .sort()
  if (JSON.stringify(members) !== JSON.stringify(['docker-socket-proxy', 'traefik'])) {
    out.push(`networks.${socketNet} members are [${members.join(', ')}], want exactly [docker-socket-proxy, traefik]`)
  }
  // A service that joins the network namespace of traefik or the proxy reaches
  // the proxy without appearing under `networks:` at all.
  for (const [name, s] of Object.entries(svcs)) {
    const mode = typeof s.network_mode === 'string' ? s.network_mode : ''
    const m = /^(service|container):(.+)$/.exec(mode)
    if (m && name !== 'docker-socket-proxy' && name !== 'traefik' && /docker-socket-proxy|traefik/.test(m[2])) {
      out.push(`${name} shares the network namespace of ${mode}`)
    }
  }
  const proxy = svcs['docker-socket-proxy']
  if (proxy) {
    const nets = Object.keys(proxy.networks ?? {})
    if (proxy.network_mode !== undefined) out.push(`docker-socket-proxy sets network_mode ${proxy.network_mode}`)
    if (JSON.stringify(nets) !== JSON.stringify([socketNet])) out.push(`docker-socket-proxy is on [${nets.join(', ')}], want only [${socketNet}]`)
  }
  return out
}

/** Reads KEY=VALUE lines of an env file (comments and blanks skipped). */
export function readEnvFile(file) {
  const out = {}
  for (const line of readFileSync(path.resolve(REPO_ROOT, file), 'utf8').split(/\r?\n/)) {
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
    if (/^0\d/.test(v)) throw new Error(`unsupported YAML number: ${v}`)
    if (/^-?\d+$/.test(v)) return Number(v)
    const q = /^"([^"\\]*)"$/.exec(v) || /^'([^']*)'$/.exec(v)
    if (q) return q[1]
    if (/^["']/.test(v)) throw new Error(`unsupported YAML quoting: ${v}`)
    if (/^0\d/.test(v)) throw new Error(`unsupported YAML number: ${v}`)
    if (/^([[{|>&*!]|<<)/.test(v)) throw new Error(`unsupported YAML construct: ${v}`)
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
        const item = lines[i].body.slice(2)
        if (/^[^"']*:(\s|$)/.test(item)) throw new Error(`unsupported YAML construct (a mapping in a sequence): ${item}`)
        arr.push(scalar(item))
        i++
      }
      return arr
    }
    const obj = Object.create(null)
    while (i < lines.length && lines[i].indent === own) {
      const m = /^("[^"]*"|'[^']*'|[^:]+):(?:\s+(.*))?$/.exec(lines[i].body)
      if (!m) throw new Error(`unparseable line: ${lines[i].body}`)
      const key = m[1].replace(/^["']|["']$/g, '')
      if (key.startsWith('- ') || key.startsWith('<<')) throw new Error(`unsupported YAML construct: ${lines[i].body}`)
      if (Object.hasOwn(obj, key)) throw new Error(`duplicate key: ${key}`)
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
  // Plain objects out (the null-prototype maps only guard duplicate keys).
  return JSON.parse(JSON.stringify(doc ?? {}))
}

