// The render arm of check-image-digests (TASK-048b): TRD-350 proved on the
// RENDERED release, and the state/app layering (TRD-038, TRD-440) with it.
//
// TODO(TASK-053): replaceable by TASK-053's shared render harness.
//
// TASK-048 Q1: the deployment manifest is compose + the pins layers. This arm
// renders every production project from its own env template exactly as the
// host composes it, with the EMITTED release fixture pins
// (test/host/fixtures/release/valid, emit-pins output) in each pins slot, and
// judges what docker renders, not what a grep of the sources finds:
//   - every rendered service's image is <repo>[:tag]@sha256:<64 hex>;
//   - no service keeps `build` (the pins reset it on every first-party
//     service), and a rendered `build` on a service outside check-pins'
//     derived set is its own finding: docker's render cross-checks the line
//     parser (Q1);
//   - every derived `build:` service appears in its project's render(s), so a
//     profile left off cannot hide one (COMPOSE_PROFILES='*');
//   - the state render passes check-pooled-stack's STATE PURITY: no app
//     service is layered onto the state project; and no colour render
//     carries a derived state service (app purity, the reverse merge).
//
// Templates are DISCOVERED (infra/host/templates/env/*.env.tmpl) and must each
// be mapped in TEMPLATE_MAP; an unmapped template fails. Each render passes an
// explicit -f per COMPOSE_FILE entry (a bare `config` would merge the dev
// override), --project-directory, and --env-file
// scripts/release/fixtures/render/render.env (brief Q4), with the census's
// allow-listed child environment plus COMPOSE_PROFILES='*' (and COLOUR for a
// colour). Zero renders, a render with zero services, a failed render and a
// missing docker are failures, never skips.
//
// Imports from the census exactly three symbols: readEnvKey, childEnv,
// REPO_ROOT.

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

import { readEnvKey, childEnv, REPO_ROOT } from '../../verify/census/render.mjs'
import { derivedServices, isPinsSlot } from '../check-pins.mjs'
import { statePurityViolations } from '../../check-pooled-stack.mjs'

export const TEMPLATE_DIR = 'infra/host/templates/env'
export const PINS_FIXTURE_DIR = 'test/host/fixtures/release/valid'
export const RENDER_ENV = 'scripts/release/fixtures/render/render.env'

/**
 * template project -> the directory COMPOSE_FILE is relative to, its renders,
 * and the git-ignored files compose needs to exist (`seed`, created EMPTY
 * and exclusively when absent, never overwritten: the state project's legal
 * service names legal/legal.env as an env_file, and a fresh checkout has
 * none -- the file ci.yml's `touch legal/legal.env` and compose-edge.mjs's
 * renderState leave).
 */
export const TEMPLATE_MAP = Object.freeze({
  state: { dir: '.', renders: [{ id: 'state' }], seed: ['legal/legal.env'] },
  app: { dir: '.', renders: [{ id: 'app-blue', colour: 'blue' }, { id: 'app-green', colour: 'green' }] },
  ops: { dir: 'infra/host/ops', renders: [{ id: 'ops' }] },
  mail: { dir: 'infra/host/mail', renders: [{ id: 'mail' }] },
})

const PINNED_RE = /^[a-z0-9][a-z0-9._/:-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[0-9a-f]{64}$/

const listTemplateDir = (root) => readdirSync(join(root, TEMPLATE_DIR)).filter((f) => f.endsWith('.env.tmpl'))

/**
 * One plan per render: {id, project, dir, files, argv, env}. `pinsOverride`
 * maps a pins-slot basename to another file (the tag-pinned RED reference).
 */
export function planRenders({
  root = REPO_ROOT,
  listTemplates = () => listTemplateDir(root),
  readText = (p) => readFileSync(p, 'utf8'),
  pinsOverride = {},
  parentEnv = process.env,
} = {}) {
  const plans = []
  const problems = []
  const add = (code, where, message) => problems.push({ code, where, message })
  let stack = ''
  try {
    stack = readEnvKey(readText(join(root, RENDER_ENV)), 'STACK') ?? ''
  } catch (err) {
    add('no-render-env', RENDER_ENV, err.message)
  }
  for (const t of [...listTemplates()].sort()) {
    const where = `${TEMPLATE_DIR}/${t}`
    const project = t.replace(/\.env\.tmpl$/, '')
    const map = TEMPLATE_MAP[project]
    if (!map) {
      add('unmapped-template', where, `no render mapping for project ${project} (TEMPLATE_MAP in scripts/release/lib/render.mjs)`)
      continue
    }
    let composeFile, projectName
    try {
      const text = readText(join(root, where))
      composeFile = readEnvKey(text, 'COMPOSE_FILE')
      projectName = readEnvKey(text, 'COMPOSE_PROJECT_NAME')
    } catch (err) {
      add('no-compose-file', where, err.message)
      continue
    }
    if (!composeFile) {
      add('no-compose-file', where, 'declares no COMPOSE_FILE')
      continue
    }
    if (!projectName) {
      add('no-project-name', where, 'declares no COMPOSE_PROJECT_NAME (a render named after the directory would read as global gremion_* names)')
      continue
    }
    const dir = join(root, map.dir)
    const files = []
    let ok = true
    for (const entry of composeFile.split(':').map((e) => e.trim()).filter(Boolean)) {
      if (!isPinsSlot(entry)) {
        files.push(join(dir, entry))
        continue
      }
      const slot = basename(entry)
      const fixture = pinsOverride[slot] ?? join(root, PINS_FIXTURE_DIR, slot)
      if (!existsSync(fixture)) {
        add('no-pins-fixture', where, `pins slot ${entry} has no emitted fixture ${fixture}`)
        ok = false
        continue
      }
      files.push(fixture)
    }
    if (!ok) continue
    for (const r of map.renders) {
      const env = { ...childEnv(parentEnv), COMPOSE_PROFILES: '*', ...(r.colour ? { COLOUR: r.colour } : {}) }
      // The template's project name, as the host sets it: ${STACK} from the
      // render env, ${COLOUR} per colour. Anything left unexpanded fails.
      const name = projectName.replace(/\$\{STACK\}/g, stack).replace(/\$\{COLOUR\}/g, r.colour ?? '')
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
        add('no-project-name', where, `COMPOSE_PROJECT_NAME ${projectName} does not expand to a project name (got ${name})`)
        continue
      }
      const argv = ['compose', '--env-file', join(root, RENDER_ENV), '--project-directory', dir, '--project-name', name, ...files.flatMap((f) => ['-f', f]), 'config', '--format', 'json']
      plans.push({ id: r.id, project, dir, files, argv, env, seed: [...(map.seed ?? [])] })
    }
  }
  return { plans, problems }
}

