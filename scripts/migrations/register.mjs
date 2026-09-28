#!/usr/bin/env node
// scripts/migrations/register.mjs -- TASK-029 (L1-13): the migration register,
// one numbering sequence per DATABASE CHAIN (PRD-REC-005; TRD-344; D13, B-04).
//
//   ranges.json         the register: every chain, the directories whose files
//                       apply to one database, its zero-pad width, its
//                       high-water line (one per sequence -- the line two
//                       branches both edit when they claim the same number, so
//                       the claim collides in review, not in production), and
//                       the legacy floor below which the measured pre-register
//                       numbers (with their gaps) are frozen.
//   applied.lock.json   {chain: {file: sha256}} -- every chain file, frozen. A
//                       rename, a renumber, a changed byte or a deletion of a
//                       locked file fails; so does a chain file the lock lacks.
//   stura-only-slugs.json  the 29 migration slugs that exist only in the StuRa
//                       tree; none may enter a kernel-database chain.
//
// Commands:
//   node scripts/migrations/register.mjs check
//   node scripts/migrations/register.mjs claim --chain <id> --name <slug> [--dir <dir>]
//   node scripts/migrations/register.mjs freeze --chain <id>      (or --all)
//
// Hash = sha256 of the file's bytes. The kernel's .gitattributes forces
// `eol=lf` on these files, so the working bytes equal the git index blob on
// every checkout; `check` asserts the attribute for every chain file rather
// than trusting it.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(HERE, '..', '..')
export const REGISTER_PATH = 'scripts/migrations/ranges.json'
export const LOCK_PATH = 'scripts/migrations/applied.lock.json'
export const STURA_SLUGS_PATH = 'scripts/migrations/stura-only-slugs.json'

/** A migration filename: <number>_<slug>.sql. */
export const MIGRATION_NAME = /^(\d+)_([a-z0-9][a-z0-9_]*)\.sql$/
const SLUG = /^[a-z0-9][a-z0-9_]*$/
const SHA256_HEX = /^[0-9a-f]{64}$/

/** StuRa-tree module blocks (B-04): no kernel-repo migration may be numbered here. */
export const STURA_RANGES = [
  [1000, 1199],
  [1300, 2099],
]

export class RegisterError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'RegisterError'
    this.code = code
  }
}

