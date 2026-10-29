#!/usr/bin/env node
// Phase 1.1 of the CI consolidation: merge the per-leg partial records into one
// whole record that check-record.mjs can judge.
//
// ci.yml runs `verify.mjs --only <parts>` in several parallel legs. Each leg
// writes a PARTIAL record (`partial: true`, which check-record refuses on
// purpose) and uploads it as an artifact; the verify-gate job downloads them
// all and calls this file. The output is a NON-partial record keyed by the
// commit, holding every suite every leg ran, so check-record.mjs stays the one
// and only judge: this file merges, it never decides pass/fail itself (it
// exits 0 after writing even when a suite failed).
//
// What it refuses, because each would let a gate go green on less than the
// commit's evidence: no records at all, a record that does not parse, a record
// for another sha (a stale artifact), a suite reported by two records (no
// silent overwrite), and a record carrying a whole `unit` next to `unit:<part>`
// keys (ambiguous which one is the truth). A record's existence already attests
// a clean tree -- verify.mjs refuses a dirty one and writes nothing on a moved
// HEAD -- so there is deliberately no tree-clean field to forge here.
//
// `unit` and `integration` are composite: a leg that ran `--only unit:ui` stores
// the key `unit:ui`, not a `unit` suite. The whole `unit` is synthesised here,
// and passes only if EVERY key of UNIT_PARTS is present and green, so a part
// nobody ran (or a leg that got dropped) fails the suite instead of vanishing.
// The part names come from the suites' own exports, never a hand-kept copy.
//
// Usage: node scripts/verify/combine-records.mjs --in-dir <dir> [--sha <40-hex>] [--out <path>]
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { headSha } from './lib/git.mjs'
import { recordPath } from './lib/record.mjs'
import { INTEGRATION_PARTS } from './suites/integration.mjs'
import { UNIT_PARTS } from './suites/unit.mjs'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..')
const SHA_RE = /^[0-9a-f]{40}$/

export class UsageError extends Error {}
export class CombineError extends Error {}

/** Composite suite name -> the part names it is made of (from the real registries). */
export const COMPOSITES = {
  unit: Object.keys(UNIT_PARTS),
  integration: Object.keys(INTEGRATION_PARTS),
}

