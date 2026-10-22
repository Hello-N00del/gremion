import { describe, it, expect } from 'vitest'
import { textToBodyHtml, bodyHtmlToText, isPlainBody } from './protocol-body-text'

describe('protocol body text <-> html', () => {
  it('turns blank-line separated text into escaped paragraphs with <br> for single newlines', () => {
    expect(textToBodyHtml('Eins\nzwei\n\nDrei <b>&</b>')).toBe('<p>Eins<br>zwei</p><p>Drei &lt;b&gt;&amp;&lt;/b&gt;</p>')
  })
  it('empty text yields empty html', () => {
    expect(textToBodyHtml('  \n\n ')).toBe('')
  })
  it('round-trips its own output', () => {
    const t = 'A & B\nzeile\n\nzweiter Absatz'
    expect(bodyHtmlToText(textToBodyHtml(t))).toBe(t)
  })
  it('flags rich markup the plain editor would flatten', () => {
    expect(isPlainBody('<p>a</p><p>b<br>c</p>')).toBe(true)
    expect(isPlainBody('')).toBe(true)
    expect(isPlainBody('<h1>T</h1><table></table>')).toBe(false)
  })
})
