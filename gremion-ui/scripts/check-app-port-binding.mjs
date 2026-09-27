// No shebang: invoked via `node …` (package.json `check`) — matches the
// sibling check-tenant-env-guard.mjs convention (a hashbang breaks the vitest
// inline .mjs transform if a unit test ever imports a helper from here).
// @ts-nocheck — standalone node build script (CLI-invoked, not TS-typed).
/**
 * P2.1c (#202 T5): app-port-not-bound check. The tenant resolver's SECURITY
 * INVARIANT (resolve.ts) is only safe while gremion-ui is NEVER directly reachable
 * off-host — Traefik must be the sole ingress. A published port on 0.0.0.0 (any
 * interface) lets an off-host client set `x-forwarded-host` and select ANY
 * tenant. This check renders each compose file set with `docker compose config`
 * (read-only — it NEVER touches a running project) and fails if an app-tier
 * service publishes a port whose host binding is not loopback.
 *
 * TASK-040 (pooled stack, PRD-PLAT-005) moved gremion-ui and gremion-public
 * out of the root files into the per-colour app tier, so the file sets are the
 * app tier's:
 *   - dev:  docker-compose.app.yml + docker-compose.app.dev.yml, rendered as
 *           the Makefile's DEV_APP renders it (STACK=dev COLOUR=blue
 *           IMAGE_TAG=dev) — the dev layer is the file that publishes
 *           :3001 / :3002, so it is the one this check must cover;
 *   - prod: docker-compose.app.yml alone, per colour (the host's COMPOSE_FILE
 *           adds only the release pins file, which carries images) — zero
 *           published ports is the expected state there.
 * Every profile is on (COMPOSE_PROFILES='*'), so the migrate / tenant-create
 * one-shots are read too. gremion-ui must be in every render (its absence
 * means the check reads the wrong files, never "nothing to check"), and EVERY
 * service in the render must publish loopback only.
 *
 * A published port is OK iff its host_ip is a loopback address (127.0.0.0/8 or
 * ::1); a missing host_ip means 0.0.0.0 (all interfaces) -> FAIL.
 *
 * Exit: 0 = OK (or docker unavailable -> loud SKIP); 1 = a non-loopback binding
 * or a missing prerequisite. The two are reported SEPARATELY on purpose: a
 * fresh clone has no .env and no legal/legal.env, compose refuses to render,
 * and this check used to report that as "2 non-loopback gremion-ui binding(s)"
 * — a security-invariant failure that had not been measured at all. A check
 * that cannot run must say so, not guess.
 *
 * Repo root: ../.. relative to this script (gremion-ui/scripts -> repo root).
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')
export const SERVICE = 'gremion-ui'

// The render env pins the interpolation the app files require (`${STACK:?}`,
// `${COLOUR:?}`, `${IMAGE_TAG:?}`) over whatever the ambient .env carries.
export const FILE_SETS = [
  {
    name: 'dev',
    args: ['-f', 'docker-compose.app.yml', '-f', 'docker-compose.app.dev.yml', '-p', 'portcheck-dev-app-blue'],
    env: { STACK: 'dev', COLOUR: 'blue', IMAGE_TAG: 'dev', COMPOSE_PROFILES: '*' },
  },
  {
    name: 'prod-blue',
    args: ['-f', 'docker-compose.app.yml', '-p', 'portcheck-app-blue'],
    env: { STACK: 'portcheck', COLOUR: 'blue', IMAGE_TAG: 'portcheck', COMPOSE_PROFILES: '*' },
  },
  {
    name: 'prod-green',
    args: ['-f', 'docker-compose.app.yml', '-p', 'portcheck-app-green'],
    env: { STACK: 'portcheck', COLOUR: 'green', IMAGE_TAG: 'portcheck', COMPOSE_PROFILES: '*' },
  },
]

export function isLoopback(hostIp) {
  if (!hostIp) return false // unset host_ip = 0.0.0.0 (all interfaces)
  if (hostIp === '::1' || hostIp === '[::1]') return true
  return hostIp === 'localhost' || hostIp.startsWith('127.')
}

/** Every non-loopback published port in a parsed render, plus the absence of
 *  gremion-ui (a render without it is the wrong file set, not a clean one). */
