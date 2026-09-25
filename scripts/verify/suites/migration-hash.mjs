// TASK-045: migration-hash suite (TRD-444). Recomputes sha256 for every
// *.sql in a migrations directory and compares it against that directory's
// committed manifest.json -- WITHOUT writing anything. The builder
// (gremion-ui/scripts/build-migration-manifest.mjs) writes in place and is
// never called from here (brief S5): a suite whose "check" step is "run the
// builder" would always pass, because the builder happily overwrites a wrong
// manifest instead of failing on one.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * @param {string} dir absolute path to a migrations directory (contains
 *   *.sql files and a manifest.json).
 * @returns {{collected: number, passed: number, failed: number, skipped: number,
 *   unparseable: boolean, mismatches: string[], missingFromManifest: string[],
 *   missingFromDisk: string[]}}
 */
export function checkMigrationHashes(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    // An unreadable directory is unparseable, not a vacuous pass: the guard
    // must never read "could not list files" as "found nothing to check".
    return { unparseable: true }
  }
  const sqlFiles = entries.filter((f) => f.endsWith('.sql')).sort()
  // Refuse an empty directory outright (brief S6 item 5) -- a migrations dir
  // with zero *.sql files means the check ran over nothing, which is the same
  // vacuity shape as a test suite that collected zero tests.
  if (sqlFiles.length === 0) {
    return { collected: 0, passed: 0, failed: 0, skipped: 0, unparseable: false, mismatches: [], missingFromManifest: [], missingFromDisk: [] }
  }

  const manifestPath = path.join(dir, 'manifest.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return { unparseable: true }
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return { unparseable: true }
  }

  const mismatches = []
  const missingFromManifest = []
  for (const file of sqlFiles) {
    const bytes = readFileSync(path.join(dir, file))
    const actual = createHash('sha256').update(bytes).digest('hex')
    const expected = manifest[file]
    if (expected === undefined) {
      missingFromManifest.push(file)
    } else if (expected !== actual) {
      mismatches.push(file)
    }
  }
  const manifestFiles = new Set(Object.keys(manifest))
  const diskFiles = new Set(sqlFiles)
  const missingFromDisk = [...manifestFiles].filter((f) => !diskFiles.has(f))

  const failedCount = mismatches.length + missingFromManifest.length + missingFromDisk.length
  return {
    collected: sqlFiles.length,
    passed: sqlFiles.length - mismatches.length - missingFromManifest.length,
    failed: failedCount,
    skipped: 0,
    unparseable: false,
    mismatches,
    missingFromManifest,
    missingFromDisk,
  }
}

/** Run the suite over both kernel migration directories. */
export function runMigrationHashSuite({ root = path.join(import.meta.dirname, '..', '..', '..') } = {}) {
  const dirs = [path.join(root, 'gremion-ui', 'migrations'), path.join(root, 'gremion-ui', 'migrations-control')]
  let collected = 0
  let passed = 0
  let failed = 0
  const problems = []
  for (const dir of dirs) {
    const r = checkMigrationHashes(dir)
    if (r.unparseable) {
      return { toolMissing: null, unparseable: true, collected: 0, passed: 0, failed: 0, skipped: 0, detail: `${dir}: unreadable or malformed manifest.json` }
    }
    collected += r.collected
    passed += r.passed
    failed += r.failed
    if (r.mismatches.length) problems.push(`${dir}: hash mismatch: ${r.mismatches.join(', ')}`)
    if (r.missingFromManifest.length) problems.push(`${dir}: on disk but not in manifest.json: ${r.missingFromManifest.join(', ')}`)
    if (r.missingFromDisk.length) problems.push(`${dir}: in manifest.json but missing on disk: ${r.missingFromDisk.join(', ')}`)
  }
  return { toolMissing: null, unparseable: false, collected, passed, failed, skipped: 0, detail: problems.join('; ') }
}
