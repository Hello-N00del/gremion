#!/usr/bin/env node
// TASK-036 (L1-17, TRD-178): the declared health census.
//
// Every service a production render starts is PROBED -- by a healthcheck in
// the render (compose), or by an image-level HEALTHCHECK no compose reader
// can see (image) -- or it is an EXEMPT one-shot named on its project's
// HEALTH_EXEMPT_SERVICES list. Anything else is UNPROBED, by name.
//
// "I could not look" is never a pass: an image that could not be built,
// pulled or inspected is unparseable, even when the service carries a compose
// healthcheck (brief S1: every service's image is inspected).

import { pathToFileURL } from 'node:url'
import { headSha } from '../lib/git.mjs'
import { evaluateSuite } from '../lib/guard.mjs'
import { buildImages, planImages, removeTags } from './inspect.mjs'
import { REPO_ROOT } from './render.mjs'
import { renderAll, runCensusSuite } from './suite.mjs'

/** A compose healthcheck's state: 'probe' (a test that runs), 'disabled'
 * (`disable: true` or `test: ["NONE"]`), 'inherit' (timing only, the image's
 * own test runs) or 'absent'. */
export function composeHealth(hc) {
  if (hc === undefined || hc === null) return 'absent'
  if (hc.disable === true) return 'disabled'
  const t = hc.test
  if (t === undefined || t === null) return 'inherit'
  if (Array.isArray(t)) {
    if (t.length === 0) return 'inherit'
    if (t[0] === 'NONE') return 'disabled'
    return 'probe'
  }
  if (typeof t === 'string') return t.trim() === '' ? 'inherit' : 'probe'
  return 'disabled'
}

/** `docker image inspect --format '{{json .Config.Healthcheck}}'`: null, or
 * `{Test: [...]}`. `["NONE"]` is the image-level explicit opt-out. */
export function imageProbed(hc) {
  return Boolean(hc && Array.isArray(hc.Test) && hc.Test.length > 0 && hc.Test[0] !== 'NONE')
}

/** A one-shot never restarts: `restart` absent or `no` (spec A section K). */
export function isOneShot(service) {
  return service.restart === undefined || service.restart === null || service.restart === 'no'
}

/**
 * @param {{name: string, service: object, image: {ok: boolean, healthcheck?: object|null, detail?: string}|undefined, exempt: boolean}} input
 * @returns {{status: 'probed'|'exempt'|'unprobed'|'unparseable', via?: 'compose'|'image', reason?: string}}
 */
export function classifyService({ name, service, image, exempt }) {
  if (!image || !image.ok) {
    return { status: 'unparseable', reason: image?.detail ?? `no inspection result for ${name}'s image` }
  }
  const compose = composeHealth(service.healthcheck)
  if (compose === 'probe') return { status: 'probed', via: 'compose' }
  if (compose !== 'disabled' && imageProbed(image.healthcheck)) return { status: 'probed', via: 'image' }
  if (exempt) return { status: 'exempt' }
  return { status: 'unprobed', reason: compose === 'disabled' ? 'healthcheck disabled in compose' : 'no healthcheck in compose or image' }
}

/**
 * Brief Q4: scripts/verify/census/leaf-blast-radius.json,
 * `{schemaVersion: 1, rows: {"<service>": {"probePath": "/healthz"}}}`.
 * Shipped empty. A row fails when it names no rendered service, or when that
 * service's image HEALTHCHECK does not carry the row's probe path -- the row
 * declares what a leaf's own image probes, so it is read off the image.
 * @returns {{unparseable: string|null, failures: string[]}}
 */
export function checkBlastRadius(doc, projects, images) {
  if (doc === undefined) return { unparseable: null, failures: [] }
  if (!doc || typeof doc !== 'object' || doc.schemaVersion !== 1 || !doc.rows || typeof doc.rows !== 'object' || Array.isArray(doc.rows)) {
    return { unparseable: 'leaf-blast-radius.json is not {schemaVersion: 1, rows: {...}}', failures: [] }
  }
  const failures = []
  for (const [service, row] of Object.entries(doc.rows)) {
    const probePath = row?.probePath
    if (typeof probePath !== 'string' || probePath === '') {
      failures.push(`leaf-blast-radius row ${service} has no probePath`)
      continue
    }
    const owners = projects.filter((p) => p.render.ok && Object.hasOwn(p.render.services ?? {}, service))
    if (owners.length === 0) {
      failures.push(`leaf-blast-radius row ${service} names no rendered service`)
      continue
    }
    for (const p of owners) {
      const img = images.get(`${p.project}/${service}`)
      const testText = img?.ok && imageProbed(img.healthcheck) ? img.healthcheck.Test.join(' ') : ''
      if (!testText.includes(probePath)) {
        failures.push(`leaf-blast-radius row ${service} [${p.project}]: the image HEALTHCHECK does not probe ${probePath}`)
      }
    }
  }
  return { unparseable: null, failures }
}

/**
 * The census over rendered projects.
 *
 * @param {object} input
 * @param {Array<{project: string, render: {ok: boolean, allowed?: boolean, services?: object, detail?: string}, exempt: string[], notes: string[]}>} input.projects
 * @param {Map<string, {ok: boolean, healthcheck?: object|null, detail?: string}>} input.images keyed `<project>/<service>`
 * @param {object} [input.blastRadius] parsed leaf-blast-radius.json (Q4); undefined = not checked
 * @returns {{collected: number, passed: number, failed: number, unparseable: boolean, lines: string[], problems: string[]}}
 */
