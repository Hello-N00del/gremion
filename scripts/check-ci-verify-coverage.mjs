#!/usr/bin/env node
// Guard: .github/workflows/ci.yml runs every required verify suite exactly once,
// and its verify gate cannot be talked into passing a record it should not.
//
// ci.yml splits `make verify` into legs (`node scripts/verify/verify.mjs --only
// <list>`), each uploading its partial record as `record-<leg>`; the verify-gate
// job combines the records and judges them with scripts/verify/check-record.mjs.
// That shape fails SILENTLY in five ways, and this guard is the thing that makes
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
//      invisible: the gate would combine whatever records had arrived. The image
//      builds carry no record, so the gate must need docker-build by name, or a
//      Dockerfile that no longer builds would leave a green gate.
//   4. A way past the strict check. `--allow-missing` exists for one case (a pull
//      request that touched no census input skips that leg) and must never be
//      reachable from a push; `continue-on-error` turns any red job into a green
//      one; `|| true` / `|| :` / `set +e` (any spelling), a `||` after a verdict
//      command, a verdict command used as an `if` / `!` condition, and a `shell:`
//      without -e (`bash {0}`) in a leg or the gate swallow a red exit status the
//      same way; the strict check-record call must stay the plain, flagless one
//      sign-release.sh also relies on; and the `if` of the gate job, of the step
//      that checks every leg's result and of the strict call are pinned, because a
//      narrowed one makes the gate SKIP, and a skipped required check reads as
//      passing in a branch ruleset. The first two are pinned to always(): a failed
//      leg cancels a pull-request run (fail fast), and the gate must still run
//      then; and the gate must end with a `cancelled()` step that exits 1, since
//      in a cancelled run every other step is skipped.
//   5. A fail-fast cancel that reaches too far. Only a fail-fast job of the pinned
//      shape may cancel (one per leg, same-repo pull requests only, `actions:
//      write` and nothing else, one step, no `uses:`), so a push always carries
//      every leg's record and the write token never shares a runner with
//      repository or dependency code; no leg and not the gate holds a write token.
//
//   6. Runner hygiene, which fails loudly but on the wrong commit. Every job has a
//      timeout-minutes; every checkout sets persist-credentials: false; every GitHub
//      release download retries; pip and global npm tools are pinned to one exact
//      version; and no step repeats make fresh-init-proof, which a verify leg owns.
//
// A scan that found almost nothing would pass every rule above, so it refuses to
// pass below a floor of verify invocations (the vacuity floor).
//
// SCOPE. This guard catches the ACCIDENTAL softening of the gate, in review, in the
// common forms enumerated above. It is not a sandbox against a maintainer who edits
// ci.yml and this guard together, and shell has unbounded ways to drop a status that
// no list of patterns closes. Review of .github/workflows/** remains the control.
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

