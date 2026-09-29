// scripts/migrations/pre-apply.mjs -- TASK-029 runtime refusal (TRD-344).
//
// chainPreApply returns a TASK-020 `hooks.preApply`. The runner calls it under
// the migration advisory lock, before each pending file's transaction; this
// hook checks the WHOLE chain on the run's FIRST call (so before any DDL) and
// is a no-op on the run's later calls:
//
//   - the ledger holds a name the chain lacks (a renamed, renumbered or
//     deleted applied migration) -> refused;
//   - a pending file numbers below the ledger's high-water and is not in the
//     run's declared catch-up set -> refused. A declared catch-up (gremion-ui's
//     module OFF->ON re-enable, backFillNotice's `expected`) is applied and
//     logged.
//
// Checking per file instead would apply the good files ahead of an offending
// one; the whole-chain check refuses the run with nothing applied. The chain
// is the union of the register's dirs[] ordered by NUMBER, so a multi-dir
// chain (kernel-data: gremion-ui/migrations + modules/content/app/migrations)
// is one sequence -- the union runner itself is TASK-075/077's.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export class ChainRefusal extends Error {
  constructor(code, message, files) {
    super(`${code}: ${message}`)
    this.name = 'ChainRefusal'
    this.code = code
    this.files = files
  }
}

export const migrationNumber = (file) => {
  const m = /^(\d+)_/.exec(file)
  return m ? Number(m[1]) : Number.NaN
}

/** The chain's file names from the register, reading its dirs under `root`. */
export function chainFileNames(chainId, { root, register } = {}) {
  const reg = register ?? JSON.parse(readFileSync(join(root, 'scripts', 'migrations', 'ranges.json'), 'utf8'))
  const chain = reg.chains.find((c) => c.id === chainId)
  if (!chain) throw new ChainRefusal('UNKNOWN_CHAIN', `no chain ${chainId} in the register`, [])
  const names = []
  for (const d of chain.dirs) if (existsSync(join(root, d))) for (const f of readdirSync(join(root, d))) if (f.endsWith('.sql')) names.push(f)
  return names.sort((a, b) => migrationNumber(a) - migrationNumber(b))
}

/**
 * @param {{chainFiles: string[], catchUp?: Iterable<string>, log?: (l: string) => void}} o
 * @returns {(file: string, ctx: {applied: readonly string[], pending: readonly string[]}) => void}
 */
export function chainPreApply({ chainFiles, catchUp = [], log = () => {} }) {
  if (!Array.isArray(chainFiles) || chainFiles.length === 0) throw new ChainRefusal('EMPTY_CHAIN', 'chainPreApply needs the chain file set; an empty set would refuse nothing', [])
  const chain = new Set(chainFiles)
  const expected = new Set(catchUp)
  const seen = new WeakSet()
  return function preApply(_file, ctx) {
    // once per run: the runner passes the same ctx object to every call of one run
    if (seen.has(ctx)) return
    seen.add(ctx)
    const orphans = ctx.applied.filter((f) => !chain.has(f))
    if (orphans.length)
      throw new ChainRefusal('LEDGER_NAME_NOT_IN_CHAIN', `the ledger holds ${orphans.join(', ')}, which the chain lacks -- an applied migration was renamed, renumbered or deleted; nothing was applied`, orphans)
    const high = Math.max(0, ...ctx.applied.map(migrationNumber).filter((n) => !Number.isNaN(n)))
    const below = ctx.pending.filter((f) => migrationNumber(f) < high)
    const undeclared = below.filter((f) => !expected.has(f))
    if (undeclared.length)
      throw new ChainRefusal('BELOW_HIGH_WATER', `pending ${undeclared.join(', ')} number(s) below the ledger high-water ${high} and are not in this run's declared catch-up set; nothing was applied`, undeclared)
    if (below.length) log(`declared catch-up below high-water ${high}: ${below.join(', ')}`)
  }
}
