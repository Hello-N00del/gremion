// scripts/migrations/verify-applied.mjs -- TASK-029 (TRD-353, TRD-040).
//
// verifyApplied: the BOOT check. Before a service listens, every row of the
// database's migration ledger must name a file of its chain, carry a sha256,
// and that sha256 must equal the manifest entry, which must equal the file's
// bytes (row hash = manifest = file). A mismatch refuses the boot and names
// the file. This closes what neither half closes alone: the runner compares
// row with FILE only when it runs, and the schema gate compares row with
// MANIFEST only; `prebuild` regenerates the manifest, so a file edited after
// it was applied, with the manifest rebuilt, passed both.
//
// A ledger row with a NULL or empty sha256, or a ledger without the column
// at all (gremion-ui db.ts writes (filename, applied_at)), is REFUSED and
// named -- never skipped as unverifiable.
//
// ledgerMatchesChain (TRD-040, requireComplete): after a run, the ledger's
// row set equals the chain's file set minus the run's DECLARED skips (seeds
// under GREMION_DISABLE_SEEDS, a disabled module's files), each skip named in
// the run log. An undeclared missing row or an extra row fails.
//
// Plain ESM with a postgres-js `sql` (tagged template) so the kernel's JS
// scripts and the TypeScript services import the same code.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const LEDGER = 'public.schema_migrations'

export class VerifyAppliedError extends Error {
  constructor(problems) {
    super(`refusing to start: the applied migrations do not verify (TRD-353): ${problems.map(describe).join('; ')}`)
    this.name = 'VerifyAppliedError'
    this.problems = problems
  }
}

const describe = (p) => `${p.code} ${p.file}${p.detail ? ` (${p.detail})` : ''}`

/** The chain's files (union of dirs) with their manifest entries and actual hashes. */
export function readChain(dirs) {
  const files = new Map()
  const problems = []
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    let manifest = {}
    const mpath = join(dir, 'manifest.json')
    if (existsSync(mpath)) {
      try {
        manifest = JSON.parse(readFileSync(mpath, 'utf8'))
      } catch {
        problems.push({ code: 'MANIFEST_MALFORMED', file: mpath })
      }
    }
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      const bytes = readFileSync(join(dir, f))
      files.set(f, { dir, manifest: typeof manifest[f] === 'string' ? manifest[f] : undefined, actual: createHash('sha256').update(bytes).digest('hex') })
    }
  }
  return { files, problems }
}

/** Reads the ledger without DDL. null = no ledger table (nothing applied). */
export async function readLedger(sql) {
  const [reg] = await sql`SELECT to_regclass(${LEDGER}) IS NOT NULL AS present`
  if (!reg?.present) return { rows: null, hasHash: false }
  const [col] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute
       WHERE attrelid = to_regclass(${LEDGER}) AND attname = 'sha256' AND NOT attisdropped
    ) AS present`
  if (!col?.present) {
    const rows = await sql`SELECT filename FROM public.schema_migrations ORDER BY filename`
    return { rows: rows.map((r) => ({ filename: r.filename, sha256: null })), hasHash: false }
  }
  const rows = await sql`SELECT filename, sha256 FROM public.schema_migrations ORDER BY filename`
  return { rows: rows.map((r) => ({ filename: r.filename, sha256: r.sha256 })), hasHash: true }
}

/**
 * Pure comparison: ledger rows against the chain. `skips` = the run's declared
 * skips; `requireComplete` adds TRD-040 (no undeclared missing row).
 */
export function compareLedger({ rows, hasHash, chain, skips = [], requireComplete = false }) {
  const problems = []
  const skip = new Set(skips)
  if (rows !== null && !hasHash)
    for (const r of rows) problems.push({ code: 'LEDGER_WITHOUT_HASH', file: r.filename, detail: `${LEDGER} has no sha256 column; the row cannot be verified and is refused, never skipped` })
  for (const r of rows ?? []) {
    if (!hasHash) continue
    const f = chain.get(r.filename)
    if (!f) problems.push({ code: 'EXTRA_ROW', file: r.filename, detail: 'applied, but the chain has no such file' })
    else if (skip.has(r.filename)) problems.push({ code: 'EXTRA_ROW', file: r.filename, detail: 'applied, but this run declares it skipped' })
    else if (typeof r.sha256 !== 'string' || r.sha256 === '') problems.push({ code: 'NULL_HASH', file: r.filename, detail: 'the ledger row carries no sha256; refused, never skipped as unverifiable' })
    else if (f.manifest === undefined) problems.push({ code: 'NOT_IN_MANIFEST', file: r.filename })
    else if (f.manifest !== f.actual) problems.push({ code: 'FILE_NOT_MANIFEST', file: r.filename, detail: `manifest ${f.manifest.slice(0, 8)}, file ${f.actual.slice(0, 8)}` })
    else if (r.sha256 !== f.manifest) problems.push({ code: 'APPLIED_NOT_MANIFEST', file: r.filename, detail: `applied ${r.sha256.slice(0, 8)}, manifest ${f.manifest.slice(0, 8)}` })
  }
  if (requireComplete) {
    const have = new Set((rows ?? []).map((r) => r.filename))
    for (const name of chain.keys()) if (!skip.has(name) && !have.has(name)) problems.push({ code: 'UNDECLARED_MISSING_ROW', file: name, detail: 'in the chain, not applied, and not a declared skip' })
  }
  return problems
}

/**
 * The boot check. Resolves with {rows, skipsLogged} or throws
 * VerifyAppliedError naming every offending file.
 */
export async function verifyApplied({ sql, dirs, skips = [], requireComplete = false, log = () => {} }) {
  const { files: chain, problems: readProblems } = readChain(dirs)
  if (chain.size === 0) throw new VerifyAppliedError([{ code: 'NO_MIGRATIONS', file: dirs.join(', '), detail: 'the chain has no file; nothing to verify against' }])
  const { rows, hasHash } = await readLedger(sql)
  for (const s of skips) log(`declared skip: ${s}`)
  const problems = [...readProblems, ...compareLedger({ rows, hasHash, chain, skips, requireComplete })]
  if (problems.length) throw new VerifyAppliedError(problems)
  return { rows: rows?.length ?? 0, verified: (rows ?? []).map((r) => r.filename) }
}
