// packages/member-import/src/csv.ts — the member list's wire format: RFC 4180
// CSV with the header `name,email,body,role` (brief Q6). PURE. The list is
// refused as a whole (not row by row) when it is not CSV at all: no header,
// an unknown column, an unterminated quote, more rows than the cap.

export const MAX_ROWS = 2000
export const MAX_BYTES = 1_048_576
export const COLUMNS = ['name', 'email', 'body', 'role'] as const

export class ListFormatError extends Error {
  constructor(
    readonly code: 'empty' | 'too_large' | 'too_many_rows' | 'bad_header' | 'unterminated_quote' | 'bad_row_width',
    message: string,
  ) {
    super(message)
    this.name = 'ListFormatError'
  }
}

export interface RawRow {
  /** Spreadsheet row number: the header is row 1, the first record row 2. */
  row: number
  name: string
  email: string
  body: string
  role: string
}

/** RFC 4180 records of `text` (quotes, doubled quotes, CRLF or LF, embedded newlines). */
export function parseRecords(text: string): string[][] {
  const out: string[][] = []
  let rec: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const endField = () => {
    rec.push(field)
    field = ''
  }
  const endRecord = () => {
    endField()
    // a blank line is not a record
    if (!(rec.length === 1 && rec[0] === '')) out.push(rec)
    rec = []
  }
  while (i < src.length) {
    const c = src[i]!
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"' && field === '') {
      quoted = true
      i++
    } else if (c === ',') {
      endField()
      i++
    } else if (c === '\r') {
      endRecord()
      i += src[i + 1] === '\n' ? 2 : 1
    } else if (c === '\n') {
      endRecord()
      i++
    } else {
      field += c
      i++
    }
  }
  if (quoted) throw new ListFormatError('unterminated_quote', 'the list ends inside a quoted field')
  if (field !== '' || rec.length > 0) endRecord()
  return out
}

/** The list's rows, or a ListFormatError naming why the whole list is unreadable. */
export function parseList(text: string): RawRow[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new ListFormatError('too_large', `the list exceeds ${MAX_BYTES} bytes`)
  const records = parseRecords(text)
  if (records.length === 0) throw new ListFormatError('empty', 'the list is empty')
  const header = records[0]!.map((h) => h.normalize('NFC').trim().toLowerCase())
  const unknown = header.filter((h) => !(COLUMNS as readonly string[]).includes(h))
  const missing = (['name', 'email', 'body'] as const).filter((h) => !header.includes(h))
  const repeated = [...new Set(header.filter((h, i) => header.indexOf(h) !== i && (COLUMNS as readonly string[]).includes(h)))]
  if (unknown.length || missing.length || new Set(header).size !== header.length) {
    // NEVER the parsed header cells: a headerless list makes its first member's
    // name and address the "header", and this message lands in the append-only
    // request events and the audit log. Counts and the fixed column names only.
    const parts = [`${header.length} columns read`]
    if (unknown.length) parts.push(`${unknown.length} unknown`)
    parts.push(`missing: ${missing.length ? missing.join(', ') : 'none'}`)
    if (repeated.length) parts.push(`repeated: ${repeated.join(', ')}`)
    throw new ListFormatError('bad_header', `the header must be ${COLUMNS.join(',')} (role optional); ${parts.join('; ')}`)
  }
  const data = records.slice(1)
  if (data.length > MAX_ROWS) throw new ListFormatError('too_many_rows', `the list has ${data.length} rows; the cap is ${MAX_ROWS}`)
  return data.map((r, n) => {
    if (r.length !== header.length) {
      throw new ListFormatError('bad_row_width', `row ${n + 2} has ${r.length} fields, the header has ${header.length}`)
    }
    const get = (col: string) => {
      const k = header.indexOf(col)
      return k < 0 ? '' : (r[k] ?? '')
    }
    return { row: n + 2, name: get('name'), email: get('email'), body: get('body'), role: get('role') }
  })
}
