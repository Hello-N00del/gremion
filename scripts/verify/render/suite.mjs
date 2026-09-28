// TASK-053 (L2-05; TRD-440 render side, TRD-444/343 gate contract): the
// `render-guards` verify suite. Renders the pooled stack ONCE through the
// harness (TASK-040's PROJECTS/renderProject, release pins for app only) and
// judges it with:
//
//   G-053-harness        every project rendered, >= 1 service, swap post-conditions
//   G-053-drift          fixture COMPOSE_FILE/COMPOSE_PROFILES == host template
//   G-053-colour-suffix  no app-tier value names a first-party host without -<colour>
//   G-053-build-absence  no first-party build: in the production render (allowances dated)
//
// SYNCHRONOUS on purpose: verify.mjs's runAll() calls `runner()` without
// `await`. `docker` is probed through lib/proc.mjs first; the renders
// themselves spawn docker inside TASK-040's renderState (compose-edge.mjs), so
// the "only via lib/proc.mjs" rule covers this file's own spawns.
//
// Result mapping onto TASK-045's suite shape:
//   docker absent / cannot be run   -> toolMissing: 'docker' (never a skip)
//   0 projects, a thrown render, a failed harness post-condition, an
//   unreadable allowances.json      -> unparseable, naming the project
//   collected = one per (guard, project); failed = checks with a problem.
import { PROJECTS, renderProject } from '../../check-pooled-stack.mjs'
import { toolAvailable } from '../lib/proc.mjs'
import { buildAbsenceViolations, loadAllowances, scopeOf, summaryLine } from './build-absence.mjs'
import { colourSuffixGuard } from './colour-suffix.mjs'
import { driftChecks } from './drift.mjs'
import { HarnessError, renderAll } from './harness.mjs'

/** Every guard id TASK-053 exports; red-ledger.md carries one section each. */
export const GUARD_IDS = [
  'G-053-harness',
  'G-053-drift',
  'G-053-colour-suffix',
  'G-053-build-absence',
  'G-053-boundary-lint-vacuity',
  'G-053-wiring',
  'G-053-ledger',
]

const ZERO = { collected: 0, passed: 0, failed: 0, skipped: 0 }

/** Pure: the per-(guard, project) checks over one harness result. */
export function judgeRenders({ projects, renders, counts, allowances, templateText, driftFn = driftChecks }) {
  const checks = []
  for (const p of projects) checks.push({ guard: 'harness', id: p.id, problems: [], note: `${p.id}: ${counts[p.id]} service(s)` })
  for (const c of driftFn(projects)) checks.push({ guard: 'drift', id: c.id, problems: c.problems })

  const appRenders = Object.fromEntries(projects.filter((p) => p.colour).map((p) => [p.colour, renders[p.id]]))
  const missingColours = ['blue', 'green'].filter((c) => !appRenders[c])
  if (missingColours.length) {
    checks.push({ guard: 'colour-suffix', id: 'app', problems: [`colour-suffix: no app render for ${missingColours.join(', ')} -- both colours are judged`] })
  }
  const colour = colourSuffixGuard({ appRenders, templateText })
  for (const c of colour.checks) checks.push({ guard: 'colour-suffix', id: c.id, problems: c.problems })

  const judgedByBuild = projects.filter((p) => p.colour || p.id === 'state')
  if (!judgedByBuild.some((p) => scopeOf(p.id) === 'app') || !judgedByBuild.some((p) => p.id === 'state')) {
    checks.push({ guard: 'build-absence', id: 'projects', problems: ['build-absence: needs the state render and at least one app render'] })
  }
  for (const p of judgedByBuild) {
    const r = buildAbsenceViolations(renders[p.id], p.id, allowances)
    checks.push({ guard: 'build-absence', id: p.id, problems: r.problems, note: summaryLine(p.id, r) })
  }
  return { checks, names: colour.names }
}

/**
 * @param {object} [opts] every side effect injectable (suite.test.mjs).
 * @returns {{toolMissing: string|null, unparseable: boolean, collected: number, passed: number, failed: number, skipped: number, detail: string}}
 */
export function runRenderGuardsSuite({
  projects = PROJECTS,
  render = renderProject,
  toolAvailableFn = toolAvailable,
  loadAllowancesFn = loadAllowances,
  templateText,
  driftFn,
  readEnv,
  log = console.log,
} = {}) {
  if (!toolAvailableFn('docker')) {
    return { toolMissing: 'docker', unparseable: false, ...ZERO, detail: 'docker is not on PATH -- the production renders cannot be taken' }
  }
  let allowances
  try {
    allowances = loadAllowancesFn()
  } catch (err) {
    return { toolMissing: null, unparseable: true, ...ZERO, detail: `render/allowances.json: ${err.message}` }
  }
  let harness
  try {
    harness = renderAll({ projects, render, ...(readEnv ? { readEnv } : {}) })
  } catch (err) {
    if (err instanceof HarnessError && err.kind === 'toolMissing') {
      return { toolMissing: 'docker', unparseable: false, ...ZERO, detail: err.message }
    }
    return { toolMissing: null, unparseable: true, ...ZERO, detail: `render harness: ${err.message}` }
  }
  const { checks, names } = judgeRenders({ projects, ...harness, allowances, templateText, ...(driftFn ? { driftFn } : {}) })
  const failed = checks.filter((c) => c.problems.length > 0)
  const lines = [
    `derived app-tier names (${names.length}): ${names.join(', ')}`,
    ...checks.filter((c) => c.note).map((c) => `${c.guard} ${c.note}`),
    ...failed.flatMap((c) => c.problems.map((p) => `FAIL ${c.guard}: ${p}`)),
  ]
  log(`[render-guards] ${lines.join('\n[render-guards] ')}`)
  return {
    toolMissing: null,
    unparseable: false,
    collected: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
    skipped: 0,
    detail: lines.join('\n'),
  }
}
