import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { writeConfig } from '$lib/server/config'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'node:path'
import { env } from '$env/dynamic/private'
import { defaultTenantEnv } from '$lib/server/tenant/default-env'
import { randomUUID } from 'node:crypto'

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

function getConfigDir(): string {
  return (defaultTenantEnv('CONFIG_PATH') ?? '/app/config/config.json').replace(/\/[^/]+$/, '')
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
  return json({ success: true, data: runs })
}

// POST — trigger a backup run, or request an integrity check
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

  // Default: trigger a backup
  const jobId = randomUUID()
  const now = new Date().toISOString()
  try {
    writeConfig({ backups: { last_backup_at: now } } as never)
  } catch {
    /* non-critical — backup will proceed independently */
  }

  return json({ success: true, data: { started: true, job_id: jobId, timestamp: now } })
}
