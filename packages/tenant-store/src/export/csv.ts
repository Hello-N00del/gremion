// RFC 4180 CSV (CRLF, quotes doubled) of rows as postgres-js returns them.
// null -> empty field; Date -> ISO 8601 UTC; bytea -> base64; objects/arrays
// (json, jsonb, arrays) -> JSON text.
//
// MED-2: CSV files get opened in spreadsheets, which run a cell that starts
// with = + - @ (or a tab / CR before one) as a formula. A TEXT value starting
// with one of those characters is written with a leading apostrophe; numbers
// stay as they are, including the numeric / int8 columns the driver hands back
// as strings (a finance amount of -12.50 is a value, not text): the caller
// names those columns (plain). The JSON files carry every value unchanged, and the rule
// is stated in manifest.json (csv_formula_guard).

export function cell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString()
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64')
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'object') return JSON.stringify(v, jsonReplacer)
  return String(v as string | number | boolean)
}

export function jsonReplacer(_k: string, v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64')
  return v
}

export function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export const CSV_FORMULA_GUARD =
  "CSV only: a text cell starting with = + - @ tab or carriage return is prefixed with an apostrophe (') so a spreadsheet does not run it as a formula; numeric columns (numeric, int8) are written as they are; the JSON files hold every value unchanged"

const FORMULA_START = /^[=+\-@\t\r]/

/** Column types the driver returns as strings although they are numbers: numeric and int8 (pg_type oids). */
export const NUMBER_AS_STRING_TYPES: ReadonlySet<number> = new Set([1700, 20])

/** The cell text with the formula guard applied to text values (not to a `plain` numeric column). */
export function guardedCell(v: unknown, plain = false): string {
  const s = cell(v)
  return !plain && typeof v === 'string' && FORMULA_START.test(s) ? `'${s}` : s
}

/** `plain[i]` marks column i as a numeric type: its string value is written as it is. */
export function csvLine(values: readonly unknown[], plain: readonly boolean[] = []): string {
  return values.map((v, i) => csvField(guardedCell(v, plain[i] === true))).join(',') + '\r\n'
}
