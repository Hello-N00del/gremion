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

export const DEFAULT_HOSTD_SOCKET = '/run/gremion/hostd.sock'
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

export function hostdSocketPath(env: Record<string, string | undefined>): string {
  const configured = env.GREMION_HOSTD_SOCKET?.trim()
  return configured ? configured : DEFAULT_HOSTD_SOCKET
}

export function backupTimeoutMs(env: Record<string, string | undefined>): number {
  const n = Number(env.GREMION_HOSTD_BACKUP_TIMEOUT_MS)
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : DEFAULT_BACKUP_TIMEOUT_MS
}

export interface TriggerAvailability {
  available: boolean
  reason?: string
}

/** Cheap, side-effect-free check used by GET (the real proof is the connect in POST). */
export function hostdAvailability(path: string): TriggerAvailability {
  if (!existsSync(path)) {
    return {
      available: false,
      reason:
        'Der Host-Dienst (hostd) ist nicht erreichbar: sein Socket fehlt. ' +
        'Auf diesem System kann kein Backup ausgelöst werden.',
    }
  }
  return { available: true }
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
