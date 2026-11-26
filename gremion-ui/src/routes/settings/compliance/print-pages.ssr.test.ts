// @vitest-environment node
//
// The two print pages (Loeschkonzept, Verzeichnis von Verarbeitungstaetigkeiten) show the generated
// Markdown as formatted text, the same way the settings preview does: a table, bold text, no raw
// pipes or markers. A pipe inside a cell, which the Verzeichnis writes escaped, stays in its cell.
import { describe, expect, test, vi } from 'vitest'
import { render } from 'svelte/server'
import LoeschkonzeptPrint from './print/+page.svelte'
import VerzeichnisPrint from './verzeichnis-print/+page.svelte'

vi.mock('$app/state', () => ({ page: { data: {}, url: new URL('https://pilot.test/settings/compliance/print') } }))

const DOCUMENT = [
  '# Titel',
  '',
  '**Bezeichnung:** Fachschaft <script>alert(1)</script>',
  '',
  '| Zweck | Frist |',
  '|---|---|',
  '| Wahl \\| Abstimmung | **7 Tage** |',
].join('\n')

describe.each([
  ['Loeschkonzept', LoeschkonzeptPrint],
  ['Verzeichnis', VerzeichnisPrint],
])('%s print page', (_name, Page) => {
  const { body } = render(Page as never, { props: { data: { document: DOCUMENT } as never } })

  test('shows a table and bold text instead of the raw Markdown', () => {
    expect(body).toContain('<table')
    expect(body).toContain('<strong>7 Tage</strong>')
    expect(body).toContain('<strong>Bezeichnung:</strong>')
    expect(body).not.toContain('|---|')
    expect(body).not.toContain('<pre')
  })

  test('keeps an escaped pipe in its cell', () => {
    expect(body).toContain('>Wahl | Abstimmung</td>')
    expect((body.match(/<td[ >]/g) ?? []).length).toBe(2)
  })

  test('markup inside the text stays text', () => {
    expect(body).not.toContain('<script>alert(1)</script>')
    expect(body).toContain('&lt;script&gt;')
  })
})
