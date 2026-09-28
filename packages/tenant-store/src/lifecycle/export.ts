// packages/tenant-store/src/lifecycle/export.ts
//
// TRD-424: a (tenant, module) database is exported BEFORE it is dropped, and
// the export is verified before the drop may run: the archive exists, is
// larger than zero bytes, `pg_restore --list` parses it and names the right
// database, and its sha256 is recorded in plt.module_database. The dump is a
// custom-format pg_dump (an [A] choice; the open-format export is TASK-091's).
// At rest: mode 0600 under <exportDir>/<tenant>/<module>/ (Q7; encryption
// follows the backup-host contract, TASK-089).
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, createReadStream, createWriteStream, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Exporter, ExportTarget } from './types.js'
import { LifecycleError } from './guards.js'

export interface PgDumpExporterOptions {
  /** argv prefix of pg_dump, e.g. ['pg_dump'] or ['docker', 'exec', '-i', '<container>', 'pg_dump']. PostgreSQL 18. */
  pgDump: readonly string[]
  /** argv prefix of pg_restore, the same way. */
  pgRestore: readonly string[]
  /** Connection arguments (and environment, e.g. PGPASSWORD) for one target. Never logged. */
  connection(target: ExportTarget): { args: string[]; env?: Record<string, string> }
}

function run(argv: readonly string[], opts: { env?: Record<string, string>; stdin?: string; stdout?: string }): Promise<string> {
  const [cmd, ...args] = argv
  if (!cmd) return Promise.reject(new Error('empty command'))
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const errChunks: Buffer[] = []
    const outChunks: Buffer[] = []
    let sink: ReturnType<typeof createWriteStream> | undefined
    let sinkDone: Promise<void> = Promise.resolve()
    if (opts.stdout) {
      // wx: never overwrite; 0600 from the first byte.
      const s = createWriteStream(opts.stdout, { flags: 'wx', mode: 0o600 })
      sink = s
      sinkDone = new Promise((res, rej) => {
        s.on('finish', () => res())
        s.on('error', rej)
      })
      child.stdout.pipe(s)
    } else {
      child.stdout.on('data', (c: Buffer) => outChunks.push(c))
    }
    child.stderr.on('data', (c: Buffer) => errChunks.push(c))
    if (opts.stdin) {
      const input = createReadStream(opts.stdin)
      input.on('error', reject)
      input.pipe(child.stdin)
    } else {
      child.stdin.end()
    }
    child.on('error', reject)
    child.on('close', (code) => {
      sinkDone.then(
        () => {
          if (code !== 0) {
            const tail = Buffer.concat(errChunks).toString('utf8').trim().split('\n').slice(-3).join(' | ')
            reject(new Error(`${basename(cmd)} exited ${code}${tail ? `: ${tail}` : ''}`))
          } else {
            resolve(Buffer.concat(outChunks).toString('utf8'))
          }
        },
        (err: unknown) => reject(err),
      )
    })
    void sink
  })
}

/** The production Exporter: pg_dump -Fc to the file (via stdout), pg_restore --list from it (via stdin). */
export function pgDumpExporter(opts: PgDumpExporterOptions): Exporter {
  return {
    async dump(target, file) {
      const conn = opts.connection(target)
      await run([...opts.pgDump, '--format=custom', '--no-password', ...conn.args], { stdout: file, ...(conn.env ? { env: conn.env } : {}) })
    },
    async list(file) {
      return run([...opts.pgRestore, '--list'], { stdin: file })
    },
  }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
}

export interface VerifiedExport {
  path: string
  sha256: string
  bytes: number
}

/** 2026-09-28T06:30:00.123Z -> 20260928T063000123Z (sortable, no separators a path would mind). */
export function exportStamp(d: Date): string {
  return d.toISOString().replace(/[-:.]/g, '')
}

/**
 * Dumps `database`, then verifies it (size > 0, pg_restore --list parses it
 * and names the database) and writes <file>.sha256 beside it. Throws a
 * LifecycleError on any failure; nothing has been dropped at that point.
 */
export async function exportDatabase(
  exporter: Exporter,
  target: ExportTarget,
  where: { exportDir: string; tenantId: string; moduleId: string },
  now: Date = new Date(),
): Promise<VerifiedExport> {
  const dir = join(where.exportDir, where.tenantId, where.moduleId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${exportStamp(now)}.dump`)
  try {
    await exporter.dump(target, path)
  } catch (err) {
    throw new LifecycleError('EXPORT_FAILED', `the export of ${target.database} failed: ${(err as Error).message}`, { cause: err })
  }
  let bytes: number
  try {
    bytes = statSync(path).size
  } catch (err) {
    throw new LifecycleError('EXPORT_UNVERIFIED', `the export of ${target.database} wrote no file at ${path}`, { cause: err })
  }
  if (bytes <= 0) throw new LifecycleError('EXPORT_UNVERIFIED', `the export of ${target.database} is empty (0 bytes): ${path}`)
  chmodSync(path, 0o600)
  let toc: string
  try {
    toc = await exporter.list(path)
  } catch (err) {
    throw new LifecycleError('EXPORT_UNVERIFIED', `pg_restore --list cannot read the export of ${target.database}: ${(err as Error).message}`, { cause: err })
  }
  if (!/^; Archive created at /m.test(toc) || !new RegExp(`^;\\s+dbname: ${target.database}$`, 'm').test(toc)) {
    throw new LifecycleError('EXPORT_UNVERIFIED', `pg_restore --list of ${path} does not describe a dump of ${target.database}`)
  }
  const sha256 = await sha256File(path)
  writeFileSync(`${path}.sha256`, `${sha256}  ${basename(path)}\n`, { mode: 0o600, flag: 'wx' })
  return { path, sha256, bytes }
}
