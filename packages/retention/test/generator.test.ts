// The Loeschkonzept golden (RED recipe: edit a figure in registry.ts or the template, do not regenerate).
// Regenerate on purpose: node packages/retention/bin/retention.mjs generate --out docs/compliance/loeschkonzept/golden/loeschkonzept.de.html --version 1.0 --date 2026-10-22
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { generateLoeschkonzept } from '../src/generator.ts'

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const GOLDEN = readFileSync(resolve(ROOT, 'docs/compliance/loeschkonzept/golden/loeschkonzept.de.html'), 'utf8').replace(/\r\n/g, '\n')

describe('generated Loeschkonzept', () => {
  it('equals the golden German HTML', () => {
    expect(generateLoeschkonzept({ version: '1.0', generatedOn: '2026-10-22' })).toBe(GOLDEN)
  })

  it('states regular vs enforced for the application class and lists every kernel log class', () => {
    expect(GOLDEN).toContain('regulär 30 Tage, Obergrenze 30 Tage; durchgesetzt 28 Tage')
    for (const label of ['Zugriffsprotokolle', 'Sicherheitsprotokolle', 'Finanzprotokolle', 'Audit- und Betreiberzugriffsprotokolle', 'Anwendungsprotokolle', 'Trace-Speicher']) {
      expect(GOLDEN).toContain(label)
    }
    expect(GOLDEN).not.toMatch(/Sicherung(en)? \(/)
  })

  it('says audit_log is a governance record that no timer purges, and job runs are 29 days (operator decision 2026-10-28)', () => {
    const html = generateLoeschkonzept({ version: '1.0', generatedOn: '2026-10-22' })
    expect(html).toContain('RC-GOV-CHAIN')
    expect(html).toMatch(/Audit-Tabelle der Anwendung[^\n]*von keinem Zeitgeber gelöscht/)
    expect(html).not.toMatch(/Audit-Tabelle[^\n]*Tage, täglich gelöscht/)
    expect(html).not.toMatch(/Audit-Tabelle[^\n]*RC-LOG-AUD/)
    expect(html).toMatch(/Läufe geplanter Aufgaben[^\n]*29 Tage/)
    expect(html).toContain('gremion-purge.timer')
    expect(html).not.toContain('wiederholt sich am selben Tag nicht')
  })

  it('lists a module category only when the module is passed in; the kernel categories never change', () => {
    const off = generateLoeschkonzept({ version: '1.0', generatedOn: '2026-10-22', moduleCategories: [] })
    const on = generateLoeschkonzept({
      version: '1.0', generatedOn: '2026-10-22',
      moduleCategories: [{ moduleLabel: 'Kalender', category: 'Terminentwürfe', startTrigger: 'Entwurf verworfen', periodDe: '30 Tage', basisDe: 'Art. 5 Abs. 1 lit. e DSGVO' }],
    })
    expect(off).toBe(GOLDEN)
    expect(off).not.toContain('Terminentwürfe')
    expect(on).toContain('Terminentwürfe (Kalender)')
    for (const line of GOLDEN.split('\n').filter((l) => l.includes('<td>K5</td>') || l.includes('RC-'))) expect(on).toContain(line)
  })

  it('escapes module text and refuses a malformed date', () => {
    const html = generateLoeschkonzept({
      version: '1.0', generatedOn: '2026-10-22',
      moduleCategories: [{ moduleLabel: 'X', category: '<script>', startTrigger: 'a', periodDe: 'b', basisDe: 'c' }],
    })
    expect(html).not.toContain('<script>')
    expect(() => generateLoeschkonzept({ version: '1', generatedOn: '22.10.2026' })).toThrow(RangeError)
  })
})
