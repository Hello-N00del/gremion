// packages/tenant-store/src/dump/errors.ts
//
// The one error type of the dump code. It lives in its own file so that ledger.ts and safefs.ts (which each
// need it, and ledger.ts needs safefs.ts) do not import one another in a circle. ledger.ts re-exports both
// names: every importer of './ledger.js' keeps working.

export type DumpErrorCode =
  | 'RELEASE_INVALID'
  | 'DUMP_DIR_UNSET'
  | 'DUMP_DIR_INVALID'
  | 'DUMP_DIR_MODE'
  | 'DUMP_DIR_OWNER'
  | 'DUMP_SERIES'
  | 'DUMP_SPACE'
  | 'PG_DUMP_VERSION'
  | 'PG_DUMP_FAILED'
  | 'DUMP_UNVERIFIED'
  | 'DUMP_SCOPE'
  | 'DUMP_PATH_UNSAFE'
  | 'LEDGER_LOCKED'
  | 'LEDGER_CORRUPT'
  | 'LEDGER_UNWRITABLE'

export class DumpError extends Error {
  override name = 'DumpError'
  code: DumpErrorCode
  constructor(code: DumpErrorCode, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options)
    this.code = code
  }
}
