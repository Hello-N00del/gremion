// src/lib/server/calendar/backend/governance-stays-put.test.ts
// Task 7 (design §5): D6 says the calendar leaf owns ONLY the calendar data
// plane (events / event-types / recurrence / committee colour settings / the
// caldav_sync_queue + the CalDAV push ticker). The notification-scheduler is a
// GOVERNANCE worker (it imports ../governance/governance-db and fires
// governance role-term reminders) — it must NOT move to the leaf. This guard
// regression-protects that boundary decision: it asserts the kernel still
// owns the scheduler file, that file still imports governance-db (proving it
// is governance-shaped, not calendar-shaped), and register.server.ts still
// boots it. If a future task accidentally carves the scheduler into the
// calendar leaf, this test fails.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// this file lives at src/lib/server/calendar/backend/ — the scheduler and
// register.server.ts live one level up, at src/lib/server/calendar/.
const CALENDAR_DIR = join(HERE, '..')
const SCHEDULER = join(CALENDAR_DIR, 'notification-scheduler.ts')
const REGISTER = join(CALENDAR_DIR, 'register.server.ts')

describe('governance-stays-put (D6 §5): the notification-scheduler is NOT calendar', () => {
  it('notification-scheduler.ts still exists in the kernel calendar dir', () => {
    expect(existsSync(SCHEDULER)).toBe(true)
  })

  it('notification-scheduler.ts still imports from ../governance/governance-db', () => {
    const content = readFileSync(SCHEDULER, 'utf8')
    expect(content).toMatch(/from\s+['"]\.\.\/governance\/governance-db['"]/)
  })

  it('register.server.ts still registers startNotificationScheduler as a boot hook', () => {
    const content = readFileSync(REGISTER, 'utf8')
    expect(content).toMatch(/import\s*\{\s*startNotificationScheduler\s*\}\s*from\s*['"]\.\/notification-scheduler['"]/)
    expect(content).toMatch(/startNotificationScheduler\s*\(\s*\)/)
  })
})