export function parseName(base) {
  const m = MIGRATION_NAME.exec(base)
  if (!m) return null
  return { num: Number(m[1]), digits: m[1].length, slug: m[2] }
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const isInt = (n, min = 0) => Number.isInteger(n) && n >= min

/** Code-unit string order, the order `ls`/`readdir().sort()` and the runners use. */
export const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// ---------------------------------------------------------------- loader --

/**
 * Validates the register's shape. `files` (optional, repo-relative paths) adds
 * the one data-dependent loader rule: a sequence's highWater below its highest
 * file. Throws RegisterError with a named code.
 */
export function loadRegister(raw, files) {
  let reg = raw
  if (typeof raw === 'string') {
    try {
      reg = JSON.parse(raw)
    } catch (err) {
      throw new RegisterError('REGISTER_MALFORMED', `ranges.json is not JSON (${err.message})`)
    }
  }
  if (!reg || typeof reg !== 'object' || Array.isArray(reg)) throw new RegisterError('REGISTER_MALFORMED', 'ranges.json is not an object')
  if (!Array.isArray(reg.chains) || reg.chains.length === 0) throw new RegisterError('REGISTER_MALFORMED', 'ranges.json has no chains[]')
  if (!Array.isArray(reg.nonMigration)) throw new RegisterError('REGISTER_MALFORMED', 'ranges.json has no nonMigration[]')
  const ids = new Set()
  const owner = new Map()
  for (const c of reg.chains) {
    if (!c || typeof c !== 'object') throw new RegisterError('REGISTER_MALFORMED', 'a chain is not an object')
    if (typeof c.id !== 'string' || !/^[a-z0-9-]+$/.test(c.id)) throw new RegisterError('REGISTER_MALFORMED', `chain id ${JSON.stringify(c.id)} is not a kebab-case string`)
    if (ids.has(c.id)) throw new RegisterError('DUPLICATE_CHAIN', `chain ${c.id} is declared twice`)
    ids.add(c.id)
    if (c.padWidth === undefined) throw new RegisterError('NO_PAD_WIDTH', `chain ${c.id} declares no padWidth`)
    if (!isInt(c.padWidth, 1)) throw new RegisterError('REGISTER_MALFORMED', `chain ${c.id} padWidth is not a positive integer`)
    if (!isInt(c.highWater)) throw new RegisterError('REGISTER_MALFORMED', `chain ${c.id} highWater is not a non-negative integer`)
    if (!isInt(c.legacyFloor)) throw new RegisterError('REGISTER_MALFORMED', `chain ${c.id} legacyFloor is not a non-negative integer`)
    if (!Array.isArray(c.legacy) || c.legacy.some((n) => typeof n !== 'string')) throw new RegisterError('REGISTER_MALFORMED', `chain ${c.id} legacy is not a string[]`)
    if (typeof c.database !== 'string' || !c.database) throw new RegisterError('REGISTER_MALFORMED', `chain ${c.id} names no database`)
    if (!Array.isArray(c.dirs) || c.dirs.length === 0 || c.dirs.some((d) => typeof d !== 'string' || !d || d.endsWith('/') || d.includes('*')))
      throw new RegisterError('REGISTER_MALFORMED', `chain ${c.id} dirs[] must be non-empty plain repo-relative directories`)
    for (const d of c.dirs) {
      if (owner.has(d)) throw new RegisterError('DIR_IN_TWO_CHAINS', `${d} is declared by chain ${owner.get(d)} and chain ${c.id}`)
      owner.set(d, c.id)
    }
    const blocks = c.blocks ?? []
    if (!Array.isArray(blocks)) throw new RegisterError('REGISTER_MALFORMED', `chain ${c.id} blocks is not an array`)
    for (const b of blocks) {
      if (!b || typeof b.dir !== 'string' || !c.dirs.includes(b.dir)) throw new RegisterError('REGISTER_MALFORMED', `chain ${c.id} block dir ${b?.dir} is not one of its dirs[]`)
      if (!isInt(b.lo, 1) || !isInt(b.hi, 1) || b.lo > b.hi) throw new RegisterError('REGISTER_MALFORMED', `chain ${c.id} block ${b.dir} has no valid [lo, hi]`)
      if (!isInt(b.highWater)) throw new RegisterError('REGISTER_MALFORMED', `chain ${c.id} block ${b.dir} highWater is not a non-negative integer`)
    }
    if (c.manifestDirs !== undefined && (!Array.isArray(c.manifestDirs) || c.manifestDirs.some((d) => !c.dirs.includes(d))))
      throw new RegisterError('REGISTER_MALFORMED', `chain ${c.id} manifestDirs must be a subset of its dirs[]`)
  }
  for (const n of reg.nonMigration) {
    if (!n || typeof n.glob !== 'string' || !n.glob || typeof n.reason !== 'string' || !n.reason.trim())
      throw new RegisterError('REGISTER_MALFORMED', 'every nonMigration entry needs a glob and a reason')
  }
  if (files) {
    for (const c of reg.chains) {
      for (const s of sequences(c)) {
        const nums = files
          .filter((f) => s.dirs.includes(posix.dirname(f)))
          .map((f) => parseName(posix.basename(f))?.num)
          .filter((n) => n !== undefined)
        const max = nums.length ? Math.max(...nums) : 0
        if (s.highWater < max) throw new RegisterError('HIGH_WATER_BEHIND', `chain ${c.id} (${s.label}) highWater ${s.highWater} is below its highest file ${max}`)
      }
    }
  }
  return reg
}

/** The numbering sequences of a chain: the main one, then one per block. */
export function sequences(chain) {
  const blocks = chain.blocks ?? []
  const blockDirs = new Set(blocks.map((b) => b.dir))
  const main = {
    label: 'main',
    dirs: chain.dirs.filter((d) => !blockDirs.has(d)),
    lo: 1,
    hi: blocks.length ? Math.min(...blocks.map((b) => b.lo)) - 1 : Infinity,
    highWater: chain.highWater,
    floor: chain.legacyFloor,
    main: true,
  }
  return [main, ...blocks.map((b) => ({ label: b.dir, dirs: [b.dir], lo: b.lo, hi: b.hi, highWater: b.highWater, floor: 0, main: false, block: b }))]
}

// ------------------------------------------------------------------ glob --

export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else re += '.*'
      } else re += '[^/]*'
    } else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

// ----------------------------------------------------------------- check --

