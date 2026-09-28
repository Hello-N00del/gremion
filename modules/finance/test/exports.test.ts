// test/exports.test.ts — unit tests for the byte-export generators (#383 Lane E3,
// R5). The PDF assertions mirror the native pdf/budget-statement.test.ts cases
// EXACTLY (German headers, 2-decimal euro strings, html shape) plus the escaping +
// grouping helpers; the xlsx assertions parse the workbook BACK with ExcelJS and
// assert the cell matrix the native exportBudget produces (headers + cents/100
// values) — the parse-back comparison is timestamp-independent by construction
// (workbook created/modified metadata never enters the cell matrix). Cross-mode
// byte equivalence vs the NATIVE generator module lives kernel-side in
// gremion-ui/src/lib/server/finance/pdf/leaf-export-parity.test.ts (the leaf test
// runner cannot resolve the kernel's $lib alias).

import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { renderBudgetStatementHtml, groupLinesIntoSections, toEuroString } from '../src/exports/pdf.ts'
import { buildBudgetExport } from '../src/exports/xlsx.ts'
import type { StatementLine } from '../src/store/index.ts'

const STMT = {
  plan: { id: 1, name: 'Haushalt 2024', state: 'closed' },
  sections: [{
    id: 1, name: 'Zentrale Ausgaben',
    titel: [{ titel_nr: '1.1', titel_name: 'Personal', ansatz: 12000, ist: 11000 }],
  }],
}

const LINES: StatementLine[] = [
  { titel_id: 11, titel_nr: '1.1', titel_name: 'Personal', ansatz: 12000, ist: 11000, section_id: 1, group_id: 4 },
  { titel_id: 12, titel_nr: '1.2', titel_name: 'Sachmittel', ansatz: 5000, ist: 0, section_id: 1, group_id: 4 },
  { titel_id: 21, titel_nr: '2.1', titel_name: 'Projekte', ansatz: 100000, ist: 25050, section_id: 2, group_id: 7 },
]

describe('exports/pdf — renderBudgetStatementHtml (native oracle test parity)', () => {
  it('produces an <html> document with the plan name', () => {
    const html = renderBudgetStatementHtml(STMT)
    expect(html).toMatch(/<html/i)
    expect(html).toContain('Haushalt 2024')
    expect(html).toContain('1.1')
    expect(html).toContain('Personal')
  })

  it('renders amounts as euros with 2 decimals (sub-spec §5.2)', () => {
    const html = renderBudgetStatementHtml(STMT)
    expect(html).toContain('120.00') // 12000 cents
    expect(html).toContain('110.00') // 11000 cents
    expect(html).toContain('10.00') // diff
  })

  it('uses German column headers (sub-spec §7.3 Q3)', () => {
    const html = renderBudgetStatementHtml(STMT)
    for (const h of ['Titel-Nr.', 'Bezeichnung', 'Ansatz', 'Ist', 'Diff']) expect(html).toContain(h)
  })

  it('escapes HTML in plan/section/titel names (no markup injection)', () => {
    const html = renderBudgetStatementHtml({
      plan: { id: 9, name: '<script>alert("x")</script> & Co', state: 'draft' },
      sections: [{ id: 1, name: 'A&B', titel: [{ titel_nr: '<1>', titel_name: `"quoted" 'name'`, ansatz: 0, ist: 0 }] }],
    })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('A&amp;B')
    expect(html).toContain('&quot;quoted&quot; &#39;name&#39;')
  })

  it('toEuroString mirrors the native toDtoEuroString (cents → "0.00")', () => {
    expect(toEuroString(0)).toBe('0.00')
    expect(toEuroString(-12345)).toBe('-123.45')
    expect(toEuroString(100000)).toBe('1000.00')
  })
})

describe('exports/pdf — groupLinesIntoSections (native grouping parity)', () => {
  it('groups flat lines by section_id with the native "Section <id>" names', () => {
    const sections = groupLinesIntoSections(LINES)
    expect(sections).toHaveLength(2)
    expect(sections[0]).toEqual({
      id: 1, name: 'Section 1',
      titel: [
        { titel_nr: '1.1', titel_name: 'Personal', ansatz: 12000, ist: 11000 },
        { titel_nr: '1.2', titel_name: 'Sachmittel', ansatz: 5000, ist: 0 },
      ],
    })
    expect(sections[1]!.name).toBe('Section 2')
    expect(sections[1]!.titel).toHaveLength(1)
  })

  it('an empty projection renders an html document with no sections', () => {
    const html = renderBudgetStatementHtml({ plan: { id: 3, name: 'Leer', state: 'draft' }, sections: groupLinesIntoSections([]) })
    expect(html).toMatch(/<html/i)
    expect(html).not.toContain('<section>')
  })
})

describe('exports/xlsx — buildBudgetExport (native workbook parity, timestamp-independent)', () => {
  it('xlsx: parseable workbook with the native sheet name, German headers, cents/100 rows', async () => {
    const { body, contentType } = await buildBudgetExport(LINES, 'xlsx')
    expect(contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(body.byteLength).toBeGreaterThan(0)
    // exact-size: the buffer is a standalone allocation, not a pooled slice
    expect(body.buffer.byteLength).toBe(body.byteLength)

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer)
    const sheet = wb.worksheets[0]!
    expect(sheet.name).toBe('Haushalt')
    const matrix: unknown[][] = []
    sheet.eachRow((row) => {
      const cells: unknown[] = []
      row.eachCell({ includeEmpty: false }, (c) => cells.push(c.value))
      matrix.push(cells)
    })
    expect(matrix).toEqual([
      ['Titel-Nr.', 'Bezeichnung', 'Ansatz', 'Ist', 'Diff'],
      ['1.1', 'Personal', 120, 110, 10],
      ['1.2', 'Sachmittel', 50, 0, 50],
      ['2.1', 'Projekte', 1000, 250.5, 749.5],
    ])
  })

  it('ods: CSV bytes under the ODS MIME (ExcelJS has no ODS writer — native parity)', async () => {
    const { body, contentType } = await buildBudgetExport(LINES, 'ods')
    expect(contentType).toBe('application/vnd.oasis.opendocument.spreadsheet')
    const text = body.toString('utf8')
    expect(text).toContain('Titel-Nr.,Bezeichnung,Ansatz,Ist,Diff')
    expect(text).toContain('1.1,Personal,120,110,10')
  })

  it('two generations have identical CONTENT (cell matrix) with timestamps normalized away', async () => {
    const a = await buildBudgetExport(LINES, 'xlsx')
    const b = await buildBudgetExport(LINES, 'xlsx')
    const load = async (buf: Buffer) => {
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
      const rows: unknown[][] = []
      wb.worksheets[0]!.eachRow((r) => rows.push((r.values as unknown[]).slice(1)))
      return rows
    }
    expect(await load(a.body)).toEqual(await load(b.body))
  })

  it('an empty projection still yields a parseable workbook with just the header row', async () => {
    const { body } = await buildBudgetExport([], 'xlsx')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer)
    expect(wb.worksheets[0]!.rowCount).toBe(1)
  })
})
