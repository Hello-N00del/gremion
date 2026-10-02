// TASK-053 (L2-05; brief Q4): G-053-build-absence, RENDER half. A production
// render must PULL every first-party service by its released reference, never
// BUILD it on the host: a `build:` key that survives into the pinned render is
// a host that compiles whatever source it happens to hold.
//
//   first-party = image carries the first-party prefix, OR the service has a
//                 `build:` key (a build with no image is first-party too).
//   `build: null` / absent = no build (the release pins reset it with !reset null).
//
// The pins-TEXT half is TASK-046's check-pins.mjs `real-build`; the ledger
// records the split.
//
// Unpinned first-party builds the release fixture cannot pin yet (tenant-create
// in app; legal, vector, fallback in state; later adders) are each a DATED row
// of allowances.json naming TASK-048b. A row is itself asserted: it FAILS once
// its service renders without `build:` (retire the row) or is absent -- the
// census ALLOWANCES precedent (a self-retiring list, never a silent skip).
//
// Vacuity: an app render with fewer than 2 non-allowance first-party services
// judged proves nothing; a state render with 0 first-party services fails.
// This file is a leaf too (no import from the harness or check-pooled-stack).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { FIRST_PARTY_PREFIX } from './colour-suffix.mjs'

export const ALLOWANCES_PATH = path.join(import.meta.dirname, 'allowances.json')
export const MIN_JUDGED_APP = 2
/** project id -> allowance scope. */
export const scopeOf = (projectId) => (projectId.startsWith('app-') ? 'app' : projectId)

const hasBuild = (svc) => svc?.build !== undefined && svc?.build !== null

/** First-party services of one render: [{ name, build: boolean }]. */
export function firstPartyServices(render, prefix = FIRST_PARTY_PREFIX) {
  return Object.entries(render?.services ?? {})
    .filter(([, svc]) => hasBuild(svc) || String(svc?.image ?? '').startsWith(prefix))
    .map(([name, svc]) => ({ name, build: hasBuild(svc) }))
}

/** Reads and validates allowances.json; throws on a malformed row. */
export function loadAllowances(file = ALLOWANCES_PATH) {
  return validateAllowances(JSON.parse(readFileSync(file, 'utf8')))
}

export function validateAllowances(doc) {
  const rows = doc?.rows
  if (!Array.isArray(rows)) throw new Error('allowances.json: no "rows" array')
  for (const [i, r] of rows.entries()) {
    const where = `allowances.json rows[${i}]`
    if (!['app', 'state'].includes(r?.project)) throw new Error(`${where}: project must be "app" or "state"`)
    if (typeof r.service !== 'string' || !r.service) throw new Error(`${where}: no service`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.date ?? ''))) throw new Error(`${where} (${r.service}): date must be YYYY-MM-DD`)
    if (!/^TASK-\d+[a-z]?$/.test(String(r.retiresWith ?? ''))) throw new Error(`${where} (${r.service}): retiresWith must name a task`)
    if (typeof r.reason !== 'string' || r.reason.length < 10) throw new Error(`${where} (${r.service}): no reason`)
  }
  const keys = rows.map((r) => `${r.project}/${r.service}`)
  const dup = keys.find((k, i) => keys.indexOf(k) !== i)
  if (dup) throw new Error(`allowances.json: duplicate row ${dup}`)
  return rows
}

/**
 * Judges one render. Returns { problems, judged, allowance, firstParty }.
 * `projectId` is state, app-blue or app-green.
 */
export function buildAbsenceViolations(render, projectId, rows) {
  const scope = scopeOf(projectId)
  const allowed = new Map(rows.filter((r) => r.project === scope).map((r) => [r.service, r]))
  const fp = firstPartyServices(render)
  const problems = []
  let judged = 0
  let allowance = 0
  for (const { name, build } of fp) {
    if (allowed.has(name)) {
      allowance++
      if (!build) {
        const r = allowed.get(name)
        problems.push(`${projectId}/${name}: renders without build: but allowances.json still carries its ${r.date} row (retires with ${r.retiresWith}) -- delete the row`)
      }
      continue
    }
    judged++
    if (build) problems.push(`${projectId}/${name}: first-party service renders a build: key in the production render -- the host would build it instead of pulling the released reference`)
  }
  for (const [name, r] of allowed) {
    if (!fp.some((s) => s.name === name)) problems.push(`${projectId}/${name}: allowances.json row (${r.date}) names a service this render does not contain -- delete the row`)
  }
  if (scope === 'app' && judged < MIN_JUDGED_APP) {
    problems.push(`${projectId}: judged ${judged} non-allowance first-party service(s), fewer than ${MIN_JUDGED_APP} -- the build-absence guard would pass vacuously`)
  }
  if (scope !== 'app' && fp.length === 0) problems.push(`${projectId}: 0 first-party services rendered -- the build-absence guard would pass vacuously`)
  return { problems, judged, allowance, firstParty: fp.length }
}

/** One line per project for the suite's detail ("judged N, allowance M"). */
export function summaryLine(projectId, r) {
  return `${projectId}: judged ${r.judged}, allowance ${r.allowance} (first-party ${r.firstParty})`
}
