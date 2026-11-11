#!/usr/bin/env node
// Guard: the workflows other than ci.yml keep the same runner hygiene ci.yml has.
// scripts/check-ci-verify-coverage.mjs owns ci.yml; this one reads every other file
// in .github/workflows. Each rule below is red on the pull request that breaks it:
//
//   1. Every job has a timeout-minutes.
//   2. Every checkout sets persist-credentials: false.
//   3. The workflow root grants no write scope, except the one a workflow names in
//      ALLOWED_ROOT_WRITES: write scopes belong on the job that uses them.
//   4. No `${{ }}` expression is expanded inside a `run:` body.
//   5. pip and global npm tools are pinned to an exact version.
//   6. release-npm.yml checks the tag on every run that would really publish.
//   7. semgrep.yml keeps a push scan from being cancelled, proves it covered files,
//      and reports a failed weekly run from a job that holds only `issues: write`.
//
// SCOPE. This catches accidental drift in review. It is not a sandbox against someone
// editing a workflow and this guard together.
//
// Run:  node scripts/check-workflow-hygiene.mjs [--dir <workflows directory>]
// Test: node --test scripts/check-workflow-hygiene.test.mjs

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const WORKFLOWS_DIR = join(ROOT, '.github', 'workflows')

/**
 * Fewer workflows than this and the scan is not looking at the directory. Kept below today's
 * count (4) on purpose: retiring one workflow must not turn this guard red.
 */
export const MIN_WORKFLOWS = 2

