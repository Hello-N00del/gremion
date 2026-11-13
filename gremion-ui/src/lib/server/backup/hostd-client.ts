// Server-side client for gremion-hostd's unix socket (F1-FIX-10-K, D-4).
//
// Protocol (infra/host/bin/gremion-hostd): one request line in, the program's
// merged output streamed back line by line, then a final `EXIT <code>`, then the
// connection closes. The backup verb takes no arguments. gremion-backup ends with
// one machine-readable line before hostd's EXIT line (R29-F1-WAVE2/addendum.md):
//
//   BACKUP-RESULT {"state":"finished"|"failed","startedAt":ISO,"finishedAt":ISO,"exitCode":N}
//
// This module never reports success it did not read: no EXIT line, a dropped
// connection or a timeout is a FAILED outcome, never a finished one.
import net from 'node:net'
import { existsSync } from 'node:fs'

/** A backup (dumps + restic + off-site mirror) may legitimately run for hours. */
export const DEFAULT_BACKUP_TIMEOUT_MS = 6 * 60 * 60 * 1000
const CONNECT_TIMEOUT_MS = 3000
const MAX_KEPT_LINES = 200
const MAX_LINE_CHARS = 500

export interface BackupResultLine {
  state: 'finished' | 'failed'
  startedAt: string
  finishedAt: string
  exitCode: number
}

export interface HostdOutcome {
  /** The `EXIT <code>` value, or null when the connection ended without one. */
  exitCode: number | null
  result: BackupResultLine | null
  timedOut: boolean
  /** Last lines of hostd's output, for diagnostics only. */
  tail: string[]
}

export class HostdUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostdUnreachableError'
  }
}

/**
 * The socket of the host daemon this installation names, or null when it names
 * none. The daemon is optional and only an explicit GREMION_HOSTD_SOCKET says
 * that this installation uses it: no built-in path is ever probed, so what
 * happens to exist on the machine cannot change the answer, and a daemon that
 * stops cannot turn "uses the daemon" into "does not".
 */
export function hostdSocketPath(env: Record<string, string | undefined>): string | null {
  const configured = env.GREMION_HOSTD_SOCKET?.trim()
  return configured ? configured : null
}

export function backupTimeoutMs(env: Record<string, string | undefined>): number {
  const n = Number(env.GREMION_HOSTD_BACKUP_TIMEOUT_MS)
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : DEFAULT_BACKUP_TIMEOUT_MS
}

/**
 * `not_configured`: no host daemon is named, so backups are not managed from the
 * app here. That is a normal way to run an installation, not a fault.
 * `unreachable`: a daemon is named but cannot be used, which is a fault.
 */
export type TriggerState = 'available' | 'not_configured' | 'unreachable'

export interface TriggerAvailability {
  available: boolean
  state: TriggerState
  reason?: string
}

export const BACKUPS_NOT_MANAGED_REASON =
  'Auf dieser Installation werden Backups nicht aus der App gesteuert. ' +
  'Der Betreiber führt sie außerhalb der App aus.'

/** Says nothing about where the daemon is looked for: that is an internal detail. */
export const HOSTD_UNREACHABLE_REASON =
  'Der Host-Dienst (hostd) ist nicht erreichbar. Aus der App kann derzeit kein Backup ausgelöst werden.'

/**
 * Cheap, side-effect-free check used by GET (the real proof is the connect in POST).
 * `path` is null where the installation names no host daemon. Only the socket's
 * presence is looked at here: a present socket that then refuses the connection
 * is reported by the POST that tries it.
 */
export function hostdAvailability(path: string | null): TriggerAvailability {
  if (path === null) return { available: false, state: 'not_configured', reason: BACKUPS_NOT_MANAGED_REASON }
  if (existsSync(path)) return { available: true, state: 'available' }
  return { available: false, state: 'unreachable', reason: HOSTD_UNREACHABLE_REASON }
}

export function connectHostd(path: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(path)
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new HostdUnreachableError('Der Host-Dienst (hostd) antwortet nicht (Verbindungs-Timeout).'))
    }, timeoutMs)
    sock.once('connect', () => {
      clearTimeout(timer)
      sock.removeAllListeners('error')
      resolve(sock)
    })
    sock.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(new HostdUnreachableError(`Der Host-Dienst (hostd) ist nicht erreichbar (${err.code ?? 'Verbindungsfehler'}).`))
    })
  })
}

function parseBackupResult(line: string): BackupResultLine | null {
  const m = /^BACKUP-RESULT (\{.*\})\s*$/.exec(line)
  if (!m) return null
  let raw: unknown
  try {
    raw = JSON.parse(m[1]!)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.state !== 'finished' && r.state !== 'failed') return null
  if (typeof r.startedAt !== 'string' || Number.isNaN(Date.parse(r.startedAt))) return null
  if (typeof r.finishedAt !== 'string' || Number.isNaN(Date.parse(r.finishedAt))) return null
  if (typeof r.exitCode !== 'number' || !Number.isInteger(r.exitCode)) return null
  return { state: r.state, startedAt: r.startedAt, finishedAt: r.finishedAt, exitCode: r.exitCode }
}

/**
 * Send one verb on an open hostd connection and read the answer to the end.
 * Resolves (never rejects) with what was actually observed.
 */
export function runHostdVerb(sock: net.Socket, verb: string, timeoutMs: number): Promise<HostdOutcome> {
  return new Promise((resolve) => {
    const tail: string[] = []
    let result: BackupResultLine | null = null
    let exitCode: number | null = null
    let pending = ''
    let settled = false

    const onLine = (rawLine: string) => {
      const line = rawLine.replace(/\r$/, '')
      const parsed = parseBackupResult(line)
      if (parsed) result = parsed
      const exit = /^EXIT (\d+)$/.exec(line)
      if (exit) exitCode = Number(exit[1])
      tail.push(line.slice(0, MAX_LINE_CHARS))
      if (tail.length > MAX_KEPT_LINES) tail.shift()
    }

    const finish = (timedOut: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (pending) onLine(pending)
      pending = ''
      sock.destroy()
      resolve({ exitCode, result, timedOut, tail })
    }

    const timer = setTimeout(() => finish(true), timeoutMs)

    sock.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      let nl = pending.indexOf('\n')
      while (nl >= 0) {
        onLine(pending.slice(0, nl))
        pending = pending.slice(nl + 1)
        nl = pending.indexOf('\n')
      }
      if (pending.length > 64 * 1024) pending = pending.slice(-MAX_LINE_CHARS)
    })
    sock.on('end', () => finish(false))
    sock.on('close', () => finish(false))
    sock.on('error', () => finish(false))
    sock.write(`${verb}\n`)
  })
}
