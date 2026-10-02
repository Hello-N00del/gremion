// TASK-036 (L1-17, TRD-178): render the production compose projects the
// health census reads.
//
// One render per production project, each exactly as the host composes it:
// the compose files and profiles come from COMPOSE_FILE / COMPOSE_PROFILES in
// that project's env template (infra/host/templates/env/<project>.env.tmpl),
// located by KEY, never by line number. Three things are deliberately NOT
// left to docker's defaults, because each one lets a render describe
// something other than production:
//   - explicit `-f` for every file: a bare `docker compose config` merges
//     docker-compose.override.yml (the dev override) on its own;
//   - `--env-file scripts/verify/census/render.env` always, so a repo-root
//     `.env` (carve-lint's envstub copies .env.example there) is never read;
//   - an allow-listed child environment: the process env beats an env file
//     in compose's precedence, so a parent `COMPOSE_PROFILES=dev`, a
//     `COMPOSE_FILE`, or any variable a compose file interpolates would
//     silently change what is rendered. Only OS/docker-client variables pass.
// `--project-directory` is explicit too, so relative paths resolve the way
// they do on the host (the mail project from infra/host/mail/, as
// gremion-mail-bringup's check_port_binds renders it; ops from
// compose/observability/, TASK-039).
//
// Replaceable by TASK-053's shared renderer (brief S3). Outside
// scripts/verify/census/, only TASK-048b's release render arm
// (scripts/release/lib/render.mjs) and check-pins.mjs import from it, and only
// readEnvKey, childEnv and REPO_ROOT.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { run, spawnMissing, tail } from '../lib/proc.mjs'

export const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
export const RENDER_ENV = path.join(import.meta.dirname, 'render.env')
export const TEMPLATE_DIR = 'infra/host/templates/env'

/** The production compose projects (spec A section E). `dir` is the
 * project directory COMPOSE_FILE is relative to; `exemptKey` names the env
 * key holding that project's own exemption list, when it has one. */
export const PROJECTS = [
  { name: 'state', template: `${TEMPLATE_DIR}/state.env.tmpl`, dir: '.', exemptKey: 'HEALTH_EXEMPT_SERVICES' },
  { name: 'app', template: `${TEMPLATE_DIR}/app.env.tmpl`, dir: '.', exemptKey: null },
  { name: 'mail', template: `${TEMPLATE_DIR}/mail.env.tmpl`, dir: 'infra/host/mail', exemptKey: null },
  { name: 'ops', template: `${TEMPLATE_DIR}/ops.env.tmpl`, dir: 'compose/observability', exemptKey: 'HEALTH_EXEMPT_SERVICES' },
]

/** The pins layers are resolved per release by gremion-deploy; they only swap
 * image references for digests and are not censused (brief Q2). TASK-048b
 * split the layer per project: the app colours read docker-compose.pins.yml,
 * the state project docker-compose.state-pins.yml. */
export const PINS_FILES = Object.freeze(['docker-compose.pins.yml', 'docker-compose.state-pins.yml'])

/**
 * Dated allowances for a compose file a template names but the tree does not
 * carry yet (brief Q2). Each one is self-retiring: the moment the file exists
 * the allowance itself FAILS the census, so the merge that lands the file has
 * to delete the entry here in the same change. An absent file with no
 * allowance is a failure, never a skip.
 *
 * Empty since TASK-040's merge: the only entry (project app,
 * docker-compose.app.yml, dated 2026-09-27) retired in the change that landed
 * the file, so the app project is censused like every other.
 */
export const ALLOWANCES = []

/**
 * The value of `key` in an env-file text, located by key. Returns null when
 * the key is absent; throws when it is declared twice (which value the host
 * would use is then a question of which tool reads the file).
 */
export function readEnvKey(text, key) {
  const hits = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    if (line.slice(0, eq).trim() === key) hits.push(line.slice(eq + 1).trim())
  }
  if (hits.length > 1) throw new Error(`${key} is declared ${hits.length} times`)
  return hits.length === 1 ? hits[0] : null
}

/** Space-separated, exactly like gremion-deploy / gremion-verify iterate it
 * (`for e in ${HEALTH_EXEMPT_SERVICES}`). Each token is an exact name. */
export function parseExemptList(value) {
  return (value ?? '').split(/\s+/).filter(Boolean)
}

// OS and docker-client variables only. Everything else -- COMPOSE_*, and any
// name a compose file interpolates -- stays out of the render's environment.
const CHILD_ENV_ALLOW = new Set(
  [
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'OS',
    'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
    'PROGRAMW6432', 'COMMONPROGRAMFILES', 'USERNAME', 'USER', 'LOGNAME',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'LANG', 'LC_ALL',
    'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH',
    'DOCKER_TLS_VERIFY', 'DOCKER_API_VERSION', 'DOCKER_BUILDKIT', 'BUILDKIT_PROGRESS',
  ].map((k) => k.toUpperCase()),
)

