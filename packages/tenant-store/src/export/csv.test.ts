// Unit: the CSV encoding, incl. the formula guard (MED-2).
import { describe, expect, it } from 'vitest'
import { CSV_FORMULA_GUARD, csvLine } from './csv.js'

describe('csvLine', () => {
  it('RFC 4180: quotes doubled, CRLF, null empty', () => {
    expect(csvLine(['a', 'b,c', 'say "hi"', null, 'x\ny'])).toBe('a,"b,c","say ""hi""",,"x\ny"\r\n')
  })

  it('MED-2: a text cell a spreadsheet would read as a formula starts with an apostrophe', () => {
    expect(csvLine(['=HYPERLINK("http://evil","x")'])).toBe(`"'=HYPERLINK(""http://evil"",""x"")"\r\n`)
    expect(csvLine(['+1', '-cmd', '@SUM(A1)', '\tx', '\rx'])).toBe(`'+1,'-cmd,'@SUM(A1),'\tx,"'\rx"\r\n`)
    // only the first character counts; numbers the driver returns as numbers are values, not text
    expect(csvLine(['a=b', 'x-1', -5, 0n, null])).toBe('a=b,x-1,-5,0,\r\n')
    expect(CSV_FORMULA_GUARD).toMatch(/apostrophe/)
  })
})
