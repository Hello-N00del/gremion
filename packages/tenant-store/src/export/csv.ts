// RFC 4180 CSV (CRLF, quotes doubled) of rows as postgres-js returns them.
// null -> empty field; Date -> ISO 8601 UTC; bytea -> base64; objects/arrays
// (json, jsonb, arrays) -> JSON text. Fields are data, not spreadsheet
// formulas: a consumer opens the file as text.

export function cell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString()
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64')
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'object') return JSON.stringify(v, jsonReplacer)
  return String(v)
}

export function jsonReplacer(_k: string, v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64')
  return v
}

export function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export function csvLine(values: readonly unknown[]): string {
  return values.map((v) => csvField(cell(v))).join(',') + '\r\n'
}
