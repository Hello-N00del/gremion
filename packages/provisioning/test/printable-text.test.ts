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
})
