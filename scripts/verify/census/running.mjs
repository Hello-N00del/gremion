#!/usr/bin/env node
// TASK-036 (L1-17, TRD-178): the running half of the health census.
//
//   node scripts/verify/census/running.mjs --project <compose-project> [--project ...]
//        [--exempt "<svc> <svc>" | --env-file <env file with HEALTH_EXEMPT_SERVICES>]
//        [--timeout <seconds, default 300>] [--interval <seconds, default 5>]
//
// Reads every container carrying com.docker.compose.project=<p> and requires,
// after a BOUNDED wait:
//   - at least one container per named project (0 containers is a FAIL: a
//     reading of nothing is not a pass);
//   - .State.Health present (a container reporting none fails at once);
//   - health status `healthy` (`starting` / `unhealthy` are waited on until
//     the deadline, then fail by name);
//   - an exempt one-shot (exact name on HEALTH_EXEMPT_SERVICES) `exited 0`.
// Exit 0 only when every container passes. It never starts, stops or
// touches a container -- read-only `docker ps` / `docker inspect`.
//
// The host half ('on the re-initialised host, docker inspect reports ...
// healthy for every deployed container') is run on the rebuilt host by the
// re-init verification (TASK-038); this file is what it runs.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { run, tail } from '../lib/proc.mjs'
import { parseExemptList, readEnvKey } from './render.mjs'

const PROJECT_LABEL = 'com.docker.compose.project'
const SERVICE_LABEL = 'com.docker.compose.service'

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Every container of `projects`: `{ok, containers}` or `{ok: false, detail}`. */
export function listContainers(projects, { docker = run } = {}) {
  const containers = []
  const empty = []
  for (const project of projects) {
    const ps = docker('docker', ['ps', '-a', '--no-trunc', '--filter', `label=${PROJECT_LABEL}=${project}`, '--format', '{{.Names}}'], { timeout: 60_000 })
    if (ps.code !== 0) return { ok: false, detail: `docker ps (${project}) exited ${ps.code ?? ps.signal}: ${tail(ps.stderr || ps.stdout, 300)}` }
    const names = ps.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    if (names.length === 0) {
      empty.push(project)
      continue
    }
    const ins = docker('docker', ['inspect', ...names], { timeout: 60_000 })
    if (ins.code !== 0) return { ok: false, detail: `docker inspect (${project}) exited ${ins.code ?? ins.signal}: ${tail(ins.stderr || ins.stdout, 300)}` }
    let docs
    try {
      docs = JSON.parse(ins.stdout)
    } catch {
      return { ok: false, detail: `docker inspect (${project}) printed no JSON` }
    }
    if (!Array.isArray(docs) || docs.length !== names.length) return { ok: false, detail: `docker inspect (${project}) returned ${docs?.length} of ${names.length} containers` }
    for (const d of docs) {
      containers.push({
        name: String(d.Name ?? '').replace(/^\//, ''),
        project: d.Config?.Labels?.[PROJECT_LABEL] ?? project,
        service: d.Config?.Labels?.[SERVICE_LABEL] ?? '(no service label)',
        status: d.State?.Status ?? 'unknown',
        exitCode: d.State?.ExitCode,
        health: d.State?.Health?.Status ?? null,
      })
    }
  }
  return { ok: true, containers, empty }
}

/** One reading: which containers pass, which are still settling, which fail for good. */
export function judgeContainers(containers, exempt) {
  const ok = []
  const pending = []
  const failures = []
  for (const x of containers) {
    const tag = `${x.service} [${x.project}]`
    if (exempt.has(x.service)) {
      if (x.status === 'exited') {
        if (x.exitCode === 0) ok.push(`exempt ${x.service} exited 0 [${x.project}]`)
        else failures.push(`${tag}: exempt one-shot exited ${x.exitCode}`)
      } else {
        pending.push({ tag, why: `exempt one-shot still ${x.status}` })
      }
      continue
    }
    if (x.health === null) {
      failures.push(`${tag}: no healthcheck (.State.Health absent)`)
    } else if (x.status !== 'running') {
      failures.push(`${tag}: not running (${x.status})`)
    } else if (x.health === 'healthy') {
      ok.push(`healthy ${x.service} [${x.project}]`)
    } else {
      pending.push({ tag, why: `health ${x.health}` })
    }
  }
  return { ok, pending, failures }
}

/**
 * Poll until every container passes, one fails for good, or the deadline.
 * @returns {{pass: boolean, lines: string[], failures: string[]}}
 */
export function checkRunning({ projects, exempt = [], docker = run, timeoutMs = 300_000, intervalMs = 5_000, now = Date.now, sleep = sleepSync }) {
  if (!projects || projects.length === 0) return { pass: false, lines: [], failures: ['no --project given'] }
  const exemptSet = new Set(exempt)
  const deadline = now() + timeoutMs
  for (;;) {
    const listed = listContainers(projects, { docker })
    if (!listed.ok) return { pass: false, lines: [], failures: [listed.detail] }
    const failures = listed.empty.map((p) => `project ${p}: 0 containers`)
    const j = judgeContainers(listed.containers, exemptSet)
    failures.push(...j.failures)
    const lines = [...j.ok].sort()
    if (failures.length > 0) return { pass: false, lines, failures }
    if (j.pending.length === 0) return { pass: true, lines, failures: [] }
    if (now() >= deadline) {
      const secs = Math.round(timeoutMs / 1000)
      return { pass: false, lines, failures: j.pending.map((p) => `${p.tag}: ${p.why} after ${secs}s`) }
    }
    sleep(Math.min(intervalMs, Math.max(0, deadline - now())))
  }
}

export function parseArgs(argv) {
  const out = { projects: [], exempt: [], timeoutMs: 300_000, intervalMs: 5_000 }
  const value = (i) => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${argv[i]} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--project') out.projects.push(value(i++))
    else if (a === '--exempt') out.exempt.push(...parseExemptList(value(i++).replaceAll(',', ' ')))
    else if (a === '--env-file') out.exempt.push(...parseExemptList(readEnvKey(readFileSync(value(i++), 'utf8'), 'HEALTH_EXEMPT_SERVICES')))
    else if (a === '--timeout') out.timeoutMs = Number(value(i++)) * 1000
    else if (a === '--interval') out.intervalMs = Number(value(i++)) * 1000
    else throw new Error(`unknown argument: ${a}`)
  }
  if (out.projects.length === 0) throw new Error('at least one --project <compose project> is required')
  if (!(out.timeoutMs > 0) || !(out.intervalMs > 0)) throw new Error('--timeout and --interval must be positive numbers')
  return out
}

function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    console.error(`[running] usage error: ${err.message}`)
    return 2
  }
  const r = checkRunning(args)
  for (const l of r.lines) console.log(`[running] ${l}`)
  for (const f of r.failures) console.log(`[running] FAIL ${f}`)
  console.log(`[running] ${r.pass ? 'PASS' : 'FAIL'} projects=${args.projects.join(',')}`)
  return r.pass ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (err) {
    console.error(`[running] FAILED -- internal error: ${err?.stack || err}`)
    process.exitCode = 1
  }
}
