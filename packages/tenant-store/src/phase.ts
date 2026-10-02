// packages/tenant-store/src/phase.ts
//
// TASK-075 (TRD-361): the expand / migrate / contract phase of one migration
// file, and the release a contract waits for. A file declares its phase on its
// FIRST line:
//
//   -- gremion:phase expand|migrate|contract
//   -- gremion:contract-after dist-vX.Y.Z      (contract only: the release that
//                                              no longer reads what it drops)
//   -- gremion:manual-dump <runbook step>      (a chain no runner dumps yet)
//
// Files that were locked before the header existed (scripts/migrations/
// applied.lock.json) are never re-hashed to gain one: their phase comes from
// scripts/migrations/runner/expand-contract-baseline.json instead, and a
// baseline file whose bytes no longer match the lock is LOCKED_FILE_CHANGED.
// The runtime reads that baseline from ./phase-baseline.ts (PINNED_BASELINE,
// generated from the two kernel files, drift-checked by the expand-contract
// suite), which ships inside this package: the tenant-create image has no
// scripts/ directory (TASK-075 r2).
//
// Deliberately free of relative imports and of TypeScript-only runtime syntax
// (no enums, no parameter properties): scripts/migrations/runner/lint.mjs loads
// this file directly under Node's type stripping.
import { createHash } from 'node:crypto'

export const PHASES = ['expand', 'migrate', 'contract'] as const
export type Phase = (typeof PHASES)[number]

export interface PhaseInfo {
  phase: Phase
  /** contract only: the dist-v* release after which the contract may run. */
  contractAfter?: string | null
}

export type PhaseErrorCode = 'PHASE_MISSING' | 'PHASE_MALFORMED' | 'CONTRACT_AFTER_MISSING' | 'LOCKED_FILE_CHANGED'

export class PhaseError extends Error {
  override name = 'PhaseError'
  code: PhaseErrorCode
  file: string
  constructor(code: PhaseErrorCode, file: string, message: string) {
    super(`${code}: ${file}: ${message}`)
    this.code = code
    this.file = file
  }
}

export const PHASE_LINE = /^-- gremion:phase (expand|migrate|contract)[ \t]*$/
export const CONTRACT_AFTER_LINE = /^-- gremion:contract-after (dist-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))[ \t]*$/
export const MANUAL_DUMP_LINE = /^-- gremion:manual-dump[ \t]+(\S.*?)[ \t]*$/
export const DIST_TAG = /^dist-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** What a baseline contract waits for: every baseline file predates every release. */
export const BASELINE_CONTRACT_AFTER = 'dist-v0.0.0'

export interface MigrationHeader {
  phase: Phase | null
  contractAfter: string | null
  manualDump: string | null
  /** Malformed or misplaced markers; non-empty means the header is not usable. */
  problems: string[]
}

/**
 * Reads the header block (the leading comment and blank lines). The phase
 * marker must be the very first line; the other markers may sit anywhere in
 * the block. A `gremion:` marker that does not parse is a problem, never
 * silently ignored.
 */
export function parseHeader(text: string): MigrationHeader {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const out: MigrationHeader = { phase: null, contractAfter: null, manualDump: null, problems: [] }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') continue
    if (!line.startsWith('--')) break
    if (!/^--\s*gremion:/.test(line)) continue
    const phase = PHASE_LINE.exec(line)
    if (phase) {
      if (i !== 0) out.problems.push(`line ${i + 1}: the phase marker must be the first line of the file`)
      else out.phase = phase[1] as Phase
      continue
    }
    const after = CONTRACT_AFTER_LINE.exec(line)
    if (after) {
      if (out.contractAfter !== null) out.problems.push(`line ${i + 1}: a second contract-after marker`)
      out.contractAfter = after[1]!
      continue
    }
    const dump = MANUAL_DUMP_LINE.exec(line)
    if (dump) {
      if (out.manualDump !== null) out.problems.push(`line ${i + 1}: a second manual-dump marker`)
      out.manualDump = dump[1]!
      continue
    }
    out.problems.push(`line ${i + 1}: unrecognised marker ${JSON.stringify(line.slice(0, 60))}`)
  }
  if (out.contractAfter !== null && out.phase !== 'contract') out.problems.push('contract-after on a file whose phase is not contract')
  return out
}

/** The phase a file's own header declares, or null when it declares none. Throws on a malformed header. */
export function headerPhase(file: string, text: string): PhaseInfo | null {
  const h = parseHeader(text)
  if (h.problems.length) throw new PhaseError('PHASE_MALFORMED', file, h.problems.join('; '))
  if (h.phase === null) return null
  if (h.phase === 'contract') {
    if (h.contractAfter === null) throw new PhaseError('CONTRACT_AFTER_MISSING', file, 'a contract file needs -- gremion:contract-after dist-vX.Y.Z')
    return { phase: 'contract', contractAfter: h.contractAfter }
  }
  return { phase: h.phase }
}