export function runCensus({ projects, images, blastRadius }) {
  const out = { collected: 0, passed: 0, failed: 0, unparseable: false, lines: [], problems: [] }
  // Vacuity guard (brief S1, TDD 4). A census that read nothing passes in
  // silence -- recorded against the commit before this guard existed: a
  // project rendering {"services":{}}, a failed render and zero projects all
  // came back with failed 0 and no problem. Each is now unparseable by name.
  if (!Array.isArray(projects) || projects.length === 0) {
    out.unparseable = true
    out.problems.push('no production project to census -- the census read nothing')
    return out
  }
  for (const p of projects) {
    out.lines.push(...(p.notes ?? []))
    if (!p.render.ok) {
      out.unparseable = true
      out.problems.push(`${p.project}: render failed: ${p.render.detail ?? '(no detail)'}`)
      continue
    }
    const services = p.render.services ?? {}
    const names = Object.keys(services).sort()
    if (names.length === 0 && !p.render.allowed) {
      out.unparseable = true
      out.problems.push(`${p.project} rendered 0 services -- a census of nothing is not a pass`)
    }
    const exempt = new Set(p.exempt ?? [])
    for (const name of names) {
      const service = services[name]
      out.collected++
      const tag = `${name} [${p.project}]`
      const listed = exempt.has(name)
      const v = classifyService({ name, service, image: images.get(`${p.project}/${name}`), exempt: listed })
      if (listed && !isOneShot(service)) {
        out.failed++
        out.problems.push(`${tag} is exempt but restart: ${service.restart} -- only one-shots (restart absent or "no") may be exempt`)
        out.lines.push(`UNPROBED ${tag}`)
        continue
      }
      if (v.status === 'unparseable') {
        out.unparseable = true
        out.problems.push(`image of ${tag} could not be inspected: ${v.reason}`)
        out.lines.push(`unparseable ${tag}`)
      } else if (v.status === 'probed') {
        out.passed++
        out.lines.push(`probed ${name} (${v.via}) [${p.project}]`)
      } else if (v.status === 'exempt') {
        out.passed++
        out.lines.push(`exempt ${tag}`)
      } else {
        out.failed++
        out.problems.push(`${tag}: ${v.reason}`)
        out.lines.push(`UNPROBED ${tag}`)
      }
    }
    for (const e of exempt) {
      if (!Object.hasOwn(services, e)) {
        out.failed++
        out.problems.push(`HEALTH_EXEMPT_SERVICES (${p.project}) names ${e}, which ${p.project} does not render -- a stale exemption`)
      }
    }
  }
  const blast = checkBlastRadius(blastRadius, projects, images)
  if (blast.unparseable) {
    out.unparseable = true
    out.problems.push(blast.unparseable)
  }
  out.failed += blast.failures.length
  out.problems.push(...blast.failures)
  return out
}

// ---------------------------------------------------------------------------
// CLI.
//   node scripts/verify/census/census.mjs              -- the census, printed
//   node scripts/verify/census/census.mjs --build-only <svc>
//        builds ONE first-party service exactly as the census does (same
//        argv, BUILD_SHA included) to warm the Docker cache, one service per
//        agent tool call, before `verify --only census` (brief Q6). Prints the
//        build time; the census tag is removed afterwards, the cache stays.
// ---------------------------------------------------------------------------

export function buildOnly(service, { root = REPO_ROOT, log = console.log } = {}) {
  const sha = headSha(root)
  const rendered = renderAll({ root })
  const broken = rendered.filter((p) => !p.render.ok)
  if (broken.length > 0) {
    log(`[census] render failed: ${broken.map((p) => `${p.project}: ${p.render.detail}`).join('; ')}`)
    return 1
  }
  const { entries } = planImages(rendered, { sha8: sha.slice(0, 8) })
  const mine = entries.filter((e) => e.service === service && e.kind === 'build')
  if (mine.length === 0) {
    log(`[census] ${service} is not a first-party (build:) service of any production render`)
    return 1
  }
  const builds = buildImages(mine, { buildSha: sha.slice(0, 7), log: (l) => log(`[census] ${l}`) })
  removeTags([...builds.entries()].filter(([, b]) => b.ok).map(([ref]) => ref))
  const failed = [...builds.values()].filter((b) => !b.ok)
  for (const b of failed) log(`[census] ${b.detail}`)
  return failed.length === 0 ? 0 : 1
}

function main(argv) {
  if (argv[0] === '--build-only') {
    if (!argv[1] || argv.length !== 2) {
      console.error('usage: census.mjs [--build-only <service>]')
      return 1
    }
    return buildOnly(argv[1])
  }
  if (argv.length > 0) {
    console.error('usage: census.mjs [--build-only <service>]')
    return 1
  }
  const r = runCensusSuite()
  const verdict = evaluateSuite(r)
  if (r.detail) console.log(r.detail)
  console.log(`[census] ${verdict.status.toUpperCase()} collected=${r.collected} passed=${r.passed} failed=${r.failed}${verdict.reason ? ` -- ${verdict.reason}` : ''}`)
  return verdict.status === 'pass' ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (err) {
    console.error(`[census] FAILED -- internal error: ${err?.stack || err}`)
    process.exitCode = 1
  }
}
