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
 * Exit: 0 = OK (or docker unavailable -> loud SKIP); 1 = a non-loopback
 * binding, a render that failed, or a working copy that is not set up. The
 * three are reported SEPARATELY on purpose: a fresh clone has no .env and no
 * legal/legal.env, compose refuses to render, and this check used to report
 * that as "2 non-loopback gremion-ui binding(s)" — a security-invariant failure
 * that had not been measured at all (TRD-099). A check that cannot run must
 * say so, not guess.
 *
 * TASK-028 (D1): "is this working copy set up?" is answered from the file
 * system BEFORE any render (scripts/env/local-setup.mjs), not by pattern-
 * matching compose's stderr. The stderr match below stays only as a second net.
 *
 * Repo root: ../.. relative to this script (gremion-ui/scripts -> repo root),
 * or GREMION_REPO_ROOT when set (the unit test points it at a temp copy).
 * Importing this module runs nothing; the CLI entry is at the bottom.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withCiPlaceholders } from '../../scripts/env/ci-placeholders.mjs'
import { LOCAL_ENV_FILES, missingLocalEnvFiles, SETUP_FIRST } from '../../scripts/env/local-setup.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..')
export const SERVICE = 'gremion-ui'

// The app file binds DOMAIN from PLATFORM_DOMAIN with `:?` (TASK-028, carried
// into docker-compose.app.yml by TASK-040), so a dev working copy whose .env
// predates the key cannot render it at all. This check reads PORTS only; the domain does not reach any port
// entry. When the caller's environment does not carry PLATFORM_DOMAIN, the
// render is given this reserved, unresolvable placeholder -- it is never
// written anywhere and never used to decide a verdict.
const RENDER_ONLY_PLATFORM_DOMAIN = 'port-binding-check.invalid'

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

/** The second net: a render that failed on one of the LOCAL_ENV_FILES (the
 *  files scripts/setup.sh writes) although the preflight saw it -- e.g. it
 *  vanished between the two. Any OTHER missing file is a composition defect
 *  and stays a render error: "run setup first" would not fix it. */
function missingSetupPrerequisite(stderr, root) {
  const m = /env file (.+?) not found/i.exec(stderr)
  if (!m) return null
  const rel = path.relative(root, path.resolve(root, m[1].trim())).split(path.sep).join('/')
  return LOCAL_ENV_FILES.includes(rel) ? rel : null
}

/** Renders one file set. Returns { skip } when docker is unavailable,
 *  { prereq } for a missing setup file, { ok:false, reason } on a render or
 *  parse error, else { parsed }. */
function render(fileSet, root) {
  // Render-only placeholders for the `:?` variables a bare `.env.example` copy
  // leaves unset (compose/ci.placeholder.env, shared with the G-037 compose
  // guard). Read from THIS script's tree, not `root`: the unit test points
  // `root` at a temp copy. A value the environment already carries wins.
  const env = withCiPlaceholders({ ...process.env })
  if (!env.PLATFORM_DOMAIN) env.PLATFORM_DOMAIN = RENDER_ONLY_PLATFORM_DOMAIN
  Object.assign(env, fileSet.env)
  const res = spawnSync(
    'docker',
    ['compose', ...fileSet.args, 'config', '--format', 'json'],
    { cwd: root, env, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  )
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
    const prereq = missingSetupPrerequisite(stderr, root)
    if (prereq) return { prereq }
    return { ok: false, reason: `docker compose config (${fileSet.name}) failed: ${stderr.trim()}` }
  }
  try {
    return { parsed: JSON.parse(res.stdout) }
  } catch (err) {
    return { ok: false, reason: `could not parse config JSON (${fileSet.name}): ${err.message}` }
  }
}

function setupFirst(missing) {
  console.error(
    `[port-binding] NOT RUN: this working copy is not set up — compose cannot render ` +
      `without ${missing.join(', ')}; ${SETUP_FIRST} (it writes .env and ` +
      `legal/legal.env), then re-run this check. NOTHING about the port binding was ` +
      `verified — this is not a security finding.`,
  )
  return 1
}

/**
 * Runs the check against `root` and returns the exit code; never exits.
 * @param {{ root?: string }} [opts]
 * @returns {number}
 */
export function main({ root = process.env.GREMION_REPO_ROOT || DEFAULT_ROOT } = {}) {
  if (root !== DEFAULT_ROOT) console.warn(`[port-binding] checking ${root} (not this script's own tree)`)
  // D1: the preflight, BEFORE any render. Only absent files answer here.
  const absent = missingLocalEnvFiles(root)
  if (absent.length > 0) return setupFirst(absent)

  const violations = []
  const renderErrors = []
  const missing = new Set()
  let anySkipped = false
  for (const fileSet of FILE_SETS) {
    const r = render(fileSet, root)
    if (r.prereq) {
      // Second net: the files exist, yet compose still reports one missing
      // (e.g. an env_file this check does not know about).
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
      renderErrors.push(`${fileSet.name}: ${r.reason}`)
      continue
    }
    // A render without gremion-ui is the wrong file set, not a clean one.
    if (!r.parsed?.services?.[SERVICE]) {
      const reason = `service '${SERVICE}' absent from the ${fileSet.name} render`
      console.error(`[port-binding] ERROR (${fileSet.name}): ${reason}`)
      renderErrors.push(`${fileSet.name}: ${reason}`)
      continue
    }
    for (const msg of portViolations(r.parsed, fileSet.name)) {
      console.error(`[port-binding] FAIL: ${msg}`)
      violations.push(msg)
    }
  }
  // A measured violation outranks everything else: it is reported even when
  // another file set could not be rendered.
  if (violations.length > 0) {
    console.error(
      `[port-binding] FAIL: ${violations.length} non-loopback app-tier binding(s). ` +
        'Traefik must be the sole ingress (resolve.ts SECURITY INVARIANT); bind to 127.0.0.1.',
    )
    return 1
  }
  if (renderErrors.length > 0) {
    console.error(
      `[port-binding] ERROR: ${renderErrors.length} file set(s) failed to render; the binding ` +
        'of those sets was NOT verified. Fix the composition error above.',
    )
    return 1
  }
  if (missing.size > 0) return setupFirst([...missing])
  if (anySkipped) {
    console.warn('[port-binding] SKIPPED — docker unavailable; binding NOT verified (re-run with docker up).')
    return 0
  }
  console.info(
    `[port-binding] OK — the app tier publishes only loopback bindings in every file set (${FILE_SETS.map((s) => s.name).join(', ')})`,
  )
  return 0
}

// import.meta.main (Node >= 24.2), not an argv[1] comparison: Node gives the
// entry module its REALPATH as import.meta.url, so comparing it with argv[1]
// silently skipped main() -- exit 0, no output -- whenever the path held a
// symlink.
if (import.meta.main) {
  process.exitCode = main()
}
