#!/usr/bin/env node
// Guard: a Traefik may only discover containers of ITS OWN stack.
//
// Incident 2026-10-29: the docker provider (docker/traefik/traefik.yml) had no
// constraint, so a Traefik read the labels of EVERY labelled container on the
// Docker daemon. Two stacks on one daemon (a proof stack beside the live env, a
// second kernel unit) loaded each other's routers and middlewares; identical
// names (hsts, kc-admin-allowlist, gremion-ui*, edge-*) collided, Traefik
// dropped the conflicting definitions and disabled every router that used them
// -- the live env answered 404.
//
// The contract this guard holds:
//   1. docker/traefik/traefik.yml's docker provider carries
//      `constraints: "Label(`org.gremion.stack`,`@STACK@`)"`, and the `traefik`
//      service of docker-compose.yml renders @STACK@ from its STACK variable.
//   2. EVERY service, in every compose file of the repository, that opts in to
//      Traefik (traefik.enable=true) or declares a router/service/middleware
//      (traefik.http.* / traefik.tcp.* / traefik.udp.*) carries the label
//      `org.gremion.stack` with a non-empty value; outside test/ fixtures so does
//      every service with any other traefik.* label (the app colours' enable=false). A routed container without it
//      is invisible to its own Traefik (a silent 404); a label-less Traefik
//      config is visible to every other stack's.
//
// DECLARED vs COLLECTED: the guard refuses to pass over zero compose files or
// zero routed services, and the suite names the routed services that must be
// seen (a parser that dropped a file would otherwise pass vacuously).
//
// Run:  node scripts/check-traefik-stack-scope.mjs
// Test: node --test scripts/check-traefik-stack-scope.test.mjs

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

export const KERNEL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const STACK_LABEL = 'org.gremion.stack'
export const STACK_MARKER = '@STACK@'
export const CONSTRAINT = 'Label(`org.gremion.stack`,`@STACK@`)'

// k8s manifests use IngressRoute CRDs (a different provider); node_modules and
// build output never hold a deployed composition. logLevel 'error': compose's own
// `!override` / `!reset` tags are unknown to a plain YAML reader (a warning, not a failure).
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.svelte-kit', 'coverage', 'k8s', '.worktrees'])
const COMPOSE_NAME_RE = /(^|\/)docker-compose[^/]*\.ya?ml$/

const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** Every file under <root> (outside the skipped dirs) accepted by <keep>, as repo-relative posix paths. */
function walkFiles(root, keep) {
  const out = []
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const p = rel ? posix.join(rel, e.name) : e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p)
      } else if (keep(p)) out.push(p)
    }
  }
  walk('')
  return out.sort(byPath)
}

