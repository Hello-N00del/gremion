// TASK-053 (L2-05): the shared production-render harness of the render-guards
// suite. NO third renderer (brief S5.1): it drives TASK-040's PROJECTS through
// TASK-040's renderProject (docker compose --env-file <fixture> config, every
// profile on), once per run.
//
// The one deviation from TASK-040's renders (brief Q4): the app-blue and
// app-green projects render with the RELEASE CONTRACT pins fixture in their
// pins slot instead of the pooled-stack fixture's `services: {}`, so the
// build-absence guard judges what a released host renders (first-party
// services pinned by digest, `build: !reset null`). It is passed as
// COMPOSE_FILE together with COMPOSE_PATH_SEPARATOR ':' (compose on Windows
// defaults to ';', which would read the whole list as one path).
// State, ops and mail keep TASK-040's own pins until TASK-048b ships a
// state-pins release fixture: the release fixture layered over state would ADD
// gremion-ui/gremion-public/migrate there as phantom services.
//
// Post-conditions asserted on every run, never assumed:
//   - at least one project, every render an object with >= 1 service;
//   - a swapped app render has no `build` on gremion-ui and carries the
//     fixture's digest;
//   - the state render contains no APP_SERVICES entry (no phantom services).
// A renderer that returns a Promise is refused (verify's runAll is synchronous).
import { APP_SERVICES, PROJECTS, renderProject } from '../../check-pooled-stack.mjs'
import { readEnvFile } from '../../compose-edge.mjs'

/** The release contract fixture (read only; TASK-046/048 own it). */
export const RELEASE_PINS_FIXTURE = 'test/host/fixtures/release/valid/docker-compose.pins.yml'
export const RELEASE_UI_IMAGE =
  'ghcr.io/hello-n00del/gremion-ui@sha256:1111111111111111111111111111111111111111111111111111111111111111'
/** The projects whose pins slot is swapped for the release fixture. When
 * TASK-048b ships a state-pins release fixture, state joins here (X-053 ii). */
export const SWAP_PINS = { 'app-blue': RELEASE_PINS_FIXTURE, 'app-green': RELEASE_PINS_FIXTURE }
/** The pins slot of a COMPOSE_FILE list, located by basename, never by name. */
export const PINS_SLOT = /(^|\/)docker-compose[A-Za-z0-9._-]*pins\.yml$/

export class HarnessError extends Error {
  /** @param {'toolMissing'|'unparseable'} kind */
  constructor(kind, message) {
    super(message)
    this.kind = kind
  }
}

/** The COMPOSE_FILE a swapped project renders with: its fixture list with the
 * pins slot replaced. A list without a pins slot is a harness error. */
export function swappedComposeFile(fixtureComposeFile, pins) {
  const parts = String(fixtureComposeFile ?? '').split(':').filter(Boolean)
  const i = parts.findIndex((p) => PINS_SLOT.test(p))
  if (i < 0) throw new HarnessError('unparseable', `COMPOSE_FILE ${JSON.stringify(fixtureComposeFile)} has no pins slot to swap`)
  parts[i] = pins
  return parts.join(':')
}

/** The env overrides one project renders with (only the swap; the parent
 * environment never reaches the render -- renderState forwards docker's own
 * keys only, and renderProject pins COMPOSE_PROFILES='*'). */
export function renderEnvFor(project, { readEnv = readEnvFile, swap = SWAP_PINS } = {}) {
  const pins = swap[project.id]
  if (!pins) return {}
  return {
    COMPOSE_FILE: swappedComposeFile(readEnv(project.envFile).COMPOSE_FILE, pins),
    COMPOSE_PATH_SEPARATOR: ':',
  }
}

/** Post-condition problems of one render (empty = fine). */
export function renderProblems(id, render, { swap = SWAP_PINS } = {}) {
  if (!render || typeof render !== 'object') return [`${id}: the renderer returned no render object`]
  if (typeof render.then === 'function') return [`${id}: the renderer returned a Promise -- the harness is synchronous (verify's runAll does not await)`]
  const svcs = render.services ?? {}
  const out = []
  if (Object.keys(svcs).length === 0) out.push(`${id}: renders zero services -- every guard over it would pass vacuously`)
  if (swap[id]) {
    const ui = svcs['gremion-ui']
    if (!ui) out.push(`${id}: gremion-ui is absent from the swapped render`)
    else {
      if (ui.build !== undefined && ui.build !== null) out.push(`${id}: the pins swap did not take -- gremion-ui still renders a build: key`)
      if (ui.image !== RELEASE_UI_IMAGE) out.push(`${id}: the pins swap did not take -- gremion-ui image is ${JSON.stringify(ui.image ?? null)}, want the fixture digest`)
    }
  }
  if (id === 'state') {
    for (const s of APP_SERVICES) if (svcs[s]) out.push(`state: carries the app-tier service ${s} (a pins layer added a phantom service)`)
  }
  return out
}

/**
 * Renders every project once. Returns { renders: {id -> render}, counts:
 * {id -> service count}, envs: {id -> env overrides} }, or throws a
 * HarnessError: kind 'toolMissing' when docker cannot be run, 'unparseable'
 * for anything else (0 projects, a failed render naming its project, a
 * post-condition that does not hold).
 */
export function renderAll({ projects = PROJECTS, render = renderProject, readEnv = readEnvFile, swap = SWAP_PINS } = {}) {
  if (!Array.isArray(projects) || projects.length === 0) throw new HarnessError('unparseable', 'the harness was given 0 projects to render')
  const renders = {}
  const counts = {}
  const envs = {}
  const problems = []
  for (const p of projects) {
    const env = renderEnvFor(p, { readEnv, swap })
    envs[p.id] = env
    let r
    try {
      r = render(p, { env })
    } catch (err) {
      const msg = String(err?.message ?? err).split('\n')[0]
      if (/docker could not be run/.test(msg)) throw new HarnessError('toolMissing', `${p.id}: ${msg}`)
      throw new HarnessError('unparseable', `${p.id}: render failed: ${msg}`)
    }
    problems.push(...renderProblems(p.id, r, { swap }))
    renders[p.id] = r
    counts[p.id] = Object.keys(r?.services ?? {}).length
  }
  if (problems.length) throw new HarnessError('unparseable', problems.join('\n'))
  return { renders, counts, envs }
}
