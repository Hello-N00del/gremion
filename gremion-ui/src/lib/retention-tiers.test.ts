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
// enforced deletion window. No gremion-ui process reads or purges by a retention
// setting (TASK-033-a), and the kernel audit_log is a governance record that no
// timer purges (RC-GOV-CHAIN, operator decision 2026-10-28): every caveat is set.
describe('RETENTION_CAVEATS: tiers without a purge consumer', () => {
  const hooks = read('../hooks.server.ts')
  const registry = read('../../../packages/retention/src/registry.ts')

  it.each(RETENTION_FIELDS)('%s: no in-process purge reads the field (hooks.server.ts)', (f) => {
    expect(hooks.includes(`retention.${f}`) || hooks.includes(`retention?.${f}`)).toBe(false)
  })

  it('nothing schedules or defines an audit_log purge: it is an append-only governance record (RC-GOV-CHAIN)', () => {
    // RED recipe: re-add `purgeAuditLogsOlderThan` or an `auditRetentionTick` to hooks.server.ts.
    expect(hooks).not.toContain('purgeAuditLogsOlderThan')
    expect(hooks).not.toContain('auditRetentionTick')
    expect(hooks).not.toContain('AUDIT_RETENTION_BOOT_DELAY_MS')
    expect(read('./server/audit-db.ts')).not.toContain('audit_log_purge_before')
  })

  it('no tier is enforced by the application: every caveat is set, and security_logs_days is the log-store window, not the audit table', () => {
    expect(RETENTION_FIELDS.filter((f) => RETENTION_CAVEATS[f] === null)).toEqual([])
    expect(RETENTION_CAVEATS.security_logs_days).toContain('Audit-Tabelle')
    expect(RETENTION_CAVEATS.security_logs_days).toContain('RC-GOV-CHAIN')
    expect(registry).toMatch(/RC-GOV-CHAIN/)
  })

  it.each(RETENTION_FIELDS.filter((f) => RETENTION_CAVEATS[f] !== null))('%s: the caveat is plain German with no plan ids', (f) => {
    const caveat = RETENTION_CAVEATS[f] as string
    expect(caveat).toMatch(/^Konfigurationswert/)
    expect(caveat).toContain('nicht')
    expect(caveat).not.toMatch(/R\d\d-|TASK-|S2b/)
  })
})

// The gremion-ui fixed windows and the registry that renders the log store's retention are separately
// written numbers; this ties them. RED recipe: change a default in retention-tiers.ts or a class
// regularDays in packages/retention/src/registry.ts alone. (security_nopii_logs_days has no class: G4.)
describe('RETENTION_DEFAULTS equal the windows the registry enforces in the log store', () => {
  it.each([
    ['access_logs_days', 'access'],
    ['app_logs_days', 'application'],
    ['security_logs_days', 'security'],
  ] as const)('%s equals enforcedDays(%s) of the packages/retention registry', async (field, cls) => {
    const reg = await import('../../../packages/retention/src/registry.ts')
    expect(RETENTION_DEFAULTS[field]).toBe(reg.enforcedDays(reg.logClass(cls)))
  })

  it('security_logs_days is NOT the audit_log table: the registry states audit_log is RC-GOV-CHAIN and the plt.job_run rule is the one database window', async () => {
    const reg = await import('../../../packages/retention/src/registry.ts')
    expect(reg.dbWindowDays(reg.logClass('application'))).toBe(29)
    expect(read('../../../packages/retention/src/registry.ts')).toMatch(/audit_log table is NOT a class/)
  })
})

describe('infra/hardening/values.yaml seeds the registry values', () => {
  // Plain-text parse (no yaml dependency in gremion-ui): `  key: 14   # comment`.
  const yaml = read('../../../infra/hardening/values.yaml')
  const seeded = (field: string): number => {
    const m = yaml.match(new RegExp(`^\\s+${field}:\\s*(\\d+)`, 'm'))
    expect(m, `${field} missing from infra/hardening/values.yaml`).not.toBeNull()
    return Number(m![1])
  }

  it.each(RETENTION_FIELDS)('%s equals RETENTION_DEFAULTS and is within RETENTION_CAPS', (f) => {
    expect(seeded(f)).toBe(RETENTION_DEFAULTS[f])
    expect(seeded(f)).toBeLessThanOrEqual(RETENTION_CAPS[f])
  })

  it('the comments cite the operator ceiling, not the superseded 90/180/365 caps', () => {
    expect(yaml).toContain('R29-I6')
    expect(yaml).not.toMatch(/hard cap (90|180|365)\b/)
    expect(yaml).not.toContain('BSI Mindeststandard')
    expect(yaml).not.toContain('BayLDA')
  })

  it('the generated-env template does not restate the superseded 90/180/365-day caps', () => {
    const tmpl = read('../../../infra/hardening/templates/hardening.env.tmpl')
    expect(tmpl).toContain('R29-I6')
    expect(tmpl).not.toMatch(/max (90|180|365) days/)
    expect(tmpl).not.toContain('BSI')
    expect(tmpl).not.toContain('BayLDA')
  })
})

