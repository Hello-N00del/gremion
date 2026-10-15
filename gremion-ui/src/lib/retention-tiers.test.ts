import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  RETENTION_DEFAULTS,
  RETENTION_CAPS,
  RETENTION_CAVEATS,
  RETENTION_FIELDS,
  PURGE_TICK_DAYS,
  OPERATOR_CEILING_DAYS,
  OPERATOR_DECISION_DE,
  clampRetentionDays,
} from './retention-tiers'

// R29-RETENTION-30-K [D R29-I6]: no log class is kept longer than 30 days.
// This module is the ONE place the tier numbers live; config.ts (clamp on read
// and write), the settings API (zod), TabRetention.svelte (client limits) and
// the purge tick fallback all consume it. These tests pin the numbers and prove
// no surface kept a private copy of the old BSI/BayLDA tiers.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')

describe('retention tiers [D R29-I6]', () => {
  it('pins the defaults (catalogue values: access 14, application 28, security 27, nopii 27)', () => {
    expect(RETENTION_DEFAULTS).toEqual({
      access_logs_days: 14,
      app_logs_days: 28,
      security_logs_days: 27,
      security_nopii_logs_days: 27,
    })
  })

  it('pins the caps: 29 d where a daily purge tick enforces, 30 d for the nopii tier [R31-I4a]', () => {
    expect(RETENTION_CAPS).toEqual({
      access_logs_days: 29,
      app_logs_days: 29,
      security_logs_days: 29,
      security_nopii_logs_days: 30,
    })
  })

  it('the tick-enforced tiers stay at or below the operator ceiling once the daily tick is added', () => {
    expect(OPERATOR_CEILING_DAYS).toBe(30)
    expect(PURGE_TICK_DAYS).toBe(1)
    for (const f of ['access_logs_days', 'app_logs_days', 'security_logs_days'] as const) {
      expect(RETENTION_CAPS[f] + PURGE_TICK_DAYS).toBeLessThanOrEqual(OPERATOR_CEILING_DAYS)
    }
  })

  it('no default exceeds its cap and no cap exceeds the operator ceiling', () => {
    for (const f of RETENTION_FIELDS) {
      expect(RETENTION_DEFAULTS[f]).toBeLessThanOrEqual(RETENTION_CAPS[f])
      expect(RETENTION_CAPS[f]).toBeLessThanOrEqual(OPERATOR_CEILING_DAYS)
      expect(RETENTION_DEFAULTS[f]).toBeGreaterThanOrEqual(1)
    }
  })

  it('clampRetentionDays caps, floors at 1, and replaces non-numbers with the default', () => {
    expect(clampRetentionDays('security_logs_days', 90)).toBe(29)
    expect(clampRetentionDays('security_logs_days', 180)).toBe(29)
    expect(clampRetentionDays('security_logs_days', 29)).toBe(29)
    expect(clampRetentionDays('security_logs_days', 12)).toBe(12)
    expect(clampRetentionDays('security_logs_days', 0)).toBe(1)
    expect(clampRetentionDays('security_logs_days', -5)).toBe(1)
    expect(clampRetentionDays('security_nopii_logs_days', 30)).toBe(30)
    expect(clampRetentionDays('security_nopii_logs_days', 31)).toBe(30)
    expect(clampRetentionDays('security_nopii_logs_days', 365)).toBe(30)
    expect(clampRetentionDays('app_logs_days', undefined)).toBe(28)
    expect(clampRetentionDays('app_logs_days', Number.NaN)).toBe(28)
    expect(clampRetentionDays('app_logs_days', Infinity)).toBe(29)
    expect(clampRetentionDays('app_logs_days', -Infinity)).toBe(1)
    expect(clampRetentionDays('access_logs_days', null as unknown as number)).toBe(14)
    expect(clampRetentionDays('access_logs_days', '30' as unknown as number)).toBe(14)
  })

  it('clampRetentionDays rounds a fractional stored value down (never past the cap)', () => {
    expect(clampRetentionDays('security_logs_days', 28.9)).toBe(28)
    expect(clampRetentionDays('security_logs_days', 29.5)).toBe(29)
  })

  it('names the operator decision with its date, never a plan id', () => {
    expect(OPERATOR_DECISION_DE).toBe('Betreiberentscheidung vom 30.09.2026')
  })
})