/** Run one plan with the docker CLI: {ok, doc} or {ok: false, detail[, toolMissing]}. */
export function dockerRender(plan, { spawn = spawnSync } = {}) {
  for (const rel of plan.seed ?? []) {
    const f = join(plan.dir, rel)
    try {
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, '', { flag: 'wx' })
    } catch (err) {
      if (err.code !== 'EEXIST') return { ok: false, detail: `cannot seed ${rel}: ${err.message}` }
    }
  }
  const res = spawn('docker', plan.argv, { cwd: plan.dir, env: plan.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 })
  if (res.error?.code === 'ENOENT') return { ok: false, toolMissing: 'docker', detail: 'docker not found' }
  if (res.error) return { ok: false, detail: `docker could not run: ${res.error.message}` }
  if (res.status !== 0) return { ok: false, detail: `docker compose config exited ${res.status ?? res.signal}: ${String(res.stderr || res.stdout).trim().slice(-400)}` }
  let doc
  try {
    doc = JSON.parse(res.stdout)
  } catch {
    return { ok: false, detail: `docker compose config printed no JSON document: ${String(res.stdout).slice(0, 200)}` }
  }
  return { ok: true, doc }
}

/** Judge the rendered documents. `results` = [{plan, res}]; `derived` = {state:[…], app:[…]}. */
export function judgeRenders(results, derived) {
  const problems = []
  const add = (code, where, message) => problems.push({ code, where, message })
  const allDerived = new Set(Object.values(derived).flat())
  if (!results.length) add('no-renders', 'render', 'no project was rendered -- refusing to pass vacuously')
  for (const { plan, res } of results) {
    if (!res.ok) {
      add('render-failed', plan.id, res.detail)
      continue
    }
    const svcs = res.doc?.services
    if (!svcs || typeof svcs !== 'object' || Array.isArray(svcs) || !Object.keys(svcs).length) {
      add('no-services', plan.id, 'the render has no services')
      continue
    }
    for (const [name, svc] of Object.entries(svcs)) {
      const image = String(svc?.image ?? '')
      if (!PINNED_RE.test(image)) add('unpinned', `${plan.id}/${name}`, `image is not <repo>[:tag]@sha256:<64 hex>: ${image || '(none)'}`)
      if (svc?.build !== undefined && svc?.build !== null) {
        if (allDerived.has(name)) add('build-kept', `${plan.id}/${name}`, 'a first-party service keeps build in the rendered release (the pins layer must reset it)')
        else add('underived-build', `${plan.id}/${name}`, 'renders a build that check-pins does not derive (the derivation missed it)')
      }
    }
    for (const s of derived[plan.project] ?? []) {
      if (!svcs[s]) add('derived-absent', `${plan.id}/${s}`, `derived build: service ${s} is absent from the render (profiles not all on?)`)
    }
    if (plan.id === 'state') {
      for (const v of statePurityViolations(res.doc, 'state')) add('state-purity', 'state', v)
    }
    // ...and the reverse: a colour carrying a state service (the state layer
    // merged into the app pins) would run a second copy of it per colour.
    if (plan.project === 'app') {
      for (const s of derived.state ?? []) if (svcs[s]) add('app-purity', `${plan.id}/${s}`, `the app render carries the state service ${s} (it lives only in the state project)`)
    }
  }
  return problems
}

/** Plan, render, judge. Returns {problems, renders, services}. */
export function renderArm({ render = dockerRender, derive = derivedServices, ...planOpts } = {}) {
  const { plans, problems } = planRenders(planOpts)
  let derived
  try {
    derived = { state: derive('state'), app: derive('app') }
  } catch (err) {
    return { problems: [...problems, { code: 'derive', where: 'check-pins', message: err.message }], renders: 0, services: 0 }
  }
  const results = plans.map((plan) => ({ plan, res: render(plan) }))
  problems.push(...judgeRenders(results, derived))
  const services = results.reduce((n, { res }) => n + (res.ok ? Object.keys(res.doc?.services ?? {}).length : 0), 0)
  return { problems, renders: results.filter(({ res }) => res.ok).length, services }
}
