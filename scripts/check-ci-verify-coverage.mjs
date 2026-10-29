#!/usr/bin/env node
// Guard: .github/workflows/ci.yml runs every required verify suite exactly once,
// and its verify gate cannot be talked into passing a record it should not.
//
// ci.yml splits `make verify` into legs (`node scripts/verify/verify.mjs --only
// <list>`), each uploading its partial record as `record-<leg>`; the verify-gate
// job combines the records and judges them with scripts/verify/check-record.mjs.
// That shape fails SILENTLY in four ways, and this guard is the thing that makes
// each of them red on the pull request that introduces it:
//
//   1. A required suite no leg runs. The combined record then lacks it and the
//      gate fails -- but only on a push to main, after the merge, because a pull
//      request that adds a UNIT_PARTS key never ran the new part in the first
//      place. `unit` and `integration` are covered iff EVERY key of UNIT_PARTS /
//      INTEGRATION_PARTS appears as `unit:<part>` / `integration:<part>` (or the
//      whole suite is named), because that is what combine-records.mjs needs to
//      synthesize them.
//   2. A suite two legs both run. Two records then carry the same key and
//      combine-records.mjs refuses to merge them -- again only at the gate.
//   3. A leg whose record the gate does not wait for. Its failure would be
//      invisible: the gate would combine whatever records had arrived.
//   4. A way past the strict check. `--allow-missing` exists for one case (a pull
//      request that touched no census input skips that leg) and must never be
//      reachable from a push; `continue-on-error` turns any red job into a green
//      one; and the strict check-record call must stay the plain, flagless one
//      sign-release.sh also relies on.
//
// A scan that found almost nothing would pass every rule above, so it refuses to
// pass below a floor of verify invocations (the vacuity floor).
//
// Run:  node scripts/check-ci-verify-coverage.mjs [--ci <path to ci.yml>]
// Test: node --test scripts/check-ci-verify-coverage.test.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const CI_YML = join(ROOT, '.github', 'workflows', 'ci.yml')

/** Fewer verify invocations than this and the scan is not looking at the legs. */
export const MIN_VERIFY_INVOCATIONS = 6

// `yaml` is a root dependency, present only after `pnpm install`. Imported
// dynamically so a missing one is a reported, fail-closed FAIL naming the cause
// (the idiom scripts/ci-local/runner-policy.mjs uses), never an
// ERR_MODULE_NOT_FOUND crash and never a vacuous pass.
let parseYaml
let yamlLoadError
try {
  ;({ parse: parseYaml } = await import('yaml'))
} catch (err) {
  yamlLoadError = err
}

/** Why workflows cannot be parsed in this process, or undefined when `yaml` loaded. */
export function yamlUnavailableReason() {
  if (!yamlLoadError) return undefined
  const first = String(yamlLoadError.message ?? yamlLoadError).split('\n')[0]
  return `the 'yaml' package could not be imported (${first}) -- run \`pnpm install --frozen-lockfile\` at the kernel root first; failing closed`
}

