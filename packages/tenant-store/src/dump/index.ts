// @gremion/tenant-store/dump — TASK-075's pre-migration dump, importable by a
// service's own migrate command (TASK-077 G3, lane note C6). The kernel API's
// `kernel-api migrate` composes chainPreApply + dumpHook through
// migratePreApply exactly as cli.ts migrate does, then adds its own
// SET ROLE hook; scopeOf already maps t_<hex32>__kernel to a customer dump.
export { dumpTools, migratePreApply, parsePgDumpMajor } from './cli.js'
export type { CliDeps, CliIo } from './cli.js'
export { composePreApply, dumpHook, scopeOf } from './hook.js'
export type { DumpHookOptions, PreApply } from './hook.js'
export { AUDIT_TAG, DumpError, LEDGER_FILE } from './ledger.js'
export type { ByKind, DumpErrorCode, DumpEvent, DumpScope } from './ledger.js'
export { checkDumpDir, defaultDumpFs, takeDump } from './take.js'
export type { DumpFs, DumpProbe, TakeDumpOptions, TakenDump } from './take.js'