/**
 * The whole register check over one tree state. Pure.
 *
 * @param {object} s
 * @param {object} s.register   parsed ranges.json
 * @param {unknown} s.lock      parsed applied.lock.json, or undefined when absent
 * @param {unknown} s.slugs     parsed stura-only-slugs.json
 * @param {{path: string, bytes: Uint8Array|string}[]} s.files  every tracked *.sql
 * @param {(path: string) => string} s.eolOf  git's `eol` attribute of a path
 * @returns {{code: string, message: string}[]}
 */
export function check({ register, lock, slugs, files, eolOf }) {
  const problems = []
  const p = (code, message) => problems.push({ code, message })
  let reg
  try {
    reg = loadRegister(register, files.map((f) => f.path))
  } catch (err) {
    if (err instanceof RegisterError) return [{ code: err.code, message: err.message }]
    throw err
  }

  // Coverage: every *.sql in exactly one chain's dirs[] or one nonMigration row.
  if (files.length === 0) p('NO_FILES', 'the tree lists zero *.sql files -- the register check would pass vacuously')
  const dirChain = new Map(reg.chains.flatMap((c) => c.dirs.map((d) => [d, c])))
  const globs = reg.nonMigration.map((n) => ({ ...n, re: globToRegExp(n.glob), hits: 0 }))
  const byChain = new Map(reg.chains.map((c) => [c.id, []]))
  const nonMig = new Set()
  for (const f of files) {
    const chain = dirChain.get(posix.dirname(f.path))
    const hits = globs.filter((g) => g.re.test(f.path))
    for (const g of hits) g.hits++
    if (chain && hits.length) p('AMBIGUOUS_FILE', `${f.path} is in chain ${chain.id} and matches nonMigration ${hits[0].glob}`)
    else if (chain) byChain.get(chain.id).push(f)
    else if (hits.length > 1) p('AMBIGUOUS_FILE', `${f.path} matches ${hits.length} nonMigration rows (${hits.map((h) => h.glob).join(', ')})`)
    else if (hits.length === 1) nonMig.add(f.path)
    else p('UNREGISTERED', `${f.path} is in no chain's dirs[] and matches no nonMigration row -- register its directory in ${REGISTER_PATH}`)
  }
  for (const g of globs) if (g.hits === 0) p('STALE_NON_MIGRATION', `nonMigration ${g.glob} matches no file -- remove the row`)

  // Lock shape (fail closed).
  let lockChains = null
  if (lock === undefined) p('LOCK_MISSING', `${LOCK_PATH} is absent -- the lock is read as a failure, never as {}`)
  else if (!lock || typeof lock !== 'object' || Array.isArray(lock) || !lock.chains || typeof lock.chains !== 'object' || Array.isArray(lock.chains) || typeof lock.frozenAt !== 'string')
    p('LOCK_MALFORMED', `${LOCK_PATH} is not {frozenAt, chains: {<chain>: {legacyFloor, legacy, files}}}`)
  else {
    lockChains = lock.chains
    for (const [id, lc] of Object.entries(lockChains)) {
      if (!byChain.has(id)) p('LOCK_UNKNOWN_CHAIN', `${LOCK_PATH} locks chain ${id}, which the register does not declare`)
      if (!lc || typeof lc !== 'object' || !lc.files || typeof lc.files !== 'object' || Array.isArray(lc.files) || Object.values(lc.files).some((h) => typeof h !== 'string' || !SHA256_HEX.test(h))) {
        p('LOCK_MALFORMED', `${LOCK_PATH} chain ${id} is not {legacyFloor, legacy, files: {name: sha256}}`)
        lockChains = null
        break
      }
    }
  }

  // StuRa slugs (fail closed on an empty or malformed list).
  let staSlugs = null
  if (!slugs || !Array.isArray(slugs.slugs) || slugs.slugs.length === 0 || slugs.slugs.some((x) => typeof x !== 'string' || !SLUG.test(x)))
    p('STURA_LIST_INVALID', `${STURA_SLUGS_PATH} lists no slugs -- the StuRa-tree check would pass vacuously`)
  else if (Number.isInteger(slugs.count) && slugs.count !== slugs.slugs.length) p('STURA_LIST_INVALID', `${STURA_SLUGS_PATH} declares ${slugs.count} slugs but lists ${slugs.slugs.length}`)
  else staSlugs = new Set(slugs.slugs)

  for (const c of reg.chains) {
    const cf = byChain.get(c.id)
    const lc = lockChains?.[c.id]
    const where = (f) => `${f.path} (chain ${c.id})`
    if (cf.length === 0) {
      if (c.highWater !== 0 || (c.blocks ?? []).some((b) => b.highWater !== 0)) p('HIGH_WATER_MISMATCH', `chain ${c.id} has no file but a non-zero highWater -- a declared dir may be absent only while highWater is 0`)
      if (lc && Object.keys(lc.files).length) p('LOCKED_FILE_MISSING', `chain ${c.id} has no file but ${LOCK_PATH} locks ${Object.keys(lc.files).join(', ')}`)
    }
    const parsed = []
    const nums = new Map()
    for (const f of cf) {
      const base = posix.basename(f.path)
      const n = parseName(base)
      if (!n) {
        p('BAD_NAME', `${where(f)} is not <number>_<lowercase_slug>.sql`)
        continue
      }
      if (n.digits !== c.padWidth) p('WRONG_PAD', `${where(f)} has ${n.digits} digits; the chain pads to ${c.padWidth}`)
      if (nums.has(n.num)) p('DUPLICATE_NUMBER', `${where(f)} reuses number ${n.num} (also ${nums.get(n.num)})`)
      else nums.set(n.num, f.path)
      if (c.database === 'kernel' && staSlugs?.has(n.slug)) p('STURA_SLUG', `${where(f)} carries the StuRa-only slug ${n.slug} -- B7 T5 / B6 T3-4 must be un-paused before any StuRa migration enters the kernel database`)
      if (eolOf(f.path) !== 'lf') p('EOL_ATTR', `${where(f)} is not eol=lf in .gitattributes (got ${eolOf(f.path) || 'unset'}) -- its lock hash would depend on the checkout`)
      parsed.push({ ...f, base, ...n, dir: posix.dirname(f.path) })
    }
    // lexical order == numeric order over the whole chain
    const lex = [...parsed].sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0)).map((x) => x.base)
    const num = [...parsed].sort((a, b) => a.num - b.num || (a.base < b.base ? -1 : 1)).map((x) => x.base)
    if (lex.join('\n') !== num.join('\n')) {
      const i = lex.findIndex((b, k) => b !== num[k])
      p('ORDER', `chain ${c.id}: filename order differs from numeric order at ${lex[i]} (numeric: ${num[i]}) -- the runner applies in filename order`)
    }
    const legacy = new Set(c.legacy)
    for (const s of sequences(c)) {
      const sf = parsed.filter((x) => s.dirs.includes(x.dir))
      const max = sf.length ? Math.max(...sf.map((x) => x.num)) : 0
      const expectHw = s.main ? max : sf.length ? max : 0
      if (s.highWater !== expectHw) p('HIGH_WATER_MISMATCH', `chain ${c.id} (${s.label}) highWater ${s.highWater} != highest file ${expectHw} -- claim the number with register.mjs claim`)
      for (const x of sf) {
        if (x.num < s.lo || x.num > s.hi) p('OUT_OF_BLOCK', `${x.path} (chain ${c.id}) is numbered ${x.num}, outside ${s.label}'s [${s.lo}, ${s.hi === Infinity ? '...' : s.hi}]`)
        if (x.num <= s.floor && !legacy.has(x.base)) p('NOT_LEGACY', `${x.path} (chain ${c.id}) is numbered ${x.num} <= legacyFloor ${s.floor} but is not in legacy[] -- a new migration claims the next number above the high-water`)
      }
      // above the floor (a block's floor is lo-1) every number is taken, no gap
      const start = s.main ? s.floor + 1 : s.lo
      const above = new Set(sf.filter((x) => x.num >= start).map((x) => x.num))
      for (let n = start; n <= max; n++) {
        if (!above.has(n)) {
          p('GAP', `chain ${c.id} (${s.label}) has no file numbered ${n} below its highest ${max} -- numbers above the legacy floor are claimed in sequence`)
          break
        }
      }
    }
    for (const name of c.legacy) {
      const n = parseName(name)
      if (!n || n.num > c.legacyFloor) p('LEGACY_INVALID', `chain ${c.id} legacy entry ${name} is not a migration name at or below legacyFloor ${c.legacyFloor}`)
    }
    // the lock
    if (lockChains) {
      if (!lc) {
        if (cf.length) p('NOT_LOCKED', `chain ${c.id} has ${cf.length} file(s) but no ${LOCK_PATH} entry -- run register.mjs freeze --chain ${c.id}`)
      } else {
        if (lc.legacyFloor !== c.legacyFloor || !Array.isArray(lc.legacy) || [...lc.legacy].sort(byName).join('\n') !== [...c.legacy].sort(byName).join('\n'))
          p('LEGACY_EDITED', `chain ${c.id} legacyFloor/legacy[] differ from the values frozen in ${LOCK_PATH} -- they are written once and never edited`)
        const present = new Map(parsed.map((x) => [x.base, x]))
        for (const [name, hash] of Object.entries(lc.files)) {
          const x = present.get(name)
          if (!x) p('LOCKED_FILE_MISSING', `${name} (chain ${c.id}) is locked in ${LOCK_PATH} but gone -- an applied migration is never renamed, renumbered or deleted`)
          else if (sha256(x.bytes) !== hash) p('LOCKED_FILE_CHANGED', `${x.path} (chain ${c.id}) no longer matches its locked sha256 -- an applied migration is never edited; write a forward migration`)
        }
        for (const x of parsed) if (!(x.base in lc.files)) p('NOT_LOCKED', `${x.path} (chain ${c.id}) is not in ${LOCK_PATH} -- run register.mjs freeze --chain ${c.id}`)
      }
    }
  }

  // StuRa number blocks: no tracked migration-shaped file outside nonMigration.
  for (const f of files) {
    if (nonMig.has(f.path)) continue
    const n = parseName(posix.basename(f.path))
    if (n && STURA_RANGES.some(([lo, hi]) => n.num >= lo && n.num <= hi))
      p('STURA_RANGE', `${f.path} is numbered ${n.num}, inside a StuRa-tree module block (${STURA_RANGES.map(([a, b]) => `${a}-${b}`).join(', ')})`)
  }
  return problems
}