const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])
const text = (v) => (typeof v === 'string' ? v : '')
const VERIFY_ONLY = /--only(?:=|\s+)([^\s"';|&]+)/g
const PULL_REQUEST_ONLY = /github\.event_name\s*==\s*'pull_request'/
const NOT_PULL_REQUEST = /github\.event_name\s*!=\s*'pull_request'/

/** Every step of every job, with where it lives. */
function* eachStep(doc) {
  for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
    for (const [index, step] of asList(job?.steps).entries()) {
      if (step && typeof step === 'object') yield { jobId, job, index, step, label: `${jobId} step ${index + 1}${step.name ? ` (${step.name})` : ''}` }
    }
  }
}

/**
 * The verify invocations in the workflow: one entry per `verify.mjs ... --only
 * <list>` occurrence in a step's `run`.
 * @returns {Array<{jobId: string, label: string, names: string[]}>}
 */
export function verifyInvocations(doc) {
  const out = []
  for (const { jobId, step, label } of eachStep(doc)) {
    const run = text(step.run)
    if (!run.includes('scripts/verify/verify.mjs')) continue
    for (const m of run.matchAll(VERIFY_ONLY)) {
      out.push({ jobId, label, names: m[1].split(',').map((n) => n.trim()).filter(Boolean) })
    }
  }
  return out
}

/** Jobs that upload an artifact named `record-*`. */
export function recordUploaders(doc) {
  const jobs = new Set()
  for (const { jobId, step } of eachStep(doc)) {
    if (text(step.uses).startsWith('actions/upload-artifact@') && text(step.with?.name).startsWith('record-')) jobs.add(jobId)
  }
  return jobs
}

/**
 * @param {unknown} doc the parsed workflow
 * @param {{requiredSuites: string[], unitParts: string[], integrationParts: string[]}} registry
 * @returns {{problems: string[], invocations: number, names: string[]}}
 */
export function checkWorkflow(doc, { requiredSuites, unitParts, integrationParts }) {
  const problems = []
  if (!doc || typeof doc !== 'object' || !doc.jobs || typeof doc.jobs !== 'object') {
    return { problems: ['the workflow has no `jobs` mapping'], invocations: 0, names: [] }
  }
  const invocations = verifyInvocations(doc)
  if (invocations.length < MIN_VERIFY_INVOCATIONS) {
    problems.push(
      `found ${invocations.length} verify invocation(s), fewer than the floor of ${MIN_VERIFY_INVOCATIONS} -- this scan is not looking at the legs`,
    )
  }

  // ── coverage and exclusivity ────────────────────────────────────────────
  const known = new Set([...requiredSuites, ...unitParts.map((p) => `unit:${p}`), ...integrationParts.map((p) => `integration:${p}`)])
  const seen = new Map() // name -> [where]
  for (const inv of invocations) {
    for (const name of inv.names) {
      if (!known.has(name)) {
        problems.push(`${inv.label}: --only names "${name}", which is neither a required suite nor a unit:/integration: part (verify would report it as dropped from the registry)`)
      }
      seen.set(name, [...(seen.get(name) ?? []), inv.jobId])
    }
  }
  for (const [name, where] of seen) {
    if (where.length > 1) problems.push(`"${name}" is run ${where.length} times (${where.join(', ')}) -- combine-records.mjs refuses a suite key present in two records`)
  }
  for (const [whole, parts] of [['unit', unitParts], ['integration', integrationParts]]) {
    if (seen.has(whole)) {
      const overlapping = parts.filter((p) => seen.has(`${whole}:${p}`))
      if (overlapping.length > 0) {
        problems.push(`"${whole}" is run whole AND as part(s) ${overlapping.map((p) => `${whole}:${p}`).join(', ')} -- combine-records.mjs rejects the ambiguous pair`)
      }
    }
  }
  for (const suite of requiredSuites) {
    if (suite === 'unit' || suite === 'integration') {
      if (seen.has(suite)) continue
      const parts = suite === 'unit' ? unitParts : integrationParts
      const missing = parts.filter((p) => !seen.has(`${suite}:${p}`))
      if (missing.length > 0) problems.push(`required suite "${suite}" is not covered: no leg runs ${missing.map((p) => `${suite}:${p}`).join(', ')}`)
    } else if (!seen.has(suite)) {
      problems.push(`required suite "${suite}" is run by no leg`)
    }
  }

  // ── every leg's record is awaited, and every leg has one ────────────────
  const gate = doc.jobs['verify-gate']
  if (!gate) {
    problems.push('there is no verify-gate job to combine and judge the legs\' records')
  }
  const needed = new Set(asList(gate?.needs))
  const uploaders = recordUploaders(doc)
  for (const jobId of uploaders) {
    if (!needed.has(jobId)) problems.push(`${jobId} uploads a record-* artifact but verify-gate does not need it -- its failure would not reach the verdict`)
  }
  for (const jobId of new Set(invocations.map((i) => i.jobId))) {
    if (!uploaders.has(jobId)) problems.push(`${jobId} runs verify but uploads no record-* artifact -- its result never reaches the gate`)
  }

  // ── nothing may soften the verdict ──────────────────────────────────────
  for (const [jobId, job] of Object.entries(doc.jobs)) {
    const soft = (v) => v !== undefined && v !== false && String(v).trim().toLowerCase() !== 'false'
    if (soft(job?.['continue-on-error'])) problems.push(`${jobId} sets continue-on-error -- a red job would read as green`)
  }
  for (const { label, step } of eachStep(doc)) {
    if (step['continue-on-error'] !== undefined && step['continue-on-error'] !== false && String(step['continue-on-error']).trim().toLowerCase() !== 'false') {
      problems.push(`${label} sets continue-on-error -- a red step would read as green`)
    }
  }

  // ── --allow-missing only on the pull-request path; the strict call is flagless ──
  let strictCalls = 0
  for (const { label, jobId, step } of eachStep(doc)) {
    const run = text(step.run)
    if (run.includes('--allow-missing') && !PULL_REQUEST_ONLY.test(text(step.if))) {
      problems.push(`${label}: --allow-missing appears in a step whose \`if\` does not require github.event_name == 'pull_request'`)
    }
    for (const line of run.split('\n')) {
      if (/^\s*#/.test(line)) continue
      const call = /check-record\.mjs\b(.*)$/.exec(line)
      if (!call) continue
      const flags = [...call[1].matchAll(/(?:^|\s)(--[A-Za-z][\w-]*)/g)].map((m) => m[1])
      const stray = flags.filter((f) => f !== '--allow-missing')
      if (stray.length > 0) problems.push(`${label}: check-record.mjs is called with ${stray.join(', ')}; it takes only a sha and --allow-missing`)
      if (flags.length === 0) {
        strictCalls += 1
        const cond = text(step.if)
        if (jobId !== 'verify-gate') problems.push(`${label}: the strict check-record.mjs call must be in the verify-gate job`)
        if (cond && !NOT_PULL_REQUEST.test(cond)) {
          problems.push(`${label}: the strict check-record.mjs call has an \`if\` that does not run it on pushes and manual runs`)
        }
        if (/allow-missing/i.test(cond)) problems.push(`${label}: the strict check-record.mjs call is conditioned on --allow-missing`)
      } else if (!PULL_REQUEST_ONLY.test(text(step.if))) {
        problems.push(`${label}: a flagged check-record.mjs call must be pull-request-only`)
      }
    }
  }
  if (strictCalls === 0) problems.push('no step calls `check-record.mjs <sha>` without a flag -- the strict check is gone')

  return { problems, invocations: invocations.length, names: [...seen.keys()] }
}

/** The registry the legs are checked against, read from the code that owns it. */
export async function loadRegistry() {
  const { loadRequiredSuites } = await import('./verify/verify.mjs')
  const { UNIT_PARTS } = await import('./verify/suites/unit.mjs')
  const { INTEGRATION_PARTS } = await import('./verify/suites/integration.mjs')
  return { requiredSuites: loadRequiredSuites(), unitParts: Object.keys(UNIT_PARTS), integrationParts: Object.keys(INTEGRATION_PARTS) }
}

/** The parsed workflow; throws when `yaml` is unavailable or the text does not parse. */
export function parseWorkflow(ciText) {
  const missing = yamlUnavailableReason()
  if (missing) throw new Error(missing)
  try {
    return parseYaml(ciText)
  } catch (err) {
    throw new Error(`ci.yml does not parse: ${String(err.message).split('\n')[0]}`)
  }
}

/** Parse + check one workflow text. */
export function checkCiText(ciText, registry) {
  let doc
  try {
    doc = parseWorkflow(ciText)
  } catch (err) {
    return { problems: [err.message], invocations: 0, names: [] }
  }
  return checkWorkflow(doc, registry)
}

function parseArgs(argv) {
  const out = { ci: CI_YML }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ci' && argv[i + 1]) out.ci = argv[++i]
    else throw new Error(`unknown argument: ${argv[i]} (usage: check-ci-verify-coverage.mjs [--ci <ci.yml>])`)
  }
  return out
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[ci-verify-coverage] ${err.message}`)
    process.exitCode = 1
    return
  }
  const result = checkCiText(readFileSync(args.ci, 'utf8'), await loadRegistry())
  if (result.problems.length > 0) {
    console.error('[ci-verify-coverage] FAIL')
    for (const p of result.problems) console.error(`  - ${p}`)
    process.exitCode = 1
    return
  }
  console.log(`[ci-verify-coverage] OK -- ${result.invocations} verify invocation(s) run ${result.names.length} suite/part name(s), each once, covering every required suite`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
