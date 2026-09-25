// TASK-045 (TRD-341): the result record. verify.mjs writes exactly one of
// these per run; check-record.mjs is the only reader, and is the thing an
// orchestrator's merge step calls to decide pass/fail without re-running
// anything.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const OUT_DIR = path.join(import.meta.dirname, '..', 'out')

export function recordPath(sha) {
  return path.join(OUT_DIR, `${sha}.json`)
}

/**
 * @param {object} input
 * @param {string} input.sha the tree's HEAD sha this record was produced from.
 * @param {Record<string, {status: 'pass'|'fail', collected: number, passed: number,
 *   failed: number, skipped: number, reason: string|null, durationMs: number}>} input.suites
 * @param {string|null} input.only the `--only <suite>` value, or null for a full run.
 * @param {string} input.startedAt ISO timestamp.
 * @param {string} input.finishedAt ISO timestamp.
 */
export function writeRecord({ sha, suites, only, startedAt, finishedAt }) {
  mkdirSync(OUT_DIR, { recursive: true })
  const partial = only !== null && only !== undefined
  const allPass = Object.values(suites).every((s) => s.status === 'pass')
  const record = {
    schemaVersion: 1,
    sha,
    only: only ?? null,
    partial,
    startedAt,
    finishedAt,
    suites,
    // `ok` mirrors what check-record.mjs re-derives independently -- kept here
    // only for human/log convenience, never trusted by check-record.mjs itself
    // (which recomputes from `suites`/`partial` so a hand-edited record cannot
    // fake a green gate).
    ok: allPass && !partial,
  }
  const dest = recordPath(sha)
  writeFileSync(dest, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return { path: dest, record }
}

export function readRecord(sha) {
  const p = recordPath(sha)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
