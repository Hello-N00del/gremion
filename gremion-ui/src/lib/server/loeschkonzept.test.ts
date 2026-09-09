import { describe, it, expect } from 'vitest'
import type { GremionConfig } from './config'

const mockConfig = {
  retention: {
    access_logs_days: 14,
    app_logs_days: 30,
    security_logs_days: 90,
    security_nopii_logs_days: 90,
  },
  compliance: {
    dpo_name: 'Max Muster',
    dpo_email: 'dpo@example.org',
    controller_name: 'StuRa Musteruni',
    controller_address: 'Musterstraße 1, 12345 Musterstadt',
    purpose_description: 'Betrieb der studentischen Verwaltungsplattform',
  },
} as unknown as GremionConfig

describe('generateLoeschkonzept', () => {
  it('embeds retention periods in the output', async () => {
    const { generateLoeschkonzept } = await import('./loeschkonzept')
    const doc = generateLoeschkonzept(mockConfig, new Date('2026-05-04'))
    expect(doc).toContain('14 Tage')
    expect(doc).toContain('90 Tage')
    expect(doc).toContain('Max Muster')
    expect(doc).toContain('2026-05-04')
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
    expect(doc).toContain('StuRa')
  })
})