// ----------------------------------------------------------- claim/freeze --

/** Next filename for a chain sequence; returns the new register (not written). */
export function claim({ register, files, chain, name, dir }) {
  const reg = loadRegister(structuredClone(register), files)
  const c = reg.chains.find((x) => x.id === chain)
  if (!c) throw new RegisterError('UNKNOWN_CHAIN', `no chain ${chain} in the register`)
  if (typeof name !== 'string' || !SLUG.test(name)) throw new RegisterError('BAD_NAME', `--name ${JSON.stringify(name)} is not a lowercase_slug`)
  const seqs = sequences(c)
  const s = dir === undefined ? seqs[0] : seqs.find((x) => x.dirs.includes(dir))
  if (!s || s.dirs.length === 0) throw new RegisterError('UNKNOWN_DIR', `chain ${chain} has no sequence for ${dir ?? 'its main dirs'}`)
  const next = s.main ? s.highWater + 1 : Math.max(s.highWater + 1, s.lo)
  if (next > s.hi) throw new RegisterError('BLOCK_FULL', `chain ${chain} (${s.label}) is full at ${s.hi}`)
  const taken = files.filter((f) => c.dirs.includes(posix.dirname(f))).map((f) => parseName(posix.basename(f))?.num)
  if (taken.includes(next)) throw new RegisterError('DUPLICATE_NUMBER', `chain ${chain} already has a file numbered ${next}; highWater is stale`)
  const filename = `${String(next).padStart(c.padWidth, '0')}_${name}.sql`
  if (s.main) c.highWater = next
  else s.block.highWater = next
  return { filename, dir: s.dirs[0], register: reg }
}