// A tier without a purge consumer must be presented as configuration, not as an
// enforced deletion window. RETENTION_CAVEATS is null exactly for the tiers a
// gremion-ui purge consumer reads.
describe('RETENTION_CAVEATS: tiers without a purge consumer', () => {
  const hooks = read('../hooks.server.ts')

  it.each(RETENTION_FIELDS)('%s: caveat is null exactly when hooks.server.ts reads the field', (f) => {
    const consumed = new RegExp(`retention\\??\\.${f}\\b`).test(hooks)
    expect(RETENTION_CAVEATS[f] === null).toBe(consumed)
  })

  it('only security_logs_days is enforced today', () => {
    expect(RETENTION_FIELDS.filter((f) => RETENTION_CAVEATS[f] === null)).toEqual(['security_logs_days'])
  })

  it.each(RETENTION_FIELDS.filter((f) => RETENTION_CAVEATS[f] !== null))('%s: the caveat is plain German with no plan ids', (f) => {
    const caveat = RETENTION_CAVEATS[f] as string
    expect(caveat).toMatch(/^Konfigurationswert/)
    expect(caveat).toContain('nicht')
    expect(caveat).not.toMatch(/R\d\d-|TASK-|S2b/)
  })
})

describe('no surface keeps a private copy of the old tiers', () => {
  const settingsApi = read('../routes/api/settings/+server.ts')
  const tab = read('../routes/settings/tabs/TabRetention.svelte')
  const config = read('./server/config.ts')
  const loesch = read('./server/loeschkonzept.ts')
  const hooks = read('../hooks.server.ts')

  it('the settings API zod bounds come from RETENTION_CAPS', () => {
    expect(settingsApi).toContain('RETENTION_CAPS')
    expect(settingsApi).not.toMatch(/max\((30|90|180|365)\)/)
    expect(settingsApi).not.toMatch(/Max (30|90|180|365) Tage/)
    expect(settingsApi).not.toContain('BSI')
    expect(settingsApi).not.toContain('BayLDA')
  })

  it('TabRetention.svelte takes its limits from RETENTION_CAPS and cites the operator decision, not BSI/BayLDA tiers', () => {
    expect(tab).toContain('RETENTION_CAPS')
    expect(tab).not.toMatch(/:\s*(90|180|365),/)
    expect(tab).not.toMatch(/Max\. (30|90|180|365) Tage/)
    expect(tab).not.toContain('BSI')
    expect(tab).not.toContain('BayLDA')
  })

  it('the Loeschkonzept text names the operator decision in plain German, not the BSI tiers or a plan id', () => {
    expect(loesch).toContain('OPERATOR_DECISION_DE')
    expect(loesch).not.toContain('R29-I6')
    expect(loesch).not.toContain('BSI-Mindeststandard')
    expect(loesch).not.toContain('BayLDA')
  })

  it('the Loeschkonzept and the tab take their caveats from RETENTION_CAVEATS', () => {
    expect(loesch).toContain('RETENTION_CAVEATS')
    expect(tab).toContain('RETENTION_CAVEATS')
    expect(tab).toContain('OPERATOR_DECISION_DE') // reader-facing text is asserted on the rendered tab (TabRetention.test.ts)
  })

  it('config.ts takes defaults and clamps through the module and keeps no literal old cap', () => {
    expect(config).toContain('clampRetentionDays')
    expect(config).toContain('RETENTION_DEFAULTS')
    expect(config).not.toMatch(/security_logs_days,\s*180/)
    expect(config).not.toMatch(/security_nopii_logs_days,\s*365/)
    expect(config).not.toMatch(/app_logs_days,\s*90/)
    expect(config).not.toMatch(/access_logs_days,\s*30\)/)
  })

  it('the purge tick falls back to the registry default, never a literal 90', () => {
    // A rename returns -1; slicing on it would silently test a near-end-of-file window.
    const start = hooks.indexOf('const auditRetentionTick')
    const end = hooks.indexOf('setInterval(auditRetentionTick')
    expect(start, 'const auditRetentionTick not found in hooks.server.ts').toBeGreaterThanOrEqual(0)
    expect(end, 'setInterval(auditRetentionTick not found in hooks.server.ts').toBeGreaterThan(start)
    const tick = hooks.slice(start, end)
    expect(tick).toContain('RETENTION_DEFAULTS.security_logs_days')
    expect(tick).not.toMatch(/\?\?\s*90/)
  })
})
