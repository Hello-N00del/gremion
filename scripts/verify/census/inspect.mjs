// TASK-036 (L1-17): the image arm of the health census.
//
// No compose reader can see an image-level HEALTHCHECK, so every rendered
// service's image is inspected (`{{json .Config.Healthcheck}}`, B30 Task 2):
//   - first-party (the render carries `build:`): BUILT from that build block
//     at the tested SHA and tagged census-<sha8>/<service>. The render's
//     `image:` name (ghcr.io/...:latest) is never inspected -- a :latest pull
//     describes whatever was last pushed, not the tree under test. Every
//     build gets the render's build.args plus BUILD_SHA=<sha7> (brief Q6:
//     TASK-032's Dockerfiles require it).
//   - third-party: inspected as rendered; pulled (by the rendered reference,
//     digest-pinned where the compose file pins one) only when absent.
// A build, pull or inspect failure is a failed result with its reason, never
// a null healthcheck -- "could not look" must not read as "looked, none".
import path from 'node:path'
import { run, spawnMissing, tail } from '../lib/proc.mjs'

const BUILD_TIMEOUT_MS = 20 * 60_000
const PULL_TIMEOUT_MS = 10 * 60_000
const INSPECT_TIMEOUT_MS = 2 * 60_000

/** The build keys this census knows how to reproduce with `docker build`.
 * Anything else (secrets, ssh, additional_contexts, dockerfile_inline, ...)
 * would make the census build something other than the host does, so it is
 * refused rather than dropped. */
export const BUILD_KEYS = new Set(['context', 'dockerfile', 'args', 'target'])

export function censusTag(sha8, service) {
  return `census-${sha8}/${service}`
}

/**
 * One entry per rendered service: `{key, project, service, kind, ref, build?}`.
 * @param {Array<{project: string, render: {ok: boolean, services?: object}}>} projects
 */
export function planImages(projects, { sha8 }) {
  const entries = []
  const errors = []
  const builtBy = new Map()
  for (const p of projects) {
    if (!p.render.ok) continue
    for (const [service, def] of Object.entries(p.render.services ?? {})) {
      const key = `${p.project}/${service}`
      if (def.build) {
        const unknown = Object.keys(def.build).filter((k) => !BUILD_KEYS.has(k))
        if (unknown.length > 0 || typeof def.build.context !== 'string') {
          errors.push({ key, detail: `build block of ${key} uses ${unknown.join(', ') || 'no context'} -- not reproducible by the census` })
          continue
        }
        const ref = censusTag(sha8, service)
        const spec = JSON.stringify(def.build)
        if (builtBy.has(ref) && builtBy.get(ref) !== spec) {
          errors.push({ key, detail: `${ref} would be built from two different build blocks` })
          continue
        }
        builtBy.set(ref, spec)
        entries.push({ key, project: p.project, service, kind: 'build', ref, build: def.build })
      } else if (typeof def.image === 'string' && def.image.length > 0) {
        entries.push({ key, project: p.project, service, kind: 'pull', ref: def.image })
      } else {
        errors.push({ key, detail: `${key} has neither build: nor image:` })
      }
    }
  }
  return { entries, errors }
}

/** `docker build` argv for one first-party entry. */
export function buildArgv(entry, { buildSha }) {
  const { context, dockerfile = 'Dockerfile', args = {}, target } = entry.build
  const buildArgs = { ...args, BUILD_SHA: buildSha }
  return [
    'build', '-q',
    '-t', entry.ref,
    '-f', path.resolve(context, dockerfile),
    ...Object.entries(buildArgs).flatMap(([k, v]) => ['--build-arg', `${k}=${v ?? ''}`]),
    ...(target ? ['--target', target] : []),
    context,
  ]
}

/** Builds each distinct first-party ref once. Returns ref -> {ok, ms, detail}. */
export function buildImages(entries, { docker = run, buildSha, log = () => {} }) {
  const results = new Map()
  for (const e of entries) {
    if (e.kind !== 'build' || results.has(e.ref)) continue
    const res = docker('docker', buildArgv(e, { buildSha }), { timeout: BUILD_TIMEOUT_MS })
    const ms = res.durationMs ?? 0
    const ok = res.code === 0 && !spawnMissing(res)
    results.set(e.ref, { ok, ms, detail: ok ? '' : `docker build exited ${res.code ?? res.signal ?? res.error?.code}: ${tail(res.stderr || res.stdout)}` })
    log(`build ${e.service} -> ${e.ref}: ${ok ? 'ok' : 'FAILED'} in ${(ms / 1000).toFixed(1)}s`)
  }
  return results
}

function parseHealthLine(line) {
  const hc = JSON.parse(line)
  if (hc !== null && (typeof hc !== 'object' || Array.isArray(hc))) throw new Error(`not a Healthcheck object: ${line}`)
  return hc
}

function inspectOne(docker, ref) {
  const res = docker('docker', ['image', 'inspect', '--format', '{{json .Config.Healthcheck}}', ref], { timeout: INSPECT_TIMEOUT_MS })
  if (res.code !== 0) return { ok: false, detail: `docker image inspect ${ref} exited ${res.code ?? res.signal ?? res.error?.code}: ${tail(res.stderr || res.stdout, 300)}` }
  const lines = res.stdout.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length !== 1) return { ok: false, detail: `docker image inspect ${ref} printed ${lines.length} lines, expected 1` }
  try {
    return { ok: true, healthcheck: parseHealthLine(lines[0]) }
  } catch (err) {
    return { ok: false, detail: `docker image inspect ${ref}: ${err.message}` }
  }
}

/**
 * ref -> {ok: true, healthcheck: object|null} | {ok: false, detail}.
 * One batched inspect first (each docker call costs seconds on some hosts);
 * any failure falls back to per-ref inspection, pulling an absent
 * third-party ref once. `pullable(ref)` is false for census build tags.
 */
export function inspectHealthchecks(refs, { docker = run, pullable = () => true, log = () => {} } = {}) {
  const unique = [...new Set(refs)]
  const out = new Map()
  if (unique.length === 0) return out
  const batch = docker('docker', ['image', 'inspect', '--format', '{{json .Config.Healthcheck}}', ...unique], { timeout: INSPECT_TIMEOUT_MS })
  if (batch.code === 0) {
    const lines = batch.stdout.split(/\r?\n/).filter((l) => l.trim() !== '')
    if (lines.length === unique.length) {
      try {
        unique.forEach((ref, i) => out.set(ref, { ok: true, healthcheck: parseHealthLine(lines[i]) }))
        return out
      } catch {
        out.clear()
      }
    }
  }
  for (const ref of unique) {
    let r = inspectOne(docker, ref)
    if (!r.ok && pullable(ref)) {
      const pull = docker('docker', ['pull', '-q', ref], { timeout: PULL_TIMEOUT_MS })
      log(`pull ${ref}: ${pull.code === 0 ? 'ok' : 'FAILED'}`)
      r = pull.code === 0 ? inspectOne(docker, ref) : { ok: false, detail: `${r.detail}; docker pull exited ${pull.code ?? pull.signal ?? pull.error?.code}: ${tail(pull.stderr || pull.stdout, 300)}` }
    }
    out.set(ref, r)
  }
  return out
}

/** Removes the census build tags (brief S9: removed by tag after). */
export function removeTags(refs, { docker = run } = {}) {
  const unique = [...new Set(refs)]
  if (unique.length === 0) return
  docker('docker', ['image', 'rm', ...unique], { timeout: INSPECT_TIMEOUT_MS })
}
