// @vitest-environment node
//
// Settings > Datenschutz previews the generated Loeschkonzept and Verzeichnis von
// Verarbeitungstaetigkeiten. Both are Markdown; the preview used to print them as raw text (table
// pipes, **bold** markers). They are rendered as formatted text now, with everything in the source
// escaped first.
import { describe, expect, test, vi } from 'vitest'
import { render } from 'svelte/server'
import SettingsBody from './SettingsBody.svelte'

vi.mock('$app/environment', () => ({ browser: false, building: false, dev: true, version: 'test' }))
vi.mock('$app/navigation', () => ({ goto: vi.fn() }))
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store')
  return { page: readable({ url: new URL('https://pilot.test/settings/datenschutz'), form: null, data: {} }) }
})
vi.mock('$app/state', () => ({ page: { url: new URL('https://pilot.test/settings/datenschutz'), form: null } }))

const LOESCHKONZEPT = [
  '# Löschkonzept — Fachschaft Beispiel',
  '*Stand: 26.11.2026 | Automatisch generiert*',
  '',
  '## 1. Verantwortliche Stelle',
  '',
  '**Bezeichnung:** Fachschaft <script>alert(1)</script>',
  '',
  '| Datenkategorie | Standardwert |',
  '|---|---|',
  '| Zugriffsprotokolle | **7 Tage** |',
].join('\n')

const data = {
  config: { compliance: {} },
  isAdmin: true,
  isITAdmin: true,
  loeschkonzept: LOESCHKONZEPT,
  verarbeitungsverzeichnis: {
    activities: [],
    document: '# Verzeichnis von Verarbeitungstätigkeiten\n\n| Tätigkeit | Zweck |\n|---|---|\n| Chat | **Austausch** |',
  },
  user: { name: 'E2E Admin', email: 'admin@example.test', groups: [] },
  mfaEnrolled: null,
  stepUpEnforced: false,
}

describe('settings section "Datenschutz" shows the generated documents as formatted text', () => {
  const { body } = render(SettingsBody, { props: { data: data as never, activeSection: 'datenschutz' } })

  test('the Loeschkonzept preview has a table and bold text, not raw Markdown', () => {
    expect(body).toContain('<table')
    expect(body).toContain('<strong>7 Tage</strong>')
    expect(body).not.toContain('|---|')
    expect(body).not.toContain('**7 Tage**')
    expect(body).not.toContain('**Bezeichnung:**')
  })

  test('the Verzeichnis preview is formatted too', () => {
    expect(body).toContain('<strong>Austausch</strong>')
    expect(body).not.toContain('| Tätigkeit | Zweck |')
  })

  test('markup inside the generated text stays text', () => {
    expect(body).not.toContain('<script>alert(1)</script>')
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
})
