// Unit tests for the shared rich-HTML sanitizer.
//
// Originated as the G-011 protocol sanitizer test suite (was at
// gremion-ui/src/routes/api/protocols/[id]/publish/publish.test.ts);
// moved here when the sanitizer was extracted to a shared module
// and re-used by the news flow (G-011 analog, Wave 3a follow-up).
//
// Acceptance:
//   1. `sanitizeRichHtml` strips dangerous markup but preserves the
//      LibreOffice-emitted tag set used by protocols + news.
//   2. Event-handler attributes (onerror, onclick, …) are stripped.
//   3. data:/javascript:/vbscript: URIs in href/src/xlink:href are
//      dropped without affecting safe http/https refs.

import { describe, it, expect } from 'vitest'
import { sanitizeRichHtml } from './html-sanitize'

describe('sanitizeRichHtml — G-011 + news-analog allowlist', () => {
  it('strips <script> tags entirely', () => {
    const dirty = '<p>before</p><script>alert(1)</script><p>after</p>'
    const clean = sanitizeRichHtml(dirty)
    expect(clean).not.toContain('<script')
    expect(clean).not.toContain('alert(1)')
    expect(clean).toContain('<p>before</p>')
    expect(clean).toContain('<p>after</p>')
  })

  it('strips <iframe> tags', () => {
    const dirty = '<p>x</p><iframe src="https://evil.example.com/"></iframe>'
    const clean = sanitizeRichHtml(dirty)
    expect(clean).not.toContain('<iframe')
    expect(clean).not.toContain('evil.example.com')
  })

  it('strips event-handler attributes like onerror', () => {
    const dirty = '<img src="x" onerror="alert(1)" alt="boom">'
    const clean = sanitizeRichHtml(dirty)
    expect(clean).not.toMatch(/onerror/i)
    expect(clean).not.toContain('alert(1)')
  })

  it('strips data: URIs in src attributes', () => {
    const dirty = '<img src="data:image/svg+xml;base64,PHN2Zy8+" alt="x">'
    const clean = sanitizeRichHtml(dirty)
    expect(clean).not.toContain('data:image')
    expect(clean).not.toContain('PHN2Zy8+')
  })

  it('strips javascript: URIs in href attributes', () => {
    const dirty = '<a href="javascript:alert(1)">click</a>'
    const clean = sanitizeRichHtml(dirty)
    expect(clean).not.toMatch(/javascript:/i)
    expect(clean).not.toContain('alert(1)')
  })

  it('preserves safe markup verbatim', () => {
    const safe = '<p>Hello <strong>world</strong></p>'
    expect(sanitizeRichHtml(safe)).toBe(safe)
  })

  it('preserves the rich tag set used in real protocols/news posts', () => {
    const safe =
      '<h1>Beschluss</h1>' +
      '<p>Text mit <em>Betonung</em> und <a href="https://stura.example/x" title="t">Link</a>.</p>' +
      '<ul><li>Eins</li><li>Zwei</li></ul>' +
      '<table><thead><tr><th>K</th></tr></thead><tbody><tr><td>V</td></tr></tbody></table>'
    const clean = sanitizeRichHtml(safe)
    expect(clean).toContain('<h1>Beschluss</h1>')
    expect(clean).toContain('<em>Betonung</em>')
    expect(clean).toContain('<a href="https://stura.example/x" title="t">Link</a>')
    expect(clean).toContain('<ul><li>Eins</li><li>Zwei</li></ul>')
    expect(clean).toContain('<thead>')
    expect(clean).toContain('<tbody>')
  })

  it('strips <style> tags (CSS-based exfil / clickjacking surface)', () => {
    const dirty = '<style>body{display:none}</style><p>x</p>'
    const clean = sanitizeRichHtml(dirty)
    expect(clean).not.toContain('<style')
    expect(clean).not.toContain('display:none')
  })

  it('strips <object> and <embed> tags', () => {
    const dirty = '<object data="x.swf"></object><embed src="y.swf">'
    const clean = sanitizeRichHtml(dirty)
    expect(clean).not.toContain('<object')
    expect(clean).not.toContain('<embed')
  })

  it('keeps safe http/https hrefs untouched', () => {
    const safe = '<a href="https://stura.example/page">link</a>'
    expect(sanitizeRichHtml(safe)).toBe(safe)
  })
})
