import { describe, it, expect } from 'vitest'
import { Role } from '$lib/auth/types'
import { coreManifest } from './core'
import { MODULE_MANIFESTS } from '../registry'

describe('calendar manifest — split out of core (Task 0)', () => {
  it('calendar has its own manifest with the correct id and toggleable flag', async () => {
    const { calendarManifest } = await import('./calendar')
    expect(calendarManifest.id).toBe('calendar')
    expect(calendarManifest.toggleable).toBe(true)
  })

  it('calendar manifest owns the /calendar page at Role.Guest', async () => {
    const { calendarManifest } = await import('./calendar')
    expect(calendarManifest.pages).toEqual([{ segment: 'calendar', minRole: Role.Guest }])
  })

  it('calendar manifest declares /calendar and /api/calendar route prefixes', async () => {
    const { calendarManifest } = await import('./calendar')
    expect(calendarManifest.routePrefixes).toEqual(['/calendar', '/api/calendar'])
  })

  it('calendar manifest attributes NO migrations — 003 stays kernel-applied (#372)', async () => {
    // Mirrors electionsManifest: the calendar_events schema (003) stays
    // KERNEL-applied because 008_public_portal.sql unconditionally ALTERs it.
    // See the exemption comment in calendar.ts and the coupling guards in
    // module-migrations.test.ts / migration-ownership.test.ts.
    const { calendarManifest } = await import('./calendar')
    expect(calendarManifest.migrations ?? []).toEqual([])
  })

  it('coreManifest.pages no longer lists the calendar segment', () => {
    const segments = coreManifest.pages.map((p) => p.segment)
    expect(segments).not.toContain('calendar')
  })

  it('calendar manifest is registered in MODULE_MANIFESTS', async () => {
    const { calendarManifest } = await import('./calendar')
    expect(MODULE_MANIFESTS).toContain(calendarManifest)
    expect(MODULE_MANIFESTS.map((m) => m.id)).toContain('calendar')
  })
})
