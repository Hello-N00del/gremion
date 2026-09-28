// Types for verify-applied.mjs (TASK-029), so the TypeScript services and the
// tenant-store fixture service import the one boot verifier.
export const LEDGER: string

export interface VerifyProblem {
  code: string
  file: string
  detail?: string
}

export class VerifyAppliedError extends Error {
  problems: VerifyProblem[]
}

export interface ChainFile {
  dir: string
  manifest: string | undefined
  actual: string
}

export function readChain(dirs: string[]): { files: Map<string, ChainFile>; problems: VerifyProblem[] }

// postgres-js Sql (or any tagged template answering the three ledger queries)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TaggedSql = (strings: TemplateStringsArray, ...values: any[]) => any

export function readLedger(sql: TaggedSql): Promise<{ rows: { filename: string; sha256: string | null }[] | null; hasHash: boolean }>

export function compareLedger(o: {
  rows: { filename: string; sha256: string | null }[] | null
  hasHash: boolean
  chain: Map<string, ChainFile>
  skips?: string[]
  requireComplete?: boolean
}): VerifyProblem[]

export function verifyApplied(o: {
  sql: TaggedSql
  dirs: string[]
  skips?: string[]
  requireComplete?: boolean
  log?: (line: string) => void
}): Promise<{ rows: number; verified: string[] }>