// The compose env surface: .env.example and the host template that renders the
// per-host state.env carry the same four tiers in seconds (days x 86400). Only
// LOG_ACCESS_RETENTION_SECONDS is read by docker-compose.yml; the other three
// document the tier defaults, but they must not document the superseded ones.
describe('the compose env files carry the registry values in seconds', () => {
  const DAY = 86400
  const VAR: Record<(typeof RETENTION_FIELDS)[number], string> = {
    access_logs_days: 'LOG_ACCESS_RETENTION_SECONDS',
    app_logs_days: 'LOG_APP_RETENTION_SECONDS',
    security_logs_days: 'LOG_SECURITY_RETENTION_SECONDS',
    security_nopii_logs_days: 'LOG_SECURITY_NOPII_RETENTION_SECONDS',
  }
  const valueIn = (text: string, name: string): number => {
    const m = text.match(new RegExp(`^${name}=(\\d+)`, 'm'))
    expect(m, `${name} missing`).not.toBeNull()
    return Number(m![1])
  }
  const envExample = read('../../../.env.example')
  const stateTmpl = read('../../../infra/host/templates/env/state.env.tmpl')

  it.each(RETENTION_FIELDS)('.env.example %s default equals RETENTION_DEFAULTS and the stated hard cap equals RETENTION_CAPS', (f) => {
    expect(valueIn(envExample, VAR[f])).toBe(RETENTION_DEFAULTS[f] * DAY)
    const line = envExample.split('\n').find((l) => l.startsWith(`${VAR[f]}=`))!
    const cap = line.match(/hard cap: (\d+)/)
    expect(cap, `${VAR[f]} states no hard cap`).not.toBeNull()
    expect(Number(cap![1])).toBe(RETENTION_CAPS[f] * DAY)
  })

  it.each(RETENTION_FIELDS)('state.env.tmpl %s equals RETENTION_DEFAULTS (and is within RETENTION_CAPS)', (f) => {
    expect(valueIn(stateTmpl, VAR[f])).toBe(RETENTION_DEFAULTS[f] * DAY)
    expect(valueIn(stateTmpl, VAR[f])).toBeLessThanOrEqual(RETENTION_CAPS[f] * DAY)
  })

  // infra/hardening renders .env.hardening from values.yaml: its Makefile fills the template's ${VAR} placeholders by
  // name, so both must use the same variable names as the env files above (not abbreviated LOG_SEC_ / LOG_SECNOPII_).
  it.each(RETENTION_FIELDS)('infra/hardening Makefile and template both name %s as the env files do', (f) => {
    const makefile = read('../../../infra/hardening/Makefile')
    const tmpl = read('../../../infra/hardening/templates/hardening.env.tmpl')
    expect(makefile).toContain(`'${VAR[f]}':`)
    expect(tmpl).toMatch(new RegExp(`^${VAR[f]}=\\$\\{${VAR[f]}\\}$`, 'm'))
    for (const text of [makefile, tmpl]) expect(text).not.toMatch(/LOG_SEC_|LOG_SECNOPII_/)
  })

  it.each(['.env.example', 'docs/ENVIRONMENT.md', 'docs/OPERATIONS.md', 'infra/host/templates/env/state.env.tmpl'])(
    '%s does not restate the superseded 90/180/365-day windows in seconds',
    (file) => {
      const text = read(`../../../${file}`)
      expect(text).not.toMatch(/\b(7776000|15552000|31536000)\b/)
    },
  )

  // The three operator-facing tables `| VAR | default | hard cap |`: the day
  // figures of each row are the registry's default and cap.
  it.each(['docs/ENVIRONMENT.md', 'docs/OPERATIONS.md', 'docs/log-retention-policy.md'])(
    '%s: the LOG_*_RETENTION_SECONDS table rows state the registry default and cap in days',
    (file) => {
      const text = read(`../../../${file}`)
      for (const f of RETENTION_FIELDS) {
        const row = text.split('\n').find((l) => l.startsWith(`| \`${VAR[f]}\``))
        expect(row, `${file}: no table row for ${VAR[f]}`).toBeDefined()
        const days = [...row!.matchAll(/(\d+)\s*(?:d\b|days?\b)/g)].map((m) => Number(m[1]))
        expect(days, `${file}: ${VAR[f]}`).toEqual([RETENTION_DEFAULTS[f], RETENTION_CAPS[f]])
      }
    },
  )
})

