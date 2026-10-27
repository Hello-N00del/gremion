import { describe, expect, it } from 'vitest'
import { isPrintableText } from '../src/printable-text.ts'

describe('isPrintableText (the one text rule; the panel mirrors it)', () => {
  it('accepts 1..max printable characters, umlauts and emoji included', () => {
    expect(isPrintableText('Stadtrat Süd', 80)).toBe(true)
    expect(isPrintableText('a'.repeat(80), 80)).toBe(true)
    expect(isPrintableText('emoji \u{1F600}', 80)).toBe(true)
  })
  it('refuses empty, blank, over-long and control characters', () => {
    for (const v of ['', '   ', 'a'.repeat(81), 'a\u0000b', 'a\nb', 'a\tb', 'a\u007fb', 'a\u001fb']) expect(isPrintableText(v, 80), JSON.stringify(v)).toBe(false)
    expect(isPrintableText(42, 80)).toBe(false)
  })
  it('refuses C1 controls, bidi controls, line/paragraph separators and lone surrogates', () => {
    for (const v of ['a\u0085b', 'a\u009fb', 'a\u202eb', 'a\u2066b', 'a\u2028b', 'a\u2029b', 'a\ud800b', 'a\udfffb']) expect(isPrintableText(v, 80), JSON.stringify(v)).toBe(false)
  })
})