/** The render's environment: the allow-list above, case-insensitively (a
 * Windows env carries `Path`, `SystemRoot`). */
export function childEnv(parentEnv = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(parentEnv)) {
    if (CHILD_ENV_ALLOW.has(k.toUpperCase())) out[k] = v
  }
  return out
}

/**
 * The render plan for one project: files, profiles and the exact docker
 * argv, or the reasons it cannot be rendered. Pure apart from `exists` /
 * `readText`, both injectable.
 */
export function planRender(project, { root = REPO_ROOT, renderEnv = RENDER_ENV, allowances = ALLOWANCES, exists = existsSync, readText = (p) => readFileSync(p, 'utf8') } = {}) {
  const plan = { project: project.name, dir: path.resolve(root, project.dir), files: [], profiles: [], notes: [], errors: [], allowed: false, exempt: [], argv: null }
  let text
  try {
    text = readText(path.join(root, project.template))
  } catch (err) {
    plan.errors.push(`cannot read ${project.template}: ${err.message}`)
    return plan
  }
  let composeFile, composeProfiles
  try {
    composeFile = readEnvKey(text, 'COMPOSE_FILE')
    composeProfiles = readEnvKey(text, 'COMPOSE_PROFILES')
    if (project.exemptKey) plan.exempt = parseExemptList(readEnvKey(text, project.exemptKey))
  } catch (err) {
    plan.errors.push(`${project.template}: ${err.message}`)
    return plan
  }
  if (!composeFile) {
    plan.errors.push(`${project.template} declares no COMPOSE_FILE`)
    return plan
  }
  plan.profiles = (composeProfiles ?? '').split(',').map((s) => s.trim()).filter(Boolean)

  for (const rel of composeFile.split(':').map((s) => s.trim()).filter(Boolean)) {
    const abs = path.join(plan.dir, rel)
    const allowance = allowances.find((a) => a.project === project.name && a.file === rel)
    if (PINS_FILES.includes(rel)) {
      plan.notes.push(`pins: not censused (${project.name}: ${rel})`)
      continue
    }
    if (allowance) {
      if (exists(abs)) {
        plan.errors.push(
          `stale allowance: ${rel} now exists, so the dated allowance (${allowance.dated}, ${allowance.removedBy}) in ` +
            'scripts/verify/census/render.mjs ALLOWANCES must be deleted in the change that landed it',
        )
      } else {
        plan.allowed = true
        plan.notes.push(`${project.name}: ${rel} absent -- dated allowance ${allowance.dated}, removed by ${allowance.removedBy}'s merge (${allowance.why}); project not censused`)
      }
      continue
    }
    if (!exists(abs)) {
      plan.errors.push(`${project.template} lists ${rel}, which does not exist under ${project.dir}`)
      continue
    }
    plan.files.push(abs)
  }
  if (plan.errors.length > 0 || plan.allowed) return plan
  if (plan.files.length === 0) {
    plan.errors.push(`${project.template}: no compose file left to render`)
    return plan
  }
  plan.argv = [
    'compose',
    '--env-file', renderEnv,
    '--project-directory', plan.dir,
    ...plan.files.flatMap((f) => ['-f', f]),
    ...plan.profiles.flatMap((p) => ['--profile', p]),
    'config', '--format', 'json',
  ]
  return plan
}

/**
 * Run one plan. `{ok: true, services}` only when docker exited 0 AND printed
 * a JSON document with a `services` object; everything else is a failed
 * render with a reason. A plan that is not renderable is passed through.
 */
export function renderProject(plan, { docker = run, env = childEnv() } = {}) {
  if (plan.errors.length > 0) return { project: plan.project, ok: false, detail: plan.errors.join('; ') }
  if (plan.allowed) return { project: plan.project, ok: true, allowed: true, services: {} }
  const res = docker('docker', plan.argv, { cwd: plan.dir, env, timeout: 120_000 })
  if (spawnMissing(res)) return { project: plan.project, ok: false, toolMissing: 'docker', detail: 'docker not found' }
  if (res.code !== 0) {
    return { project: plan.project, ok: false, detail: `docker compose config exited ${res.code ?? res.signal}: ${tail(res.stderr || res.stdout)}` }
  }
  let doc
  try {
    doc = JSON.parse(res.stdout)
  } catch {
    return { project: plan.project, ok: false, detail: `docker compose config printed no JSON document: ${tail(res.stdout || '(empty stdout)')}` }
  }
  if (!doc || typeof doc.services !== 'object' || doc.services === null || Array.isArray(doc.services)) {
    return { project: plan.project, ok: false, detail: 'the rendered document has no services object' }
  }
  return { project: plan.project, ok: true, services: doc.services }
}
