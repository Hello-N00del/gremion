// pgDumpExporter's process plumbing, against stub commands (node -e) instead
// of pg_dump/pg_restore: no database, no Docker. Round-2 regressions for the
// two HIGH house findings on export.ts run():
//   1. pg_restore --list reads only the archive header and TOC, then exits.
//      Piping a dump larger than the pipe buffer into its stdin then fails
//      with EPIPE (Linux) or EOF (Windows); that must not be an uncaught
//      exception, and the exit code decides success.
//   2. A sink error (EEXIST from 'wx', EACCES, ENOSPC) must reject dump(),
//      never become an unhandled rejection, and never leave pg_dump blocked
//      on a full stdout pipe.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pgDumpExporter } from './export.js'

const SCRATCH = join(fileURLToPath(new URL('../../../../.scratch/', import.meta.url)), `t021-export-${process.pid}`)
mkdirSync(SCRATCH, { recursive: true })
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

const TARGET = { service: 'board-postgres', database: 't_0192f0c12b3c7d4e8f00112233445566__board' }
const TOC = `;\n; Archive created at 2026-09-28 06:00:00 UTC\n;     dbname: ${TARGET.database}\n`
const MB = 1024 * 1024

/** argv prefix running `code` in a fresh node; `--` keeps the exporter's appended flags away from node's option parser. */
const node = (code: string): string[] => [process.execPath, '-e', code, '--']

/** A pg_restore that prints the TOC WITHOUT reading stdin, then exits `code`. */
const restoreThatStopsReading = (exitCode: number, stderr = '') =>
  node(
    `process.stderr.write(${JSON.stringify(stderr)});` +
      `process.stdout.write(${JSON.stringify(TOC)}, () => process.exit(${exitCode}))`,
  )

/** A pg_dump that records that it ran (STUB_MARKER), writes `bytes` to stdout, then exits `code`. */
const dumpWriting = (bytes: number, exitCode = 0, stderr = '') =>
  node(
    `if (process.env.STUB_MARKER) require('fs').writeFileSync(process.env.STUB_MARKER, 'ran');` +
      `process.stderr.write(${JSON.stringify(stderr)});` +
      `process.stdout.write(Buffer.alloc(${bytes}, 0x50), () => process.exit(${exitCode}))`,
  )

let strays: unknown[] = []
const onStray = (err: unknown) => strays.push(err)
beforeEach(() => {
  strays = []
  process.on('uncaughtException', onStray)
  process.on('unhandledRejection', onStray)
})
afterEach(() => {
  process.off('uncaughtException', onStray)
  process.off('unhandledRejection', onStray)
})
/** Give a late EPIPE/EOF or rejection time to surface before asserting there was none. */
const settle = () => new Promise((r) => setTimeout(r, 400))

function exporter(over: { pgDump?: string[]; pgRestore?: string[]; env?: Record<string, string> } = {}) {
  return pgDumpExporter({
    pgDump: over.pgDump ?? dumpWriting(16),
    pgRestore: over.pgRestore ?? restoreThatStopsReading(0),
    connection: () => ({ args: ['--dbname', TARGET.database], ...(over.env ? { env: over.env } : {}) }),
  })
}

describe('pgDumpExporter list(): pg_restore --list stops reading after the TOC (house finding 1)', () => {
  it('a 4 MB archive: the TOC comes back and nothing is thrown past the promise', async () => {
    const file = join(SCRATCH, 'big-list.dump')
    writeFileSync(file, Buffer.alloc(4 * MB, 0x41))
    await expect(exporter().list(file)).resolves.toBe(TOC)
    await settle()
    expect(strays).toEqual([])
  }, 20_000)

  it('the exit code decides: a pg_restore that stops reading and exits 1 rejects, still with no stray error', async () => {
    const file = join(SCRATCH, 'big-list-bad.dump')
    writeFileSync(file, Buffer.alloc(4 * MB, 0x42))
    await expect(exporter({ pgRestore: restoreThatStopsReading(1, 'pg_restore: error: not a valid archive') }).list(file)).rejects.toThrow(/exited 1: pg_restore: error: not a valid archive/)
    await settle()
    expect(strays).toEqual([])
  }, 20_000)

  it('a missing archive rejects with the read error', async () => {
    await expect(exporter().list(join(SCRATCH, 'no-such.dump'))).rejects.toMatchObject({ code: 'ENOENT' })
    await settle()
    expect(strays).toEqual([])
  }, 20_000)
})

describe('pgDumpExporter dump(): the sink (house finding 2)', () => {
  it('writes pg_dump stdout (2 MB) to the file and resolves on exit 0', async () => {
    const file = join(SCRATCH, 'ok.dump')
    await exporter({ pgDump: dumpWriting(2 * MB) }).dump(TARGET, file)
    expect(statSync(file).size).toBe(2 * MB)
    // Mode 0600 (brief Q7): no group/other bits. Windows has no POSIX mode
    // bits to check, so there the value is pinned to 0; the assertion itself
    // is unconditional (vitest/no-conditional-expect).
    const groupOtherBits = process.platform === 'win32' ? 0 : statSync(file).mode & 0o077
    expect(groupOtherBits).toBe(0)
    await settle()
    expect(strays).toEqual([])
  }, 20_000)

  it('a pre-existing target: rejects EEXIST, keeps the file, never starts pg_dump, no unhandled rejection', async () => {
    const file = join(SCRATCH, 'exists.dump')
    const marker = join(SCRATCH, 'exists.marker')
    writeFileSync(file, 'earlier export')
    const started = Date.now()
    await expect(exporter({ pgDump: dumpWriting(4 * MB), env: { STUB_MARKER: marker } }).dump(TARGET, file)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(readFileSync(file, 'utf8')).toBe('earlier export')
    expect(existsSync(marker)).toBe(false)
    await settle()
    expect(strays).toEqual([])
  }, 20_000)

  it('an export directory that does not exist rejects ENOENT before pg_dump starts', async () => {
    const marker = join(SCRATCH, 'nodir.marker')
    await expect(exporter({ pgDump: dumpWriting(4 * MB), env: { STUB_MARKER: marker } }).dump(TARGET, join(SCRATCH, 'no-dir', 'x.dump'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(existsSync(marker)).toBe(false)
    await settle()
    expect(strays).toEqual([])
  }, 20_000)

  it('pg_dump exiting non-zero rejects with its stderr tail', async () => {
    const file = join(SCRATCH, 'fail.dump')
    await expect(exporter({ pgDump: dumpWriting(1024, 3, 'pg_dump: error: connection refused') }).dump(TARGET, file)).rejects.toThrow(/exited 3: pg_dump: error: connection refused/)
    await settle()
    expect(strays).toEqual([])
  }, 20_000)

  it('a command that cannot be started rejects instead of hanging', async () => {
    const file = join(SCRATCH, 'nocmd.dump')
    await expect(exporter({ pgDump: [join(SCRATCH, 'no-such-pg_dump')] }).dump(TARGET, file)).rejects.toMatchObject({ code: 'ENOENT' })
    await settle()
    expect(strays).toEqual([])
  }, 20_000)
})
