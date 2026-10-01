// Backup trigger + run-state (F1-FIX-10-K, H04, D-4 = WIRE IT).
//
// POST /api/settings/backup calls hostd's `backup` verb; this module records the
// run (started -> finished | failed, with times) and is the ONLY place that
// stamps config.backups.last_backup_at, and only from a finished run.
// Trigger contract: R29-F1-WAVE2/addendum.md ("D-4 trigger contract", KERNEL).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type net from 'node:net'
import {
  connectHostd,
  hostdAvailability,
  HostdUnreachableError,
  runHostdVerb,
  type HostdOutcome,
  type TriggerAvailability,
} from './hostd-client'

export type BackupRunState = 'started' | 'finished' | 'failed'

export interface BackupRunRecord {
  id: string
  state: BackupRunState
  requestedBy: string | null
  startedAt: string
  finishedAt?: string
  exitCode?: number | null
  error?: string
}

export class BackupTriggerError extends Error {
  constructor(
    public readonly code: 'unavailable' | 'busy',
    message: string,
  ) {
    super(message)
    this.name = 'BackupTriggerError'
  }
}

export interface BackupDeps {
  socketPath: string
  runsDir: string
  timeoutMs: number
  /** Stamps config.backups.last_backup_at for the request's tenant. */
  stampLastBackup: (iso: string) => void
  connect?: (path: string) => Promise<net.Socket>
  now?: () => Date
}

const KEEP_RUNS = 30
const RUN_FILE_RE = /^run-([0-9a-f-]{36})\.json$/

// One in-flight run per runs directory (= per tenant) in this process. A fresh
// process starts empty, which is how a `started` record left by a dead process is
// told apart from a run that is really still going.
const active = new Map<string, string>()

function runPath(dir: string, id: string): string {
  return join(dir, `run-${id}.json`)
}

function writeRun(dir: string, rec: BackupRunRecord): void {
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.run-${rec.id}.${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 })
  renameSync(tmp, runPath(dir, rec.id))
}