export function portViolations(parsed, setName) {
  const services = parsed?.services ?? {}
  if (!services[SERVICE]) return [`service '${SERVICE}' absent from the ${setName} render`]
  const out = []
  for (const [name, svc] of Object.entries(services)) {
    for (const p of Array.isArray(svc?.ports) ? svc.ports : []) {
      // compose config --format json publishes ports as objects:
      //   { mode, host_ip?, target, published, protocol }
      if (isLoopback(p?.host_ip)) continue
      const bind = p?.host_ip ? p.host_ip : '0.0.0.0'
      const published = p?.published ?? p?.target
      out.push(`${name} publishes ${bind}:${published}->${p?.target} (${setName}) — must bind loopback only`)
    }
  }
  return out
}

/** A compose render that failed because the working copy has not been set up
 *  yet (no .env, no legal/legal.env) rather than because anything is wrong. */
function missingSetupPrerequisite(stderr) {
  const m = /env file (.+?) not found/i.exec(stderr)
  if (m) return m[1].trim()
  if (/(no such file|cannot find the file)/i.test(stderr) && stderr.includes('.env')) return '.env'
  return null
}

/** Renders one file set. Returns { skip } when docker is unavailable,
 *  { prereq } for a missing setup file, { ok:false, reason } on a render or
 *  parse error, else { parsed }. */
function render(fileSet) {
  const res = spawnSync('docker', ['compose', ...fileSet.args, 'config', '--format', 'json'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...fileSet.env },
  })
  if (res.error && res.error.code === 'ENOENT') {
    return { skip: true, reason: 'docker not found on PATH' }
  }
  if (res.status !== 0) {
    // `docker compose` exists but the render failed — surface stderr. Treat
    // daemon-down as a SKIP (cannot verify), an actual compose error as a FAIL
    // so a broken compose file is caught.
    const stderr = (res.stderr || '').toString()
    if (/cannot connect to the docker daemon|is the docker daemon running/i.test(stderr)) {
      return { skip: true, reason: 'docker daemon not reachable' }
    }
    const prereq = missingSetupPrerequisite(stderr)
    if (prereq) return { prereq }
    return { ok: false, reason: `docker compose config (${fileSet.name}) failed: ${stderr.trim()}` }
  }
  try {
    return { parsed: JSON.parse(res.stdout) }
  } catch (err) {
    return { ok: false, reason: `could not parse config JSON (${fileSet.name}): ${err.message}` }
  }
}

function main() {
  const failures = []
  const missing = new Set()
  let anySkipped = false
  for (const fileSet of FILE_SETS) {
    const r = render(fileSet)
    if (r.prereq) {
      missing.add(r.prereq)
      continue
    }
    if (r.skip) {
      console.warn(`[port-binding] SKIP (${fileSet.name}): ${r.reason} — cannot verify the app-port binding.`)
      anySkipped = true
      continue
    }
    if (r.ok === false) {
      console.error(`[port-binding] ERROR (${fileSet.name}): ${r.reason}`)
      failures.push(`${fileSet.name}: ${r.reason}`)
      continue
    }
    for (const msg of portViolations(r.parsed, fileSet.name)) {
      console.error(`[port-binding] FAIL: ${msg}`)
      failures.push(msg)
    }
  }
  if (missing.size > 0) {
    console.error(
      `[port-binding] NOT RUN: this working copy is not set up — compose cannot render ` +
        `without ${[...missing].join(', ')}. Run scripts/setup.sh first (it writes .env and ` +
        `legal/legal.env), then re-run this check. NOTHING about the port binding was ` +
        `verified — this is not a security finding.`,
    )
    process.exit(1)
  }
  if (failures.length > 0) {
    console.error(
      `[port-binding] FAIL: ${failures.length} app-tier port-binding issue(s). ` +
        'Traefik must be the sole ingress (resolve.ts SECURITY INVARIANT); bind to 127.0.0.1.',
    )
    process.exit(1)
  }
  if (anySkipped) {
    console.warn('[port-binding] SKIPPED — docker unavailable; binding NOT verified (re-run with docker up).')
    process.exit(0)
  }
  console.info(
    `[port-binding] OK — the app tier publishes only loopback bindings in every file set (${FILE_SETS.map((s) => s.name).join(', ')})`,
  )
  process.exit(0)
}

// Only run main() when invoked as a script (not when a unit test imports the
// exported helpers) — matches check-domain-regex.mjs.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
