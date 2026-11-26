import { describe, it, expect } from 'vitest'
import { renderSafeMarkdown } from './safe-markdown'

// The Loeschkonzept and the Verzeichnis von Verarbeitungstaetigkeiten are generated as Markdown. The
// settings preview and the print pages show them as formatted text: headings, bold, a table, a list.
// Every character of the source is escaped before any markup is added, so nothing the source carries
// (a controller name typed into the form, say) can become an element.
describe('renderSafeMarkdown', () => {
  it('renders headings, shifted by the base level and capped at h6', () => {
    expect(renderSafeMarkdown('# Titel\n\n## Abschnitt')).toContain('<h1')
    expect(renderSafeMarkdown('# Titel\n\n## Abschnitt', { baseHeading: 4 })).toMatch(/<h4[^>]*>Titel<\/h4>/)
    expect(renderSafeMarkdown('# Titel\n\n## Abschnitt', { baseHeading: 4 })).toMatch(/<h5[^>]*>Abschnitt<\/h5>/)
    expect(renderSafeMarkdown('### x', { baseHeading: 6 })).toMatch(/<h6[^>]*>x<\/h6>/)
  })

  it('renders bold and italic without leaving the markers behind', () => {
    const html = renderSafeMarkdown('**Bezeichnung:** Fachschaft\n\n*Stand: heute | automatisch*')
    expect(html).toContain('<strong>Bezeichnung:</strong>')
    expect(html).toContain('<em>Stand: heute | automatisch</em>')
    expect(html).not.toContain('**')
    expect(html).not.toMatch(/(^|[^\w])\*[^*]/)
  })

  it('keeps the lines of a paragraph apart', () => {
    const html = renderSafeMarkdown('**Bezeichnung:** A\n**Anschrift:** B')
    expect(html).toMatch(/<p[^>]*>.*Bezeichnung.*<br>.*Anschrift.*<\/p>/s)
  })

  it('renders a pipe table with a header row and no separator row', () => {
    const md = '| Datenkategorie | Frist |\n|---|---|\n| Zugriffsprotokolle | **7 Tage** |\n| Backups | 30 Tage |'
    const html = renderSafeMarkdown(md)
    expect(html).toContain('<table')
    expect((html.match(/<th[ >]/g) ?? []).length).toBe(2)
    expect((html.match(/<tr[ >]/g) ?? []).length).toBe(3)
    expect(html).toContain('<strong>7 Tage</strong>')
    expect(html).not.toContain('|---|')
    expect(html).not.toContain('| Backups')
  })

  it('renders list items and a horizontal rule', () => {
    const html = renderSafeMarkdown('- **IP-Adressen** werden verschluesselt\n- Backups\n\n---\n*Ende*')
    expect((html.match(/<li[ >]/g) ?? []).length).toBe(2)
    expect(html).toContain('<ul')
    expect(html).toContain('<hr')
    expect(html).toContain('<em>Ende</em>')
  })

  it('escapes raw HTML: a script, an event handler and an entity never become markup', () => {
    const html = renderSafeMarkdown(
      '# <script>alert(1)</script>\n\n**<img src=x onerror=alert(1)>** & "q" \'s\'\n\n| <b>h</b> |\n|---|\n| <svg onload=alert(1)> |\n\n- <a href="javascript:alert(1)">x</a>',
    )
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<img/i)
    expect(html).not.toMatch(/<svg/i)
    expect(html).not.toMatch(/<a[ >]/i)
    expect(html).not.toMatch(/<b>/i)
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
    expect(html).toContain('&quot;q&quot;')
  })

  it('does not turn a markdown link into an anchor', () => {
    const html = renderSafeMarkdown('[klick](javascript:alert(1))')
    expect(html).not.toMatch(/<a[ >]/i)
    expect(html).toContain('[klick]')
  })

  it('answers an empty string for an empty source', () => {
    expect(renderSafeMarkdown('')).toBe('')
    expect(renderSafeMarkdown('   \n\n ')).toBe('')
  })
})