/** Every YAML file under <root> that can hold a compose composition, as repo-relative posix paths. */
export function findComposeFiles(root) {
  return walkFiles(root, (p) => COMPOSE_NAME_RE.test(p) || (/\.ya?ml$/.test(p) && /^compose\//.test(p)))
}

// A candidate found by CONTENT: a file named like neither of the compose conventions above can still
// be passed to `docker compose -f`; a traefik.enable / traefik.http. label inside it is the tell.
const TRAEFIK_LABEL_RE = /traefik\.(enable|http\.)/

/** YAML files outside the skipped dirs that carry a traefik.enable / traefik.http. label but are not in <known>. */
export function findUnscannedTraefikYaml(root, known) {
  const seen = new Set(known)
  return walkFiles(root, (p) => /\.ya?ml$/.test(p) && !seen.has(p)).filter((p) => TRAEFIK_LABEL_RE.test(readFileSync(join(root, p), 'utf8')))
}

/** Labels of one service as a plain {key: string} map, from the list or the map form. */
export function labelMap(labels) {
  const out = {}
  if (Array.isArray(labels)) {
    for (const l of labels) {
      const s = String(l)
      const i = s.indexOf('=')
      if (i === -1) out[s] = ''
      else out[s.slice(0, i)] = s.slice(i + 1)
    }
  } else if (labels && typeof labels === 'object') {
    for (const [k, v] of Object.entries(labels)) out[k] = v === null || v === undefined ? '' : String(v)
  }
  return out
}

/** A service is routed when it opts in to Traefik or declares any dynamic Traefik object. */
export function isRouted(labels) {
  if (String(labels['traefik.enable']).toLowerCase() === 'true') return true
  return Object.keys(labels).some((k) => /^traefik\.(http|tcp|udp|tls)\./.test(k))
}

/**
 * @param {string} text a compose file
 * @returns {{service: string, labels: Record<string,string>, routed: boolean}[]} every service carrying a traefik.* label
 */
export function routedServices(text, file = '<text>') {
  let doc
  try {
    doc = parse(text, { merge: true, logLevel: 'error' })
  } catch (e) {
    throw new Error(`${file}: not parseable YAML (${e.message.split('\n')[0]})`)
  }
  const out = []
  for (const [service, def] of Object.entries(doc?.services ?? {})) {
    const labels = labelMap(def?.labels)
    const traefikLabelled = Object.keys(labels).some((k) => k.startsWith('traefik.'))
    if (traefikLabelled) out.push({ service, labels, routed: isRouted(labels) })
  }
  return out
}

/** The docker provider constraint of a traefik.yml, or '' when absent. */
export function dockerConstraint(text) {
  const doc = parse(text)
  const c = doc?.providers?.docker?.constraints
  return typeof c === 'string' ? c : ''
}

/** @returns {{problems: string[], files: number, routed: {file: string, service: string}[]}} */
export function checkStackScope(root = KERNEL_ROOT) {
  const problems = []
  const routed = []
  const files = findComposeFiles(root)
  if (files.length === 0) problems.push('no compose file found -- the guard has gone blind')
  for (const f of files) {
    let services
    try {
      services = routedServices(readFileSync(join(root, f), 'utf8'), f)
    } catch (e) {
      problems.push(e.message)
      continue
    }
    // A traefik.enable=false service declares no router, so a fixture under test/ may leave it
    // unlabelled; the real compositions label EVERY container that carries a traefik.* label.
    const strict = !f.startsWith('test/')
    for (const { service, labels, routed: isR } of services) {
      if (isR) routed.push({ file: f, service })
      if ((isR || strict) && !labels[STACK_LABEL])
        problems.push(
          `${f}: service '${service}' carries Traefik labels but no ${STACK_LABEL} label -- ` +
            `a stack-constrained Traefik never sees it (silent 404), and an unconstrained one lets two stacks collide`,
        )
    }
  }
  if (files.length > 0 && routed.length === 0) problems.push('no routed service found in any compose file -- the guard has gone blind')

  for (const p of findUnscannedTraefikYaml(root, files))
    problems.push(
      `${p}: carries a traefik.enable / traefik.http. label but is not a compose file the guard scans ` +
        `(name it docker-compose*.yml or put it under compose/) -- its services escape the ${STACK_LABEL} check`,
    )

  const yml = join(root, 'docker/traefik/traefik.yml')
  if (!existsSync(yml)) problems.push('docker/traefik/traefik.yml is missing')
  else {
    let c
    try {
      c = dockerConstraint(readFileSync(yml, 'utf8'))
    } catch (e) {
      problems.push(`docker/traefik/traefik.yml: not parseable YAML (${e.message.split('\n')[0]})`)
    }
    if (c !== undefined && c !== CONSTRAINT)
      problems.push(
        `docker/traefik/traefik.yml: providers.docker.constraints is ${c ? JSON.stringify(c) : 'absent'}, want ${JSON.stringify(CONSTRAINT)} -- ` +
          `without it this Traefik loads the routers and middlewares of every stack on the Docker daemon`,
      )
  }

  const stateFile = join(root, 'docker-compose.yml')
  if (!existsSync(stateFile)) problems.push('docker-compose.yml is missing -- the traefik service that renders @STACK@ cannot be checked')
  else {
    let svc
    let parsed = true
    try {
      svc = parse(readFileSync(stateFile, 'utf8'), { merge: true, logLevel: 'error' })?.services?.traefik
    } catch (e) {
      parsed = false
      problems.push(`docker-compose.yml: not parseable YAML (${e.message.split('\n')[0]})`)
    }
    if (parsed && !svc) problems.push('docker-compose.yml: no traefik service')
    else if (parsed) {
      const cmd = [].concat(svc.command ?? []).join(' ')
      const env = svc.environment ?? {}
      // `STACK=x`, the bare passthrough `STACK` (list form) and `STACK:` with a null value (map form) all hand the variable on.
      const stackEnv = Array.isArray(env)
        ? env.some((e) => String(e) === 'STACK' || String(e).startsWith('STACK='))
        : Object.hasOwn(env, 'STACK')
      if (!stackEnv) problems.push('docker-compose.yml: the traefik service does not pass STACK into its environment (the @STACK@ render has no source)')
      if (!cmd.includes(`s|${STACK_MARKER}|`)) problems.push(`docker-compose.yml: the traefik command has no sed expression for ${STACK_MARKER}`)
    }
  }
  return { problems, files: files.length, routed }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = checkStackScope()
  if (r.problems.length) {
    console.error(`[traefik-stack-scope] ${r.problems.length} problem(s):`)
    for (const p of r.problems) console.error(`  x ${p}`)
    process.exit(1)
  }
  console.log(`[traefik-stack-scope] ${r.files} compose file(s), ${r.routed.length} routed service(s): all carry ${STACK_LABEL}; the docker provider is constrained`)
}
