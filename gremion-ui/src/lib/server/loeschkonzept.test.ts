import { describe, it, expect } from 'vitest'
import type { GremionConfig } from './config'
import { RETENTION_CAVEATS, RETENTION_FIELDS, type RetentionField } from '$lib/retention-tiers'

const mockConfig = {
  retention: {
    access_logs_days: 14,
    app_logs_days: 28,
    security_logs_days: 27,
    security_nopii_logs_days: 27,
  },
  compliance: {
    dpo_name: 'Max Muster',
    dpo_email: 'dpo@example.org',
    controller_name: 'Mustergremium',
    controller_address: 'Musterstraße 1, 12345 Musterstadt',
    purpose_description: 'Betrieb der studentischen Verwaltungsplattform',
  },
} as unknown as GremionConfig

describe('generateLoeschkonzept', () => {
  it('embeds retention periods in the output', async () => {
    const { generateLoeschkonzept } = await import('./loeschkonzept')
    const doc = generateLoeschkonzept(mockConfig, new Date('2026-05-04'))
    expect(doc).toContain('14 Tage')
    expect(doc).toContain('**28 Tage**')
    expect(doc).toContain('**27 Tage**')
    expect(doc).toContain('Max Muster')
    expect(doc).toContain('2026-05-04')
  })

  // R29-RETENTION-30-K [D R29-I6]: the legal basis column names the operator
  // ceiling (30 days for every log class), not the BSI 90/180 or BayLDA tiers,
  // which the system no longer allows.
  it('names the 30-day operator ceiling and no longer cites the superseded BSI / 365-day tiers', async () => {
    const { generateLoeschkonzept } = await import('./loeschkonzept')
    const doc = generateLoeschkonzept(mockConfig, new Date('2026-05-04'))
    // reader-facing text names the operator decision and its date, never an internal plan id
    expect(doc).toContain('Betreiberentscheidung vom 30.09.2026')
    expect(doc).not.toMatch(/R29-I6|R31-I|TASK-\d/)
    expect(doc).toContain('30 Tage')
    expect(doc).not.toContain('BSI-Mindeststandard')
    expect(doc).not.toContain('BayLDA')
    // (backup rows legitimately say "365 Tage Remote"; only the bold log values are checked)
    expect(doc).not.toMatch(/\*\*(90|180|365) Tage\*\*/)
  })

  // Only security_logs_days has a purge consumer in gremion-ui
  // (auditRetentionTick). Every other tier row must say so instead of presenting
  // the configured window as an enforced deletion period.
  describe('tiers without a purge consumer carry the caveat', () => {
    const ROW_LABEL: Record<RetentionField, string> = {
      access_logs_days: '| Zugriffsprotokolle',
      app_logs_days: '| Anwendungs-/Fehlerprotokolle',
      security_logs_days: '| Sicherheits-/Auditprotokolle',
      security_nopii_logs_days: '| Sicherheitsprotokolle (ohne Personenbezug)',
    }

    const UNENFORCED = RETENTION_FIELDS.filter((f) => RETENTION_CAVEATS[f] !== null)
    const ENFORCED = RETENTION_FIELDS.filter((f) => RETENTION_CAVEATS[f] === null)

    const rowFor = async (field: RetentionField): Promise<string> => {
      const { generateLoeschkonzept } = await import('./loeschkonzept')
      const doc = generateLoeschkonzept(mockConfig, new Date('2026-05-04'))
      const rows = doc.split('\n').filter((l) => l.startsWith(ROW_LABEL[field]))
      expect(rows).toHaveLength(1)
      return rows[0]
    }

    it('at least one tier is unenforced and one enforced (the guard is not vacuous)', () => {
      expect(UNENFORCED.length).toBeGreaterThan(0)
      expect(ENFORCED).toEqual(['security_logs_days'])
    })

    it.each(UNENFORCED)('%s: has no purge consumer, so its row carries the caveat', async (field) => {
      expect(await rowFor(field)).toContain(String(RETENTION_CAVEATS[field]))
    })

    it.each(ENFORCED)('%s: has a purge consumer, so its row carries no caveat', async (field) => {
      expect(await rowFor(field)).not.toContain('Konfigurationswert')
    })

    it('the technical-implementation section does not claim the configured windows are applied to the logs', async () => {
      const { generateLoeschkonzept } = await import('./loeschkonzept')
      const doc = generateLoeschkonzept(mockConfig, new Date('2026-05-04'))
      expect(doc).not.toContain('innerhalb der konfigurierten Fristen automatisch gelöscht')
    })
  })

  it('includes DPO email in the footer', async () => {
    const { generateLoeschkonzept } = await import('./loeschkonzept')
    const doc = generateLoeschkonzept(mockConfig)
    expect(doc).toContain('dpo@example.org')
  })

  it('uses fallback text when controller_name is empty', async () => {
    const { generateLoeschkonzept } = await import('./loeschkonzept')
    const configWithoutName = {
      ...mockConfig,
      compliance: { ...mockConfig.compliance, controller_name: '' },
    } as unknown as GremionConfig
    const doc = generateLoeschkonzept(configWithoutName)
    expect(doc).toContain('Organisation')
  })
})