function readRuns(dir: string): BackupRunRecord[] {
  if (!existsSync(dir)) return []
  const out: BackupRunRecord[] = []
  for (const f of readdirSync(dir)) {
    if (!RUN_FILE_RE.test(f)) continue
    try {
      const rec = JSON.parse(readFileSync(join(dir, f), 'utf8')) as BackupRunRecord
      if (rec && typeof rec.id === 'string' && (rec.state === 'started' || rec.state === 'finished' || rec.state === 'failed')) {
        out.push(rec)
      }
    } catch {
      /* a half-written or foreign file is not a run */
    }
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

function prune(dir: string): void {
  const runs = readRuns(dir)
  for (const rec of runs.slice(0, Math.max(0, runs.length - KEEP_RUNS))) {
    try {
      rmSync(runPath(dir, rec.id), { force: true })
    } catch {
      /* best effort */
    }
  }
}

/** Interpret what hostd actually said. Success is only ever read, never assumed. */
export function decideOutcome(
  outcome: HostdOutcome,
  nowIso: string,
): { state: 'finished' | 'failed'; exitCode: number | null; finishedAt: string; error?: string } {
  const finishedAt = outcome.result?.finishedAt ?? nowIso
  if (outcome.timedOut) {
    return { state: 'failed', exitCode: null, finishedAt, error: 'Zeitüberschreitung: hostd hat den Lauf nicht abgeschlossen.' }
  }
  if (outcome.exitCode === null) {
    return { state: 'failed', exitCode: null, finishedAt, error: 'Die Verbindung zu hostd wurde ohne Ergebnis (EXIT-Zeile) beendet.' }
  }
  if (outcome.result && (outcome.result.state === 'failed' || outcome.result.exitCode !== 0)) {
    const code = outcome.result.exitCode !== 0 ? outcome.result.exitCode : outcome.exitCode || 1
    return { state: 'failed', exitCode: code, finishedAt, error: `Backup fehlgeschlagen (Exit ${code}).` }
  }
  if (outcome.exitCode !== 0) {
    return { state: 'failed', exitCode: outcome.exitCode, finishedAt, error: `Backup fehlgeschlagen (Exit ${outcome.exitCode}).` }
  }
  return { state: 'finished', exitCode: 0, finishedAt }
}

export function triggerAvailability(deps: Pick<BackupDeps, 'socketPath'>): TriggerAvailability {
  return hostdAvailability(deps.socketPath)
}

/**
 * Connect to hostd, send `backup`, record `started`, and finish the record in the
 * background. Throws BackupTriggerError (never records a run) when hostd cannot
 * be reached or a run is already in flight.
 */
export async function startBackup(deps: BackupDeps, opts: { requestedBy: string | null }): Promise<BackupRunRecord> {
  const now = deps.now ?? (() => new Date())
  if (active.has(deps.runsDir)) {
    throw new BackupTriggerError('busy', 'Es läuft bereits ein Backup.')
  }
  const availability = hostdAvailability(deps.socketPath)
  if (!availability.available) {
    throw new BackupTriggerError('unavailable', availability.reason ?? 'Der Host-Dienst (hostd) ist nicht erreichbar.')
  }
  let sock: net.Socket
  try {
    sock = await (deps.connect ?? connectHostd)(deps.socketPath)
  } catch (err) {
    const msg = err instanceof HostdUnreachableError ? err.message : 'Der Host-Dienst (hostd) ist nicht erreichbar.'
    throw new BackupTriggerError('unavailable', msg)
  }
  // Re-check after the await: two requests can both pass the first check.
  if (active.has(deps.runsDir)) {
    sock.destroy()
    throw new BackupTriggerError('busy', 'Es läuft bereits ein Backup.')
  }

  const rec: BackupRunRecord = {
    id: randomUUID(),
    state: 'started',
    requestedBy: opts.requestedBy,
    startedAt: now().toISOString(),
  }
  try {
    writeRun(deps.runsDir, rec)
  } catch (err) {
    sock.destroy()
    console.error('[backup] cannot record run state:', err instanceof Error ? err.message : err)
    throw new BackupTriggerError('unavailable', 'Der Backup-Status kann nicht gespeichert werden; es wurde kein Backup gestartet.')
  }
  active.set(deps.runsDir, rec.id)

  void runHostdVerb(sock, 'backup', deps.timeoutMs)
    .then((outcome) => {
      const decided = decideOutcome(outcome, now().toISOString())
      const done: BackupRunRecord = { ...rec, state: decided.state, finishedAt: decided.finishedAt, exitCode: decided.exitCode }
      if (decided.error) done.error = decided.error
      if (decided.state === 'finished') {
        try {
          deps.stampLastBackup(decided.finishedAt)
        } catch (err) {
          console.error('[backup] last_backup_at could not be saved:', err instanceof Error ? err.message : err)
          done.error = 'Backup abgeschlossen, aber "letztes Backup" konnte nicht gespeichert werden.'
        }
      }
      writeRun(deps.runsDir, done)
    })
    .catch((err) => {
      console.error('[backup] run bookkeeping failed:', err instanceof Error ? err.message : err)
    })
    .finally(() => {
      active.delete(deps.runsDir)
      try {
        prune(deps.runsDir)
      } catch {
        /* best effort */
      }
    })

  return rec
}

export interface BackupStatus {
  run: BackupRunRecord | null
  runs: BackupRunRecord[]
}

/** Latest run state; a `started` record this process does not own is marked failed (interrupted). */
export function getBackupStatus(deps: Pick<BackupDeps, 'runsDir'> & { now?: () => Date }): BackupStatus {
  const now = deps.now ?? (() => new Date())
  const runs = readRuns(deps.runsDir).map((rec) => {
    if (rec.state === 'started' && active.get(deps.runsDir) !== rec.id) {
      const interrupted: BackupRunRecord = {
        ...rec,
        state: 'failed',
        finishedAt: now().toISOString(),
        exitCode: null,
        error: 'Unterbrochen: der Server wurde während des Laufs neu gestartet; das Ergebnis des Host-Backups ist unbekannt.',
      }
      try {
        writeRun(deps.runsDir, interrupted)
      } catch {
        /* report it anyway */
      }
      return interrupted
    }
    return rec
  })
  return { run: runs.length ? runs[runs.length - 1]! : null, runs: runs.slice(-10) }
}