const ALLOWED_ROOT_WRITES = { 'release-npm.yml': ['id-token'] }
const LIVE_PUBLISH_IF = "github.event_name == 'push' || inputs.dry_run != true"
const SEMGREP_CANCEL = "github.event_name == 'pull_request'"

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
const normalizeExpr = (v) => text(v === undefined || v === null ? '' : String(v)).replace(/^\s*\$\{\{|\}\}\s*$/g, '').replace(/\s+/g, ' ').trim()
const codeLines = (run) => text(run).split('\n').filter((l) => !/^\s*#/.test(l))

const PIP_INSTALL = /\bpip3?\s+install\s+([^;&|]+)/g
const NPM_INSTALL = /\bnpm\s+(-g\s+|--global\s+)?(?:install|i)\s+([^;&|]+)/g
const PIP_PIN = /^[A-Za-z0-9._-]+==\d+(?:\.\d+)+$/
const NPM_PIN = /^(?:@[^/@\s]+\/)?[^/@\s]+@\d+(?:\.\d+)+$/
const specsOf = (args) => args.trim().split(/\s+/).filter((t) => !t.startsWith('-'))

function checkPins(label, line, problems) {
  for (const m of line.matchAll(PIP_INSTALL)) {
    for (const spec of specsOf(m[1])) if (!PIP_PIN.test(spec)) problems.push(`${label}: pip package ${spec} is not pinned to an exact version`)
  }
  for (const m of line.matchAll(NPM_INSTALL)) {
    const global = Boolean(m[1]) || /(?:^|\s)(?:-g|--global)(?:\s|$)/.test(m[2])
    if (!global) continue
    for (const spec of specsOf(m[2])) if (!NPM_PIN.test(spec)) problems.push(`${label}: global npm package ${spec} is not pinned to an exact version`)
  }
}

function checkSemgrep(doc, problems) {
  if (normalizeExpr(doc.concurrency?.['cancel-in-progress']) !== SEMGREP_CANCEL) {
    problems.push(`semgrep.yml: cancel-in-progress must be \${{ ${SEMGREP_CANCEL} }} -- anything else lets a push cancel a running scan on main`)
  }
  const steps = asList(doc.jobs?.semgrep?.steps)
  if (!steps.some((s) => /--json-output=semgrep-report\.json\b/.test(text(s?.run)))) {
    problems.push('semgrep.yml: the scan does not write semgrep-report.json, so nothing can prove it covered any file')
  }
  if (!steps.some((s) => /\['paths'\]\['scanned'\]/.test(text(s?.run)))) {
    problems.push('semgrep.yml: no step asserts the number of scanned files -- a scan of nothing would pass')
  }
  const report = doc.jobs?.report
  const perms = report?.permissions
  if (!report || !/github\.event_name == 'schedule'/.test(normalizeExpr(report.if)) || !asList(report.needs).includes('semgrep')) {
    problems.push('semgrep.yml: no report job opens an issue when the weekly run fails')
  } else if (!perms || typeof perms !== 'object' || Object.keys(perms).length !== 1 || perms.issues !== 'write') {
    problems.push('semgrep.yml: the report job must hold exactly issues: write')
  } else if (asList(report.steps).some((s) => s?.uses !== undefined)) {
    problems.push('semgrep.yml: the report job must run no action: the write token must not share a runner with other code')
  }
}

/**
 * @param {Array<{name: string, text: string}>} files every workflow but ci.yml
 * @returns {{problems: string[], workflows: number, jobs: number}}
 */
export function checkWorkflows(files) {
  const problems = []
  let jobs = 0
  if (files.length < MIN_WORKFLOWS) problems.push(`found ${files.length} workflow(s), fewer than the floor of ${MIN_WORKFLOWS} -- this scan is not looking at the directory`)
  const missing = yamlUnavailableReason()
  if (missing) return { problems: [...problems, missing], workflows: files.length, jobs }

  for (const { name, text: source } of files) {
    let doc
    try {
      doc = parseYaml(source)
    } catch (err) {
      problems.push(`${name}: does not parse: ${String(err.message).split('\n')[0]}`)
      continue
    }
    if (!doc?.jobs || typeof doc.jobs !== 'object') {
      problems.push(`${name}: has no jobs mapping`)
      continue
    }

    const root = doc.permissions
    if (root === undefined || root === 'write-all') problems.push(`${name}: the workflow root must set read-only permissions, not ${root ?? 'the repository default'}`)
    if (root && typeof root === 'object') {
      const allowed = ALLOWED_ROOT_WRITES[name] ?? []
      for (const [scope, level] of Object.entries(root)) {
        if (level === 'write' && !allowed.includes(scope)) problems.push(`${name}: the workflow root grants ${scope}: write -- put it on the job that uses it`)
      }
    }

    for (const [jobId, job] of Object.entries(doc.jobs)) {
      jobs += 1
      const timeout = job?.['timeout-minutes']
      if (!Number.isInteger(timeout) || timeout < 1) problems.push(`${name}: ${jobId} has no timeout-minutes`)
      for (const [index, step] of asList(job?.steps).entries()) {
        if (!step || typeof step !== 'object') continue
        const label = `${name}: ${jobId} step ${index + 1}${step.name ? ` (${step.name})` : ''}`
        if (text(step.uses).startsWith('actions/checkout@') && step.with?.['persist-credentials'] !== false) {
          problems.push(`${label}: actions/checkout does not set persist-credentials: false`)
        }
        // Every line, comments too: GitHub expands an expression before the shell sees the comment.
        if (text(step.run).includes('${{')) problems.push(`${label}: a \${{ }} expression is expanded inside run: -- bind it to env:`)
        for (const line of codeLines(step.run)) checkPins(label, line, problems)
      }
    }

    if (name === 'release-npm.yml') {
      const tagCheck = asList(doc.jobs.publish?.steps).find((s) => s?.name === 'Tag and manifest must agree')
      if (!tagCheck) problems.push('release-npm.yml: the tag check step is gone')
      else if (normalizeExpr(tagCheck.if) !== LIVE_PUBLISH_IF) {
        problems.push(`release-npm.yml: the tag check has \`if: ${normalizeExpr(tagCheck.if) || '(none)'}\`; it must be exactly \`${LIVE_PUBLISH_IF}\` so every live publish is checked`)
      }
    }
    if (name === 'semgrep.yml') checkSemgrep(doc, problems)
  }
  return { problems, workflows: files.length, jobs }
}

/** Every workflow in `dir` except ci.yml, which check-ci-verify-coverage.mjs owns. */
export function readWorkflows(dir = WORKFLOWS_DIR) {
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f) && f !== 'ci.yml')
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.length !== 0 && !(argv.length === 2 && argv[0] === '--dir')) {
    console.error('[workflow-hygiene] usage: check-workflow-hygiene.mjs [--dir <workflows directory>]')
    process.exitCode = 1
    return
  }
  const result = checkWorkflows(readWorkflows(argv[1] ?? WORKFLOWS_DIR))
  if (result.problems.length > 0) {
    console.error('[workflow-hygiene] FAIL')
    for (const p of result.problems) console.error(`  - ${p}`)
    process.exitCode = 1
    return
  }
  console.log(`[workflow-hygiene] OK -- ${result.workflows} workflow(s), ${result.jobs} job(s)`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