// A shell line that swallows a failing exit status. Comment lines are skipped by the
// caller. `docker logs|rm ... || true` (a diagnostic or cleanup that must not mask the
// real failure) is the one tolerated shape, and only as a whole line of its own.
// `|| true` ends at a separator, at the `)` closing a `$( )` or at the backtick closing a
// backtick substitution; `set +e` is any option cluster that turns errexit off (`+ex`,
// `+euo pipefail`), not only a lone `e`.
const SWALLOWS_STATUS = /\|\|\s*(?:true|:|exit\s+0)\s*(?:$|[;&|)`#])|\bset\s+\+[a-z]*e[a-z]*\b|\bset\s+\+o\s+errexit\b/
const BENIGN_CLEANUP = /^\s*docker\s+(?:logs|rm)\b[^;&|]*\|\|\s*true\s*$/

// The commands whose exit status IS the verdict. Whatever follows one with `||` runs only
// when it failed (and usually turns that into success), and a condition (`if cmd`,
// `if ! cmd`, `! cmd`) is exempt from `set -e`, so none of these may touch them.
const VERDICT_CMD = String.raw`\b(?:verify|check-record|combine-records)\.mjs\b`
const VERDICT_THEN_OR = new RegExp(String.raw`${VERDICT_CMD}(?:[^;|\n]|\|(?!\|))*\|\|`)
const VERDICT_IN_CONDITION = new RegExp(String.raw`(?:^|[\s;&|({])(?:if|elif|while|until)\s+[^;\n]*?${VERDICT_CMD}`)
const VERDICT_NEGATED = new RegExp(String.raw`(?:^|[\s;&|({])!\s+[^;\n|\]]*?${VERDICT_CMD}`)

// A `shell:` keeps errexit when it is unset, bash or sh (GitHub runs both with -e), or a
// template that passes -e / -o errexit and does not turn it off again. `bash {0}` is the documented way to turn fail-fast OFF.
const ERREXIT_SHELL = /^(?:bash|sh)$|^(?:ba)?sh\s(?:.*\s)?-(?:[A-Za-z]*e[A-Za-z]*|o\s+errexit)\s(?:.*\s)?\{0\}$/
// ...and passes no `+<flags containing e>` / `+o errexit` after it: `bash -e +e {0}` carries a -e and runs without errexit.
const ERREXIT_OFF = /(?:^|\s)(?:\+[A-Za-z]*e[A-Za-z]*|\+o\s+errexit)(?=\s|$)/
const keepsErrexit = (shell) => shell === undefined || shell === null || (typeof shell === 'string' && ERREXIT_SHELL.test(shell.trim()) && !ERREXIT_OFF.test(shell))

// The only `if` the gate job and its strict check-record step may carry (after the
// `${{ }}` wrapper and whitespace are normalized away). Anything narrower can skip
// them; anything missing on the job skips it when a leg fails. Only always(): a failed
// leg cancels a pull-request run (the fail-fast step), and `!cancelled()` would then
// skip the gate.
const GATE_JOB_IFS = new Set(['always()'])
// The step that judges every leg's `result` (found by its `toJSON(needs)`, not by its name)
// must be always() too: in a cancelled run a step without it is skipped, and so is every
// step after it -- a gate whose steps all skipped finishes green.
const LEGS_STEP_IFS = new Set(['always()'])
// A run is cancelled (fail fast) only by a fail-fast job of exactly this shape: one per
// leg, `needs` that leg alone, this exact `if` (pull requests from this repository only:
// a push or a manual run keeps every leg's record, which check-record and sign-release
// need; a fork's token cannot cancel), `permissions: {actions: write}` and nothing else,
// one step that is the cancel and no `uses:` -- the write token never shares a runner
// with repository or dependency code. Every spelling of the cancel counts: `gh run
// cancel`, and the REST endpoint (`.../actions/runs/<id>/cancel` or `force-cancel`).
const CANCELS_RUN = /\bgh\s+run\s+cancel\b|\/actions\/runs\/\S*\/(?:force-)?cancel\b/
const FAIL_FAST_JOB_IF = "failure() && github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository"
// The gate's last word on a cancelled run: every step without always() is skipped there.
const CANCELLED_STEP_IF = 'cancelled()'
const STRICT_STEP_IF = "github.event_name != 'pull_request' || needs.verify-census.result == 'success'"
// The only jobs the gate may accept as skipped, and only on a pull request: each one is
// skipped there when the diff touches none of its inputs. A push always runs both.
const MAY_SKIP_ON_PR = new Set(['verify-census', 'docker-build'])
const normalizeIf = (v) => text(v === undefined || v === null ? '' : String(v)).replace(/^\s*\$\{\{|\}\}\s*$/g, '').replace(/\s+/g, ' ').trim()

/** The logical lines of a `run` script: backslash continuations joined, comments dropped. */
function logicalLines(run) {
  const out = []
  let acc = ''
  for (const raw of text(run).split('\n')) {
    const line = acc + raw
    if (/\\\s*$/.test(line)) {
      acc = line.replace(/\\\s*$/, ' ')
      continue
    }
    acc = ''
    if (!/^\s*#/.test(line)) out.push(line)
  }
  if (acc && !/^\s*#/.test(acc)) out.push(acc)
  return out
}

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

// A GitHub release download. The 2026-11-08 run lost five jobs to one 504 from this CDN.
const RELEASE_DOWNLOAD = /\bcurl\b.*https:\/\/github\.com\/\S+\/releases\/download\//
const PIP_INSTALL = /\bpip3?\s+install\s+([^;&|]+)/
const NPM_GLOBAL_INSTALL = /\bnpm\s+(?:install|i)\s+(?:-g|--global)\s+([^;&|]+)/
const PIP_PIN = /^([A-Za-z0-9._-]+)==(\d+(?:\.\d+)+)$/
const NPM_PIN = /^((?:@[^/@\s]+\/)?[^/@\s]+)@(\d+(?:\.\d+)+)$/

function checkPins(label, kind, line, pattern, pin, versions, problems) {
  const m = pattern.exec(line)
  if (!m) return
  for (const spec of m[1].trim().split(/\s+/).filter((t) => !t.startsWith('-'))) {
    const pinned = pin.exec(spec)
    if (!pinned) {
      problems.push(`${label}: ${kind} package ${spec} is not pinned to an exact version -- an upstream release would break every run at once`)
      continue
    }
    versions.set(pinned[1], new Set([...(versions.get(pinned[1]) ?? []), pinned[2]]))
  }
}

/** Rule 6 of the header: credentials, downloads, tool versions, runaway jobs and the duplicate proof. */
function checkRunnerHygiene(doc, problems) {
  const versions = new Map() // tool -> distinct pinned versions
  let downloads = 0
  for (const [jobId, job] of Object.entries(doc.jobs)) {
    const timeout = job?.['timeout-minutes']
    if (!Number.isInteger(timeout) || timeout < 1) {
      problems.push(`${jobId} has no timeout-minutes -- a hung step would hold a runner for GitHub's six-hour default`)
    }
  }
  for (const { label, step } of eachStep(doc)) {
    if (text(step.uses).startsWith('actions/checkout@') && step.with?.['persist-credentials'] !== false) {
      problems.push(`${label}: actions/checkout does not set persist-credentials: false -- the job token stays in .git/config while later steps run`)
    }
    for (const line of logicalLines(step.run)) {
      if (RELEASE_DOWNLOAD.test(line)) {
        downloads += 1
        if (!/(?:^|\s)--retry\s+[1-9]\d*(?:\s|$)/.test(line) || !/(?:^|\s)--retry-all-errors(?:\s|$)/.test(line)) {
          problems.push(`${label}: a GitHub release download has no retry (--retry <n> --retry-all-errors) -- one CDN error fails the job before verify starts`)
        }
      }
      checkPins(label, 'pip', line, PIP_INSTALL, PIP_PIN, versions, problems)
      checkPins(label, 'global npm', line, NPM_GLOBAL_INSTALL, NPM_PIN, versions, problems)
      if (/\bmake\s+fresh-init-proof\b/.test(line)) {
        problems.push(`${label}: runs make fresh-init-proof, which verify-integration-db already runs as integration:fresh-init and records for the gate`)
      }
    }
  }
  // Vacuity floor: a respelled install would otherwise leave these rules checking nothing.
  if (downloads === 0) problems.push('no GitHub release download found -- the retry rule is not looking at the install steps (respelled? update this guard with it)')
  for (const tool of ['yamllint', 'bats']) {
    if (!versions.has(tool)) problems.push(`no pinned install of ${tool} found -- the pin rule is not looking at its install steps (respelled? update this guard with it)`)
  }
  for (const [tool, seen] of versions) {
    if (seen.size > 1) problems.push(`${tool} is installed at ${seen.size} versions (${[...seen].join(', ')}) -- every job must run the same one`)
  }
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
  for (const { whole, parts } of [{ whole: 'unit', parts: unitParts }, { whole: 'integration', parts: integrationParts }]) {
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
  // The legs start without waiting for Lint (it runs the guards, this one included), so the
  // gate must wait for it itself or a red Lint would leave a green gate.
  // Fail closed on a renamed job: without `lint` the two lint rules below would check nothing.
  if (!doc.jobs.lint) {
    problems.push('there is no `lint` job -- the gate-needs-lint and fail-fast-lint checks cannot run (renamed? update this guard with it)')
  } else if (gate && !needed.has('lint')) {
    problems.push('verify-gate does not need lint -- the legs no longer wait for it, so a red Lint would not reach the verdict')
  }
  // Fail closed on a renamed job, as for lint.
  if (!doc.jobs['docker-build']) {
    problems.push('there is no `docker-build` job -- the gate-needs-the-image-builds check cannot run (renamed? update this guard with it)')
  } else if (gate && !needed.has('docker-build')) {
    problems.push('verify-gate does not need docker-build -- a Dockerfile that no longer builds would leave a green gate')
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

  // Jobs whose steps decide the verdict: every leg that produces a record, the gate, and
  // the image builds (no record, but the gate reads their result).
  const verdictJobs = new Set([...uploaders, ...invocations.map((i) => i.jobId), ...(gate ? ['verify-gate'] : []), ...(doc.jobs['docker-build'] ? ['docker-build'] : [])])
  for (const { label, jobId, step } of eachStep(doc)) {
    if (!verdictJobs.has(jobId)) continue
    for (const line of logicalLines(step.run)) {
      if (BENIGN_CLEANUP.test(line)) continue
      if (SWALLOWS_STATUS.test(line) || VERDICT_THEN_OR.test(line)) {
        problems.push(`${label}: \`${line.trim()}\` swallows a failing exit status -- a red step would read as green`)
      } else if (VERDICT_IN_CONDITION.test(line) || VERDICT_NEGATED.test(line)) {
        problems.push(`${label}: \`${line.trim()}\` tests a verdict command in a condition, where \`set -e\` does not apply -- a red step would read as green`)
      }
    }
    if (!keepsErrexit(step.shell)) problems.push(`${label}: \`shell: ${step.shell}\` drops -e (only bash, sh or a template with -e keeps it) -- a failing command would not fail the step`)
  }
  for (const jobId of verdictJobs) {
    const shell = doc.jobs[jobId]?.defaults?.run?.shell
    if (!keepsErrexit(shell)) problems.push(`${jobId} sets defaults.run.shell: ${shell}, which drops -e -- a failing command would not fail its steps`)
  }
  if (!keepsErrexit(doc.defaults?.run?.shell)) {
    problems.push(`the workflow sets defaults.run.shell: ${doc.defaults.run.shell}, which drops -e -- a failing command would not fail its steps`)
  }
  // The step that checks every leg's result is found by what it reads, so a rename cannot hide it.
  const legSteps = [...eachStep(doc)].filter(({ jobId, step }) => jobId === 'verify-gate' && /toJSON\(\s*needs\s*\)/.test(JSON.stringify([step.env, step.run])))
  if (gate && legSteps.length === 0) problems.push('verify-gate has no step that reads toJSON(needs) -- nothing checks that every leg succeeded')
  for (const { label, step } of legSteps) {
    if (!LEGS_STEP_IFS.has(normalizeIf(step.if))) {
      problems.push(`${label} has \`if: ${normalizeIf(step.if) || '(none)'}\`; the step that checks every leg's result must have \`if: always()\`, because anything else is skipped in a cancelled (fail-fast) run or narrows the check, and a gate whose steps skipped finishes green`)
    }
    // Any line that weighs a skip, however it is spelled. An echo only reports one.
    for (const line of logicalLines(step.run).filter((l) => /\bskipped\b/.test(l) && !/^\s*echo\b/.test(l))) {
      const job = /"\$job"\s*==?\s*"([^"]+)"/.exec(line)?.[1]
      if (!job || !MAY_SKIP_ON_PR.has(job) || !/"\$EVENT_NAME"\s*==?\s*"pull_request"/.test(line)) {
        problems.push(`${label}: \`${line.trim()}\` accepts a skipped job; only ${[...MAY_SKIP_ON_PR].join(' and ')} may be skipped, and only when "$EVENT_NAME" is "pull_request"`)
      }
    }
  }
  if (gate && !GATE_JOB_IFS.has(normalizeIf(gate.if))) {
    problems.push(`verify-gate has \`if: ${normalizeIf(gate.if) || '(none)'}\`; it must be \`always()\` so a failed, skipped or cancelled leg makes the gate run and fail instead of skipping it (a skipped required check reads as passing, and a failed leg cancels a pull-request run)`)
  }
  if (gate) {
    const cancelledSteps = asList(gate.steps).filter((st) => st && normalizeIf(st.if) === CANCELLED_STEP_IF && logicalLines(st.run).some((l) => /^\s*exit\s+1\s*$/.test(l)))
    if (cancelledSteps.length === 0) {
      problems.push(`verify-gate has no step with \`if: ${CANCELLED_STEP_IF}\` that exits 1 -- in a cancelled run every other step is skipped and the gate would finish green without judging a record`)
    }
  }

  // ── fail fast: only the pinned fail-fast jobs cancel, one per leg ──────────
  const failFastFor = new Map() // leg -> [fail-fast job ids]
  for (const [jobId, job] of Object.entries(doc.jobs)) {
    const steps = asList(job?.steps)
    if (!steps.some((st) => st && logicalLines(st.run).some((l) => CANCELS_RUN.test(l)))) continue
    const where = `${jobId}: cancels the run`
    const needs = asList(job.needs)
    if (needs.length !== 1 || !(uploaders.has(needs[0]) || needs[0] === 'lint')) {
      problems.push(`${where}, but its \`needs\` is not exactly one verify leg or lint (${needs.join(', ') || 'none'})`)
    } else {
      failFastFor.set(needs[0], [...(failFastFor.get(needs[0]) ?? []), jobId])
    }
    if (normalizeIf(job.if) !== FAIL_FAST_JOB_IF) {
      problems.push(`${where} with \`if: ${normalizeIf(job.if) || '(none)'}\`; it must be exactly \`${FAIL_FAST_JOB_IF}\` -- anything else can cancel a push run (losing its records) or a passing run`)
    }
    const perms = job.permissions
    if (!perms || typeof perms !== 'object' || Object.keys(perms).length !== 1 || perms.actions !== 'write') {
      problems.push(`${where}; its permissions must be exactly \`actions: write\``)
    }
    if (steps.length !== 1 || steps.some((st) => st?.uses !== undefined || st?.if !== undefined)) {
      problems.push(`${where}; it must be one step with no \`uses:\` and no step \`if\` -- the write token must not share a runner with repository or dependency code`)
    }
    if (verdictJobs.has(jobId)) problems.push(`${where}, but it is a verify leg or the gate -- the cancel must be a job of its own`)
  }
  // Lint too: the legs no longer wait for it, so its failure must cancel them on a pull request.
  for (const leg of [...uploaders, ...(doc.jobs.lint ? ['lint'] : [])]) {
    const n = failFastFor.get(leg)?.length ?? 0
    if (n !== 1) problems.push(`${leg} has ${n} fail-fast job(s); it needs exactly one, so its failure cancels the rest of a pull-request run`)
  }
  for (const jobId of verdictJobs) {
    const perms = doc.jobs[jobId]?.permissions
    const writes = perms && typeof perms === 'object' ? Object.entries(perms).filter(([, v]) => v === 'write').map(([k]) => k) : perms === 'write-all' ? ['write-all'] : []
    if (writes.length > 0) problems.push(`${jobId} runs repository code with a write token (${writes.join(', ')}) -- only a fail-fast job may hold actions: write`)
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
        if (cond && normalizeIf(cond) !== STRICT_STEP_IF) {
          problems.push(`${label}: the strict check-record.mjs call has \`if: ${normalizeIf(cond)}\`; it must be exactly \`${STRICT_STEP_IF}\` -- any other clause can skip the check`)
        }
      } else if (!PULL_REQUEST_ONLY.test(text(step.if))) {
        problems.push(`${label}: a flagged check-record.mjs call must be pull-request-only`)
      }
    }
  }
  if (strictCalls === 0) problems.push('no step calls `check-record.mjs <sha>` without a flag -- the strict check is gone')

  checkRunnerHygiene(doc, problems)

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
