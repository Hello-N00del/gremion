// TASK-036 (L1-17, TRD-178): the `census` verify suite.
//
// SYNCHRONOUS on purpose: verify.mjs's runAll() calls `runner()` without
// `await`, so an async runner hands back a Promise whose fields are all
// undefined -- judged `collected 0` at best, and its failures land after the
// verdict. Every docker call goes through lib/proc.mjs's spawnSync `run`.
//
// Result mapping onto TASK-045's suite shape:
//   docker absent                      -> toolMissing: 'docker' (never a skip)
//   render / build / pull / inspect failure, or a vacuous census
//                                      -> unparseable, naming project or image
//   UNPROBED, stale exemption, restarting exemption, Q4 row
//                                      -> failed
//   probed / exempt                    -> passed
//   collected = rendered services; skipped is always 0.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { stubEnvFilesIfAbsent } from '../lib/envstub.mjs'
import { headSha } from '../lib/git.mjs'
import { run, toolAvailable } from '../lib/proc.mjs'
import { runCensus } from './census.mjs'
import { buildImages, inspectHealthchecks, planImages, removeTags } from './inspect.mjs'
import { childEnv, planRender, PROJECTS, renderProject, REPO_ROOT } from './render.mjs'

export const BLAST_RADIUS_PATH = path.join(import.meta.dirname, 'leaf-blast-radius.json')

const ZERO = { collected: 0, passed: 0, failed: 0, skipped: 0 }

/** Render every project; returns the census's per-project input. */
export function renderAll({ root = REPO_ROOT, projects = PROJECTS, docker = run, env = childEnv() } = {}) {
  return projects.map((project) => {
    const plan = planRender(project, { root })
    const render = renderProject(plan, { docker, env })
    return { project: project.name, plan, render, exempt: plan.exempt, notes: plan.notes }
  })
}

/**
 * @param {object} [opts] every side effect injectable (suite.test.mjs).
 * @returns {{toolMissing: string|null, unparseable: boolean, collected: number, passed: number, failed: number, skipped: number, detail: string}}
 */
export function runCensusSuite({
  root = REPO_ROOT,
  projects = PROJECTS,
  docker = run,
  toolAvailableFn = toolAvailable,
  stubEnv = stubEnvFilesIfAbsent,
  sha,
  blastRadiusPath = BLAST_RADIUS_PATH,
  log = console.log,
} = {}) {
  if (!toolAvailableFn('docker')) {
    return { toolMissing: 'docker', unparseable: false, ...ZERO, detail: 'docker is not on PATH -- the census cannot render or inspect anything' }
  }
  // docker-compose.yml's legal service reads legal/legal.env as an env_file,
  // and a render refuses a missing one. The same gitignored stub typecheck
  // and carve-lint create; it feeds the container environment, never
  // interpolation, so it cannot change what the census reads.
  try {
    stubEnv(root)
  } catch (err) {
    return { toolMissing: null, unparseable: true, ...ZERO, detail: `could not stub legal/legal.env: ${err.message}` }
  }
  let blastRadius
  try {
    blastRadius = JSON.parse(readFileSync(blastRadiusPath, 'utf8'))
  } catch (err) {
    return { toolMissing: null, unparseable: true, ...ZERO, detail: `cannot read ${path.basename(blastRadiusPath)}: ${err.message}` }
  }
  const fullSha = sha ?? headSha(root)
  const sha7 = fullSha.slice(0, 7)
  const sha8 = fullSha.slice(0, 8)

  const rendered = renderAll({ root, projects, docker })
  if (rendered.some((p) => p.render.toolMissing)) {
    return { toolMissing: 'docker', unparseable: false, ...ZERO, detail: 'docker could not be started' }
  }

  const timings = []
  const { entries, errors } = planImages(rendered, { sha8 })
  const builds = buildImages(entries, { docker, buildSha: sha7, log: (l) => timings.push(l) })
  const inspectable = entries.filter((e) => e.kind === 'pull' || builds.get(e.ref)?.ok)
  const censusRefs = new Set(entries.filter((e) => e.kind === 'build').map((e) => e.ref))
  let inspected
  try {
    inspected = inspectHealthchecks(inspectable.map((e) => e.ref), { docker, pullable: (ref) => !censusRefs.has(ref), log: (l) => timings.push(l) })
  } finally {
    removeTags([...censusRefs].filter((ref) => builds.get(ref)?.ok), { docker })
  }

  const images = new Map()
  for (const e of errors) images.set(e.key, { ok: false, detail: e.detail })
  for (const e of entries) {
    const build = builds.get(e.ref)
    if (e.kind === 'build' && !build?.ok) images.set(e.key, { ok: false, detail: build?.detail ?? `${e.ref} was not built` })
    else images.set(e.key, inspected.get(e.ref) ?? { ok: false, detail: `${e.ref} was not inspected` })
  }

  const result = runCensus({ projects: rendered, images, blastRadius })
  const detail = [...result.lines, ...timings, ...result.problems.map((p) => `FAIL: ${p}`)].join('\n')
  log(`[census] ${result.lines.join('\n[census] ')}`)
  for (const t of timings) log(`[census] ${t}`)
  return {
    toolMissing: null,
    unparseable: result.unparseable,
    collected: result.collected,
    passed: result.passed,
    failed: result.failed,
    skipped: 0,
    detail,
  }
}
