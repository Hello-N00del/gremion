#!/usr/bin/env node
// TASK-045 (TRD-341, Q2): the merge block.
//
// Reads scripts/verify/out/<sha>.json WITHOUT re-running anything and exits 0
// only when it is a complete (every required suite present), all-green,
// non-partial record for the sha it is asked about. Everything else --
// missing record, unreadable/malformed JSON, a partial (--only) record, any
// suite not `pass`, or a required suite the record does not even mention --
// exits non-zero and names the reason. `verify.mjs`'s own `ok` field is never
// trusted directly: this recomputes pass/fail from `suites`/`partial` itself,
// so a hand-edited record cannot fake a green gate (record.mjs's own comment
// makes the same point from the writer's side).
//
// `--allow-missing <suite[,suite]>` (ci.yml's pull_request path only) excuses
// the ABSENCE of the named suites and nothing else: a named suite that is in
// the record must still pass, every name must be a required suite, and a
// partial record is still refused. Without the flag nothing changes -- the
// release signer (sign-release.sh) calls this strict, and must keep doing so.
//
// Usage: node scripts/verify/check-record.mjs [sha] [--allow-missing <suite[,suite]>]
//        (sha defaults to HEAD; the flag may come before or after the sha)
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { headSha } from './lib/git.mjs'
import { readRecord, recordPath } from './lib/record.mjs'
import { loadRequiredSuites } from './verify.mjs'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..')

/**
 * @param {string} sha
 * @param {{readRecordFn?: typeof readRecord, requiredSuites?: string[], allowMissing?: string[]}} [deps]
 * @returns {{ok: boolean, reason: string, allowedMissing?: string[]}}
 */
export function checkRecord(sha, { readRecordFn = readRecord, requiredSuites = loadRequiredSuites(), allowMissing = [] } = {}) {
  const record = readRecordFn(sha)
  if (!record) {
    return { ok: false, reason: `no result record for ${sha} at ${recordPath(sha)} -- run \`pnpm verify\` first` }
  }
  if (record.sha !== sha) {
    return { ok: false, reason: `record at ${recordPath(sha)} is keyed ${record.sha}, not ${sha} -- stale or corrupt file` }
  }
  if (record.partial) {
    return { ok: false, reason: `record for ${sha} is partial (--only ${record.only}) -- a partial run never satisfies check-record` }
  }
  // A record with no "suites" field at all (a truncated write, a hand-edited
  // file) made `s in record.suites` throw a raw TypeError below -- fail-closed
  // either way (the process still exits non-zero), but this is the CLI's own
  // documented contract: "exits non-zero and names the reason" (this file's
  // own header), not an uncaught exception's stack trace.
  if (record.suites === null || typeof record.suites !== 'object' || Array.isArray(record.suites)) {
    return { ok: false, reason: `record for ${sha} is malformed (no "suites" object) at ${recordPath(sha)}` }
  }
  // Absence only: a suite named in allowMissing that the record does not
  // mention is skipped below, but one that IS present is judged like any other.
  const allowedMissing = requiredSuites.filter((s) => allowMissing.includes(s) && !(s in record.suites))
  const missing = requiredSuites.filter((s) => !(s in record.suites) && !allowMissing.includes(s))
  if (missing.length > 0) {
    return { ok: false, reason: `record for ${sha} is missing required suite(s): ${missing.join(', ')}` }
  }
  const failing = requiredSuites.filter((s) => !allowedMissing.includes(s) && record.suites[s]?.status !== 'pass')
  if (failing.length > 0) {
    const detail = failing.map((s) => `${s} (${record.suites[s]?.status ?? 'absent'}: ${record.suites[s]?.reason ?? 'no reason recorded'})`)
    return { ok: false, reason: `record for ${sha} is not all-green: ${detail.join('; ')}` }
  }
  if (allowedMissing.length > 0) {
    return { ok: true, reason: `record for ${sha} is all-green for every suite it carries`, allowedMissing }
  }
  return { ok: true, reason: `record for ${sha} is complete and all-green` }
}

export class UsageError extends Error {}

/**
 * Strict: an optional positional sha and an optional `--allow-missing`, in any
 * order; every name must be a required suite. Anything else is a usage error,
 * so a typo'd flag can never look like it relaxed (or tightened) the gate.
 * @returns {{sha: string|null, allowMissing: string[]}}
 */
export function parseArgs(argv, requiredSuites = loadRequiredSuites()) {
  let sha = null
  const allowMissing = []
  const names = (value) => {
    const list = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    if (value === undefined || value.startsWith('--') || list.length === 0) {
      throw new UsageError('--allow-missing needs a suite name (--allow-missing <suite[,suite]>)')
    }
    return list
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--allow-missing') allowMissing.push(...names(argv[++i]))
    else if (arg.startsWith('--allow-missing=')) allowMissing.push(...names(arg.slice('--allow-missing='.length)))
    else if (arg.startsWith('--')) throw new UsageError(`unknown argument: ${arg} -- check-record accepts only [sha] and --allow-missing <suite[,suite]>`)
    else if (sha === null) sha = arg
    else throw new UsageError(`unexpected extra argument: ${arg} -- at most one sha`)
  }
  const unknown = allowMissing.filter((s) => !requiredSuites.includes(s))
  if (unknown.length > 0) {
    throw new UsageError(`--allow-missing names a suite that is not required: ${unknown.join(', ')} (required: ${requiredSuites.join(', ')})`)
  }
  return { sha, allowMissing: [...new Set(allowMissing)] }
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`[check-record] usage error: ${err.message}`)
      process.exitCode = 1
      return
    }
    throw err
  }
  const sha = args.sha ?? headSha(REPO_ROOT)
  const result = checkRecord(sha, { allowMissing: args.allowMissing })
  if (result.ok) {
    const allowed = result.allowedMissing?.length ? ` (allowed missing: ${result.allowedMissing.join(', ')})` : ''
    console.log(`[check-record] PASS${allowed}: ${result.reason}`)
    process.exitCode = 0
  } else {
    console.error(`[check-record] FAIL: ${result.reason}`)
    process.exitCode = 1
  }
}

// See verify.mjs's own comment on this same check: a hand-built `file://`
// string diverges from `import.meta.url` for any path a URL encodes, most
// commonly a space -- this is the merge block, so silently never running
// main() here means a merge step calling this with an absent/red record
// exits 0 anyway. Reproduced: copied scripts/ to a path containing a space;
// `node '.../sp ace/scripts/verify/check-record.mjs' deadbeef` exited 0 with
// no output.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