/**
 * Adds the chain's unlocked files to the lock. Never re-hashes: a locked file
 * whose bytes changed, or a locked name with no file, refuses the freeze.
 */
export function freeze({ register, lock, files, chains, frozenAt }) {
  const reg = loadRegister(register)
  const out = lock ? structuredClone(lock) : { frozenAt, hash: 'sha256 of the file bytes; eol=lf makes them the git index blob', chains: {} }
  for (const id of chains) {
    const c = reg.chains.find((x) => x.id === id)
    if (!c) throw new RegisterError('UNKNOWN_CHAIN', `no chain ${id} in the register`)
    const cf = files.filter((f) => c.dirs.includes(posix.dirname(f.path)))
    const lc = (out.chains[id] ??= { legacyFloor: c.legacyFloor, legacy: [...c.legacy].sort(byName), files: {} })
    const present = new Map(cf.map((f) => [posix.basename(f.path), f]))
    for (const [name, hash] of Object.entries(lc.files)) {
      const f = present.get(name)
      if (!f) throw new RegisterError('LOCKED_FILE_MISSING', `${name} (chain ${id}) is locked but gone; freeze never unlocks`)
      if (sha256(f.bytes) !== hash) throw new RegisterError('LOCKED_FILE_CHANGED', `${f.path} changed after it was locked; freeze never re-hashes`)
    }
    for (const [name, f] of [...present].sort(([a], [b]) => (a < b ? -1 : 1))) if (!(name in lc.files)) lc.files[name] = sha256(f.bytes)
    lc.files = Object.fromEntries(Object.entries(lc.files).sort(([a], [b]) => (a < b ? -1 : 1)))
  }
  out.chains = Object.fromEntries(Object.entries(out.chains).sort(([a], [b]) => (a < b ? -1 : 1)))
  return out
}