function takeValue(argv, i, flag) {
  const value = argv[i]
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`)
  return value
}

/** Any argument other than the three below is a usage error, never ignored. */
export function parseArgs(argv) {
  const out = { inDir: null, sha: null, out: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.indexOf('=')
    const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg
    const inline = flag !== arg ? arg.slice(eq + 1) : undefined
    const value = (name) => inline ?? takeValue(argv, ++i, name)
    if (flag === '--in-dir') out.inDir = value('--in-dir')
    else if (flag === '--sha') out.sha = value('--sha')
    else if (flag === '--out') out.out = value('--out')
    else throw new UsageError(`unknown argument: ${arg} -- combine-records accepts only --in-dir <dir> [--sha <40-hex>] [--out <path>]`)
  }
  if (!out.inDir) throw new UsageError('--in-dir <dir> is required')
  if (out.sha !== null && !SHA_RE.test(out.sha)) throw new UsageError(`--sha must be 40 lowercase hex characters, got: ${out.sha}`)
  return out
}

/** Every *.json under dir, recursively (download-artifact puts each artifact in its own subdirectory). */
export function findJsonFiles(dir) {
  const found = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.json')) found.push(full)
    }
  }
  walk(dir)
  return found.sort()
}

function validateRecord(raw, file, sha) {
  let record
  try {
    record = JSON.parse(raw)
  } catch (err) {
    throw new CombineError(`${file}: not valid JSON (${err.message})`)
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new CombineError(`${file}: not a record object`)
  if (record.schemaVersion !== 1) throw new CombineError(`${file}: schemaVersion is ${JSON.stringify(record.schemaVersion)}, expected 1`)
  if (typeof record.sha !== 'string' || !SHA_RE.test(record.sha)) throw new CombineError(`${file}: "sha" is not a 40-hex commit sha`)
  if (record.sha !== sha) throw new CombineError(`${file}: record is for ${record.sha}, not ${sha} -- a stale artifact from another commit must never merge`)
  if (record.suites === null || typeof record.suites !== 'object' || Array.isArray(record.suites)) throw new CombineError(`${file}: no "suites" object`)
  return record
}

function synthesize(name, parts, suites) {
  const missing = []
  const failing = []
  const sum = { collected: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 }
  for (const part of parts) {
    const s = suites[`${name}:${part}`]
    if (!s) {
      missing.push(part)
      continue
    }
    if (s.status !== 'pass') failing.push(`${part} (${s.status ?? 'absent'}: ${s.reason ?? 'no reason recorded'})`)
    for (const k of Object.keys(sum)) sum[k] += Number.isFinite(s[k]) ? s[k] : 0
  }
  const problems = []
  if (missing.length > 0) problems.push(`missing part(s): ${missing.join(', ')}`)
  if (failing.length > 0) problems.push(`failing part(s): ${failing.join('; ')}`)
  return {
    status: problems.length === 0 ? 'pass' : 'fail',
    reason: problems.length === 0 ? null : `${name} is not complete -- ${problems.join(' | ')}`,
    ...sum,
    detail: '',
  }
}

/**
 * @param {Array<{file: string, raw: string}>} inputs
 * @param {string} sha
 * @returns the combined, non-partial record
 */
export function combine(inputs, sha) {
  if (inputs.length === 0) throw new CombineError('no record files found -- nothing to combine, and an empty gate must not pass')
  const suites = {}
  const owner = {}
  const combinedFrom = []
  const deferred = new Set()
  const starts = []
  const ends = []
  for (const { file, raw } of inputs) {
    const record = validateRecord(raw, file, sha)
    for (const [name, suite] of Object.entries(record.suites)) {
      if (name in suites) throw new CombineError(`suite "${name}" is reported by both ${owner[name]} and ${file} -- refusing to overwrite one with the other`)
      suites[name] = suite
      owner[name] = file
    }
    combinedFrom.push({ file, only: record.only ?? null })
    for (const d of Array.isArray(record.deferred) ? record.deferred : []) deferred.add(d)
    if (typeof record.startedAt === 'string' && !Number.isNaN(Date.parse(record.startedAt))) starts.push(record.startedAt)
    if (typeof record.finishedAt === 'string' && !Number.isNaN(Date.parse(record.finishedAt))) ends.push(record.finishedAt)
  }
  for (const [name, parts] of Object.entries(COMPOSITES)) {
    const partKeys = Object.keys(suites).filter((k) => k.startsWith(`${name}:`))
    if (partKeys.length === 0) continue
    if (name in suites) {
      throw new CombineError(`ambiguous: a whole "${name}" suite (${owner[name]}) and "${name}:<part>" keys (${partKeys.map((k) => owner[k]).join(', ')}) are both present`)
    }
    suites[name] = synthesize(name, parts, suites)
  }
  const byTime = (a, b) => Date.parse(a) - Date.parse(b)
  const allPass = Object.values(suites).every((s) => s?.status === 'pass')
  return {
    schemaVersion: 1,
    sha,
    only: null,
    partial: false,
    startedAt: [...starts].sort(byTime)[0] ?? null,
    finishedAt: [...ends].sort(byTime).at(-1) ?? null,
    deferred: [...deferred],
    suites,
    // Same convenience field record.mjs writes; check-record.mjs recomputes it.
    ok: allPass,
    combinedFrom,
  }
}

function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`[combine-records] usage error: ${err.message}`)
      return 1
    }
    throw err
  }
  try {
    const sha = args.sha ?? headSha(REPO_ROOT)
    const dest = path.resolve(args.out ?? recordPath(sha))
    if (!statSync(args.inDir, { throwIfNoEntry: false })?.isDirectory()) throw new CombineError(`--in-dir ${args.inDir} is not a directory`)
    // A previous combined output sitting in the input tree is not an input.
    const files = findJsonFiles(args.inDir).filter((f) => path.resolve(f) !== dest)
    const inputs = files.map((f) => ({ file: path.relative(args.inDir, f).split(path.sep).join('/'), raw: readFileSync(f, 'utf8') }))
    const record = combine(inputs, sha)
    mkdirSync(path.dirname(dest), { recursive: true })
    writeFileSync(dest, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    for (const [name, s] of Object.entries(record.suites)) {
      console.log(`[combine-records] ${s.status === 'pass' ? 'PASS' : 'FAIL'} ${name}${s.status === 'pass' ? '' : ` -- ${s.reason ?? 'no reason recorded'}`}`)
    }
    console.log(`[combine-records] wrote ${dest} from ${inputs.length} record(s)`)
    return 0
  } catch (err) {
    if (err instanceof CombineError) {
      console.error(`[combine-records] FAIL: ${err.message}`)
      return 1
    }
    throw err
  }
}

// Same run-as-script check as verify.mjs / check-record.mjs (pathToFileURL, not
// a hand-built file:// string, so a checkout path with a space still runs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (err) {
    console.error(`[combine-records] FAILED: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}
