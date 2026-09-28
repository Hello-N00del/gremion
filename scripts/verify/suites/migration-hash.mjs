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
  const manifestExists = entries.includes('manifest.json')

  // A real migrations directory (one or more *.sql files) always needs a
  // real manifest.json to compare against -- a missing or malformed one here
  // is unparseable, same as before. A directory with zero *.sql files and no
  // manifest.json at all is the genuinely-empty, nothing-ever-tracked-here
  // case (e.g. migrations-control before its first migration): manifest
  // stays {} and the comparison below runs over nothing, which `empty`
  // (checked by the caller, brief S6 item 5) turns into a suite-level fail.
  let manifest = {}
  if (manifestExists) {
    const manifestPath = path.join(dir, 'manifest.json')
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      return { unparseable: true }
    }
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
      return { unparseable: true }
    }
  } else if (sqlFiles.length > 0) {
    // *.sql files exist on disk but there is nothing to check them against.
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
  // Computed even when sqlFiles is empty (brief S6 item 5's real defect: a
  // directory whose *.sql files were all deleted but whose manifest.json
  // still lists them must report every one of those as missing-from-disk,
  // not silently read as "nothing to check" because the disk side is empty).
  const missingFromDisk = [...manifestFiles].filter((f) => !diskFiles.has(f))

  const failedCount = mismatches.length + missingFromManifest.length + missingFromDisk.length
  return {
    collected: sqlFiles.length,
    passed: sqlFiles.length - mismatches.length - missingFromManifest.length,
    failed: failedCount,
    skipped: 0,
    unparseable: false,
    empty: sqlFiles.length === 0,
    mismatches,
    missingFromManifest,
    missingFromDisk,
  }
}

/**
 * TASK-029 (G5b): the directories come from the migration register
 * (scripts/migrations/ranges.json, every chain's manifestDirs[]), no longer
 * two hard-coded paths, so a new chain with a manifest is hash-checked the day
 * it is registered. A missing or malformed register, or one declaring no
 * manifest directory, is unparseable -- never "nothing to check".
 * scripts/migrations/wiring.test.mjs fails if this stops reading the register.
 */
export function migrationHashDirs(root) {
  let reg
  try {
    reg = JSON.parse(readFileSync(path.join(root, 'scripts', 'migrations', 'ranges.json'), 'utf8'))
  } catch {
    return null
  }
  if (!reg || !Array.isArray(reg.chains)) return null
  const dirs = reg.chains.flatMap((c) => (Array.isArray(c.manifestDirs) ? c.manifestDirs : []))
  return dirs.length ? dirs.map((d) => path.join(root, ...d.split('/'))) : null
}

/** Run the suite over every manifest directory the migration register declares. */
export function runMigrationHashSuite({ root = path.join(import.meta.dirname, '..', '..', '..') } = {}) {
  const dirs = migrationHashDirs(root)
  if (!dirs) {
    return { toolMissing: null, unparseable: true, collected: 0, passed: 0, failed: 0, skipped: 0, detail: `${path.join(root, 'scripts', 'migrations', 'ranges.json')}: missing, malformed, or declares no manifestDirs` }
  }
  let collected = 0
  let passed = 0
  let failed = 0
  const problems = []
  const emptyDirs = []
  for (const dir of dirs) {
    const r = checkMigrationHashes(dir)
    if (r.unparseable) {
      return { toolMissing: null, unparseable: true, collected: 0, passed: 0, failed: 0, skipped: 0, detail: `${dir}: unreadable or malformed manifest.json` }
    }
    collected += r.collected
    passed += r.passed
    failed += r.failed
    if (r.empty) emptyDirs.push(dir)
    if (r.mismatches.length) problems.push(`${dir}: hash mismatch: ${r.mismatches.join(', ')}`)
    if (r.missingFromManifest.length) problems.push(`${dir}: on disk but not in manifest.json: ${r.missingFromManifest.join(', ')}`)
    if (r.missingFromDisk.length) problems.push(`${dir}: in manifest.json but missing on disk: ${r.missingFromDisk.join(', ')}`)
  }
  if (emptyDirs.length > 0) {
    // Brief S6 item 5: an empty directory must exit non-zero on its own,
    // never be washed out by summing collected counts across BOTH
    // directories (the real defect: migrations had 31 real files while
    // migrations-control had 0 -- their SUM was still >0, so the old
    // collected<=0 guard alone could never catch this). Reported as
    // unparseable so lib/guard.mjs fails regardless of the other
    // directory's own collected/passed/failed numbers.
    return {
      toolMissing: null,
      unparseable: true,
      collected,
      passed,
      failed,
      skipped: 0,
      detail: `${emptyDirs.join(', ')}: 0 *.sql file(s) found -- refusing an empty migrations directory${problems.length ? '; ' + problems.join('; ') : ''}`,
    }
  }
  return { toolMissing: null, unparseable: false, collected, passed, failed, skipped: 0, detail: problems.join('; ') }
}
