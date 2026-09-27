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
 * The census over rendered projects.
 *
 * @param {object} input
 * @param {Array<{project: string, render: {ok: boolean, allowed?: boolean, services?: object, detail?: string}, exempt: string[], notes: string[]}>} input.projects
 * @param {Map<string, {ok: boolean, healthcheck?: object|null, detail?: string}>} input.images keyed `<project>/<service>`
 * @returns {{collected: number, passed: number, failed: number, unparseable: boolean, lines: string[], problems: string[]}}
 */
export function runCensus({ projects, images }) {
  const out = { collected: 0, passed: 0, failed: 0, unparseable: false, lines: [], problems: [] }
  for (const p of projects) {
    out.lines.push(...(p.notes ?? []))
    const services = p.render.services ?? {}
    const names = Object.keys(services).sort()
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
  return out
}
