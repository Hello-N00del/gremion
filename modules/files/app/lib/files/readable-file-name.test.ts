import { describe, expect, it } from 'vitest'
import { readableFileName } from './readable-file-name'

describe('readableFileName', () => {
  it('decodes percent escapes of the last path segment', () => {
    expect(readableFileName('Protokoll%20Sitzung.docx')).toBe('Protokoll Sitzung.docx')
    expect(readableFileName('Protokolle/Haushalt%20%C3%9Cbersicht.odt')).toBe('Haushalt Übersicht.odt')
  })
  it('leaves a plain name alone', () => {
    expect(readableFileName('Sitzung.odt')).toBe('Sitzung.odt')
  })
  it('falls back to the raw text for a malformed escape', () => {
    expect(readableFileName('100%.docx')).toBe('100%.docx')
    expect(readableFileName('Ordner/Bericht%E0%A4%A.odt')).toBe('Bericht%E0%A4%A.odt')
  })
  it('does not interpret markup', () => {
    expect(readableFileName('%3Cb%3Ex%3C%2Fb%3E.odt')).toBe('<b>x</b>.odt')
  })
})