// The compliance documents restate the tiers in prose tables; a drifting figure
// there tells a data subject or an auditor a window the system does not enforce.
describe('the compliance documents state the registry tiers', () => {
  const cells = (line: string): string[] => line.split('|').slice(1, -1).map((c) => c.trim())
  const rowStarting = (text: string, start: string): string[] => {
    const line = text.split('\n').find((l) => l.startsWith(start))
    expect(line, `no table row starting with ${start}`).toBeDefined()
    return cells(line!)
  }

  it.each(RETENTION_FIELDS)('docs/compliance.md row %s: default and hard cap equal the registry', (f) => {
    const row = rowStarting(read('../../../docs/compliance.md'), `| \`${f}\` |`)
    expect(Number(row[1])).toBe(RETENTION_DEFAULTS[f])
    expect(Number(row[2].replaceAll('*', ''))).toBe(RETENTION_CAPS[f])
  })

  const CPS_ROW: Record<(typeof RETENTION_FIELDS)[number], string> = {
    access_logs_days: '| Access logs |',
    app_logs_days: '| Application logs |',
    security_logs_days: '| Security logs (log store) |',
    security_nopii_logs_days: '| Security logs without PII |',
  }

  it.each(RETENTION_FIELDS)('docs/compliance/controller-processor-split.md row %s: default and hard cap equal the registry', (f) => {
    const row = rowStarting(read('../../../docs/compliance/controller-processor-split.md'), CPS_ROW[f])
    expect(row[1]).toBe(`${RETENTION_DEFAULTS[f]} d`)
    expect(row[2]).toBe(`${RETENTION_CAPS[f]} d`)
  })

  it('docs/compliance.md no longer shows the superseded Math.min caps or the fallback 90', () => {
    const text = read('../../../docs/compliance.md')
    expect(text).not.toMatch(/Math\.min\(\.\.\., (30|90|180|365)\)/)
    expect(text).not.toContain('fallback 90')
    expect(text).not.toContain("the code's current value")
  })

  it('docs/log-retention-policy.md no longer calls the table figures the code value rather than the policy', () => {
    expect(read('../../../docs/log-retention-policy.md')).not.toContain("code's current value")
  })
})

describe('no surface keeps a private copy of the old tiers', () => {
  const settingsApi = read('../routes/api/settings/+server.ts')
  const tab = read('../routes/settings/tabs/TabRetention.svelte')
  const config = read('./server/config.ts')
  const loesch = read('./server/loeschkonzept.ts')
  const hooks = read('../hooks.server.ts')

  it('the settings API has no retention bounds: the key is refused (Q6)', () => {
    expect(settingsApi).not.toContain('RETENTION_CAPS')
    expect(settingsApi).toContain("'retention' in body")
    expect(settingsApi).not.toMatch(/max\((30|90|180|365)\)/)
    expect(settingsApi).not.toMatch(/Max (30|90|180|365) Tage/)
    expect(settingsApi).not.toContain('BSI')
    expect(settingsApi).not.toContain('BayLDA')
  })

  it('TabRetention.svelte is read-only, shows RETENTION_DEFAULTS and cites the operator decision, not BSI/BayLDA tiers', () => {
    expect(tab).toContain('RETENTION_DEFAULTS')
    expect(tab).not.toContain('<Input')
    expect(tab).not.toContain('<Button')
    expect(tab).not.toContain('fetch(')
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

  it('hooks.server.ts keeps no private retention number and no purge fallback', () => {
    expect(hooks).not.toContain('RETENTION_DEFAULTS')
    expect(hooks.includes('?? 90') || hooks.includes('?? 180') || hooks.includes('?? 365')).toBe(false)
  })
})
