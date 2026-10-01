import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { readConfig, writeConfig } from '$lib/server/config'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'node:path'
import { env } from '$env/dynamic/private'
import { getTenant } from '$lib/server/tenant/context'
import { backupTimeoutMs, hostdSocketPath } from '$lib/server/backup/hostd-client'
import {
  BackupTriggerError,
  getBackupStatus,
  startBackup,
  triggerAvailability,
  type BackupDeps,
} from '$lib/server/backup/backup-trigger'

interface BackupStep {
  step: string
  duration_s: number
  status: string
  size_bytes?: number
}

interface BackupRun {
  run_id: string
  timestamp: string
  total_duration_s: number
  status: string
  steps: BackupStep[]
}

// TASK-042: the backup log dir is the REQUEST tenant's config dir (its
// configPath, /data/<slug>/config.json), never a deployment-global CONFIG_PATH.
function getConfigDir(): string {
  return getTenant().configPath.replace(/\/[^/]+$/, '')
}

function getBackupLogsDir(): string {
  return env.BACKUP_LOGS_DIR ?? `${getConfigDir()}/backup/logs`
}

function getCheckTriggerPath(): string {
  return env.BACKUP_CHECK_TRIGGER ?? `${getConfigDir()}/backup/check-requested`
}

function readRecentRuns(limit = 20): BackupRun[] {
  const dir = getBackupLogsDir()
  if (!existsSync(dir)) return []
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('backup-') && f.endsWith('.json'))
      .sort()
      .slice(-limit)
    return files.flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(`${dir}/${f}`, 'utf-8')) as BackupRun]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

function requireITAdmin(user: SessionUser | undefined): boolean {
  return !!user && hasRole(user.roles, Role.ITAdmin)
}

// GET — return recent backup runs with step durations
export const GET: RequestHandler = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!requireITAdmin(user)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const runs = readRecentRuns()
  const deps = backupDeps()
  const status = getBackupStatus(deps)
  let lastBackupAt: string | null = null
  try {
    lastBackupAt = readConfig().backups.last_backup_at
  } catch {
    /* unreadable config: show no timestamp rather than a wrong one */
  }
  return json({
    success: true,
    data: runs,
    // F1-FIX-10-K: whether the button can work at all (with the reason when not),
    // the real state of the latest triggered run, and the only trustworthy
    // "last backup" timestamp (written solely from a finished run).
    trigger: triggerAvailability(deps),
    run: status.run,
    runs_state: status.runs,
    last_backup_at: lastBackupAt,
  })
}

function backupDeps(): BackupDeps {
  const tenant = getTenant()
  return {
    socketPath: hostdSocketPath(env),
    runsDir: env.BACKUP_RUNS_DIR ?? `${getConfigDir()}/backup/runs`,
    timeoutMs: backupTimeoutMs(env),
    stampLastBackup: (iso) => {
      writeConfig({ backups: { last_backup_at: iso } } as never, tenant)
    },
  }
}

// POST — trigger a backup run (hostd `backup` verb), or request an integrity check
export const POST: RequestHandler = async ({ request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!requireITAdmin(user)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  let body: Record<string, unknown> = {}
  try {
    body = await request.json()
  } catch {
    /* empty body is fine */
  }

  if (body.action === 'check') {
    try {
      const triggerPath = getCheckTriggerPath()
      mkdirSync(dirname(triggerPath), { recursive: true })
      writeFileSync(triggerPath, new Date().toISOString())
      return json({ success: true, data: { check_requested: true } })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return json({ success: false, error: message }, { status: 500 })
    }
  }

  // Default: trigger a REAL backup through hostd (D-4). `started` is only
  // answered after hostd accepted the connection and the request line was sent;
  // last_backup_at is NOT written here, only when the run finishes (see
  // lib/server/backup/backup-trigger.ts).
  try {
    const run = await startBackup(backupDeps(), { requestedBy: user?.id ?? null })
    return json(
      {
        success: true,
        data: { started: true, state: run.state, run_id: run.id, timestamp: run.startedAt },
      },
      { status: 202 },
    )
  } catch (err) {
    if (err instanceof BackupTriggerError) {
      return json(
        { success: false, error: err.message, code: err.code },
        { status: err.code === 'busy' ? 409 : 503 },
      )
    }
    const message = err instanceof Error ? err.message : 'Unknown error'
    return json({ success: false, error: message }, { status: 500 })
  }
}