/** [major, minor, patch] of `dist-vX.Y.Z`, `vX.Y.Z` or `X.Y.Z`; null otherwise. */
export function releaseVersion(ref: string | null | undefined): [number, number, number] | null {
  if (typeof ref !== 'string') return null
  const m = /^(?:dist-)?v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(ref)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Semver order of two release refs; throws on one that is not X.Y.Z-shaped. */
export function compareReleases(a: string, b: string): number {
  const x = releaseVersion(a)
  const y = releaseVersion(b)
  if (!x || !y) throw new TypeError(`not a release: ${JSON.stringify(x ? b : a)}`)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  return 0
}

export function sha256Text(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex')
}

export interface BaselineData {
  chains: Record<string, Record<string, Phase>>
}

export interface LockData {
  chains: Record<string, { files: Record<string, string> }>
}

export type PhaseFor = (file: string, text: string) => PhaseInfo | undefined

/**
 * The baseline lookup for one chain: a file the baseline maps AND the lock
 * pins gets its mapped phase, if its bytes still hash to the lock's sha256.
 */
export function baselinePhaseFor(chain: string, baseline: BaselineData, lock: LockData): PhaseFor {
  const map = baseline.chains?.[chain] ?? {}
  const locked = lock.chains?.[chain]?.files ?? {}
  return (file, text) => {
    const phase = map[file]
    if (phase === undefined) return undefined
    if (!(PHASES as readonly string[]).includes(phase)) throw new PhaseError('PHASE_MALFORMED', file, `baseline phase ${JSON.stringify(phase)}`)
    const pinned = locked[file]
    if (pinned === undefined) throw new PhaseError('LOCKED_FILE_CHANGED', file, `in the baseline of ${chain} but not in applied.lock.json`)
    if (sha256Text(text) !== pinned) throw new PhaseError('LOCKED_FILE_CHANGED', file, `its bytes no longer hash to the sha256 applied.lock.json pinned for ${chain}: a locked file is never re-hashed (not even to add a phase header)`)
    return phase === 'contract' ? { phase, contractAfter: BASELINE_CONTRACT_AFTER } : { phase }
  }
}

/** Per chain, per baseline file: its phase and the sha256 applied.lock.json pins for it. */
export type PinnedBaseline = Record<string, Record<string, { phase: Phase; sha256: string }>>

/**
 * The baseline joined with the lock, as ./phase-baseline.ts ships it. Throws
 * LOCKED_FILE_CHANGED for a baseline file the lock does not pin (the suite
 * reports the same as a problem). Keys sorted, so the rendering is stable.
 */
export function pinBaseline(baseline: BaselineData, lock: LockData): PinnedBaseline {
  const out: PinnedBaseline = {}
  for (const chain of Object.keys(baseline.chains ?? {}).sort()) {
    const map = baseline.chains[chain]!
    const locked = lock.chains?.[chain]?.files ?? {}
    const files: PinnedBaseline[string] = {}
    for (const file of Object.keys(map).sort()) {
      const sha256 = locked[file]
      if (sha256 === undefined) throw new PhaseError('LOCKED_FILE_CHANGED', file, `in the baseline of ${chain} but not in applied.lock.json`)
      files[file] = { phase: map[file]!, sha256 }
    }
    out[chain] = files
  }
  return out
}

/** The baseline lookup for one chain from a pinned baseline (the one shipped in ./phase-baseline.ts). */
export function pinnedPhaseFor(chain: string, pinned: PinnedBaseline): PhaseFor {
  const entries = Object.entries(pinned[chain] ?? {})
  return baselinePhaseFor(
    chain,
    { chains: { [chain]: Object.fromEntries(entries.map(([f, e]) => [f, e.phase])) } },
    { chains: { [chain]: { files: Object.fromEntries(entries.map(([f, e]) => [f, e.sha256])) } } },
  )
}

/** Header first, then `phaseFor` (the baseline), else PHASE_MISSING. */
export function resolvePhase(file: string, text: string, phaseFor?: PhaseFor): PhaseInfo {
  const fromHeader = headerPhase(file, text)
  if (fromHeader) return fromHeader
  const fromBaseline = phaseFor?.(file, text)
  if (fromBaseline) {
    if (fromBaseline.phase === 'contract' && !fromBaseline.contractAfter) throw new PhaseError('CONTRACT_AFTER_MISSING', file, 'the phase lookup returned contract without contractAfter')
    return fromBaseline
  }
  throw new PhaseError('PHASE_MISSING', file, 'no -- gremion:phase header on the first line and no baseline entry')
}