// -------------------------------------------------------------- the tree --

function git(args, input) {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${(r.stderr || '').trim()}`)
  return r.stdout
}

/** Every *.sql git tracks or would track (untracked, not ignored), present on disk. */
export function treeFiles() {
  const listed = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.sql'])
    .split('\0')
    .filter(Boolean)
  const paths = [...new Set(listed)].filter((p) => existsSync(join(REPO_ROOT, p))).sort(byName)
  return paths.map((path) => ({ path, bytes: readFileSync(join(REPO_ROOT, path)) }))
}

export function treeEol(paths) {
  if (paths.length === 0) return () => ''
  const out = git(['check-attr', '-z', '--stdin', 'eol'], paths.join('\0') + '\0').split('\0')
  const m = new Map()
  for (let i = 0; i + 2 < out.length; i += 3) m.set(out[i], out[i + 2] === 'unspecified' ? '' : out[i + 2])
  return (p) => m.get(p) ?? ''
}

function readJson(rel, { optional = false } = {}) {
  const abs = join(REPO_ROOT, rel)
  if (!existsSync(abs)) {
    if (optional) return undefined
    throw new RegisterError('FILE_MISSING', `${rel} is absent`)
  }
  try {
    return JSON.parse(readFileSync(abs, 'utf8'))
  } catch {
    return null
  }
}

export function treeState() {
  const files = treeFiles()
  return {
    register: readJson(REGISTER_PATH),
    lock: readJson(LOCK_PATH, { optional: true }),
    slugs: readJson(STURA_SLUGS_PATH, { optional: true }),
    files,
    eolOf: treeEol(files.map((f) => f.path)),
  }
}

const writeJson = (rel, obj) => writeFileSync(join(REPO_ROOT, rel), `${JSON.stringify(obj, null, 2)}\n`)

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

export function main(argv) {
  const [cmd] = argv
  if (cmd === 'check') {
    const s = treeState()
    const problems = check(s)
    if (problems.length) {
      console.error(`[migration-register] ${problems.length} problem(s):`)
      for (const x of problems) console.error(`  x ${x.code} ${x.message.replace(/^[A-Z_]+: /, '')}`)
      return 1
    }
    const reg = s.register
    const chainFiles = s.files.filter((f) => reg.chains.some((c) => c.dirs.includes(posix.dirname(f.path)))).length
    console.log(`[migration-register] OK -- ${s.files.length} *.sql file(s): ${chainFiles} in ${reg.chains.length} chain(s), ${s.files.length - chainFiles} declared non-migration; every chain file padded, in order, claimed, locked and eol=lf`)
    return 0
  }
  if (cmd === 'claim') {
    const chain = arg(argv, '--chain')
    const name = arg(argv, '--name')
    const s = treeState()
    const r = claim({ register: s.register, files: s.files.map((f) => f.path), chain, name, dir: arg(argv, '--dir') })
    writeJson(REGISTER_PATH, r.register)
    console.log(`${r.dir}/${r.filename}`)
    return 0
  }
  if (cmd === 'freeze') {
    const s = treeState()
    if (s.lock === null) throw new RegisterError('LOCK_MALFORMED', `${LOCK_PATH} is not JSON; fix it by hand, freeze never overwrites it`)
    const reg = loadRegister(s.register)
    const chains = argv.includes('--all') ? reg.chains.map((c) => c.id) : [arg(argv, '--chain')]
    if (chains.some((c) => !c)) throw new RegisterError('USAGE', 'freeze needs --chain <id> or --all')
    const frozenAt = new Date().toISOString().slice(0, 10)
    writeJson(LOCK_PATH, freeze({ register: s.register, lock: s.lock, files: s.files, chains, frozenAt }))
    console.log(`[migration-register] froze ${chains.join(', ')}`)
    return 0
  }
  console.error('usage: register.mjs check | claim --chain <id> --name <slug> [--dir <dir>] | freeze --chain <id>|--all')
  return 2
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (err) {
    console.error(`[migration-register] ${err.message}`)
    process.exitCode = 1
  }
}
