// services/finance/src/exports/xlsx.ts
// #383 Lane E3 — budget export workbook (leaf side of exportBudget). Ported verbatim
// from the native oracle gremion-ui/.../services/read/statement.ts#exportBudget.
//
// ExcelJS workbook with German column headers (sub-spec §7.3 Q3). ODS is not natively
// writable by ExcelJS, so — exactly like the native — an .ods request emits CSV under
// the ODS MIME until a native writer lands. The returned Buffer is exact-size (the
// pooled-buffer lesson: writeBuffer / csv.writeBuffer return their own tight buffer,
// never a slice aliasing a shared pool).
import ExcelJS from 'exceljs'
import type { StatementLine } from '../store/index.js'

export interface BudgetExport {
  body: Buffer
  contentType: string
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const ODS_MIME = 'application/vnd.oasis.opendocument.spreadsheet'

/** Build the budget export workbook for a plan's projected Titel lines. `xlsx` →
 *  a real .xlsx workbook; `ods` → CSV under the ODS MIME (ExcelJS has no ODS writer,
 *  native parity). */
export async function buildBudgetExport(
  lines: readonly StatementLine[],
  format: 'xlsx' | 'ods',
): Promise<BudgetExport> {
  const wb = new ExcelJS.Workbook()
  const sheet = wb.addWorksheet('Haushalt')
  // German column headers per sub-spec §7.3 Q3 default.
  sheet.addRow(['Titel-Nr.', 'Bezeichnung', 'Ansatz', 'Ist', 'Diff'])
  for (const l of lines) {
    sheet.addRow([l.titel_nr, l.titel_name, l.ansatz / 100, l.ist / 100, (l.ansatz - l.ist) / 100])
  }
  if (format === 'xlsx') {
    return { body: toExactBuffer(await wb.xlsx.writeBuffer()), contentType: XLSX_MIME }
  }
  return { body: toExactBuffer(await wb.csv.writeBuffer()), contentType: ODS_MIME }
}

/** Copy the ExcelJS writeBuffer result into an EXACT-SIZE standalone Buffer. The
 *  ExcelJS types say ArrayBuffer but the node runtime returns a Buffer; either way
 *  the explicit slice-copy guarantees the response body never aliases a shared /
 *  pooled allocation and its byteLength is exactly the payload size (the
 *  pooled-buffer lesson). */
function toExactBuffer(buf: ArrayBuffer | Uint8Array): Buffer {
  return buf instanceof Uint8Array
    ? Buffer.from(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    : Buffer.from(new Uint8Array(buf).slice())
}
