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
// Usage: node scripts/verify/check-record.mjs [sha]   (default: HEAD)
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { headSha } from './lib/git.mjs'
import { readRecord, recordPath } from './lib/record.mjs'
import { loadRequiredSuites } from './verify.mjs'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..')

/**
 * @param {string} sha
 * @param {{readRecordFn?: typeof readRecord, requiredSuites?: string[]}} [deps]
 * @returns {{ok: boolean, reason: string}}
 */
export function checkRecord(sha, { readRecordFn = readRecord, requiredSuites = loadRequiredSuites() } = {}) {
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
  const missing = requiredSuites.filter((s) => !(s in record.suites))
  if (missing.length > 0) {
    return { ok: false, reason: `record for ${sha} is missing required suite(s): ${missing.join(', ')}` }
  }
  const failing = requiredSuites.filter((s) => record.suites[s]?.status !== 'pass')
  if (failing.length > 0) {
    const detail = failing.map((s) => `${s} (${record.suites[s]?.status ?? 'absent'}: ${record.suites[s]?.reason ?? 'no reason recorded'})`)
    return { ok: false, reason: `record for ${sha} is not all-green: ${detail.join('; ')}` }
  }
  return { ok: true, reason: `record for ${sha} is complete and all-green` }
}

function main() {
  const sha = process.argv[2] ?? headSha(REPO_ROOT)
  const result = checkRecord(sha)
  if (result.ok) {
    console.log(`[check-record] PASS: ${result.reason}`)
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
