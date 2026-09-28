// services/finance/src/http/multipart.ts
// #383 Lane E, (c) — a minimal multipart/form-data parser for the leaf's byte-in
// ops (uploadReceipt / csvImport). The JSON-only route surface reads the request as
// UTF-8 text; a binary upload must instead be buffered raw and split here.
//
// Correctness pin (the pooled-buffer lesson): node concatenates the request chunks
// into a single (possibly pooled) Buffer. Each part's data is COPIED out with
// Buffer.from(subarray) so it does not alias the request buffer — otherwise a later
// reuse of that memory would silently corrupt a stored receipt. The parser also
// strips ONLY the framing CRLF that precedes each boundary, leaving payload bytes
// (including a payload that itself ends in CR/LF) exactly N bytes.

const DASH = 0x2d // '-'
const CR = 0x0d
const LF = 0x0a
const HEADER_SEP = Buffer.from('\r\n\r\n')

export interface MultipartPart {
  /** form-field name (Content-Disposition name="…"). */
  name: string
  /** file name when the part is a file upload (Content-Disposition filename="…"). */
  filename?: string
  /** the part's Content-Type header, when present. */
  contentType?: string
  /** the part's raw bytes, copied out of the request buffer (exact size). */
  data: Buffer
}

/** Extract the boundary token from a `multipart/form-data; boundary=…` header. */
export function parseBoundary(contentType: string | undefined): string | null {
  if (!contentType) return null
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  if (!m) return null
  const raw = m[1] ?? m[2]
  const b = raw?.trim()
  return b && b.length > 0 ? b : null
}

/** Parse a single part's headers (Content-Disposition + Content-Type). */
function parsePartHeaders(headerText: string): { name?: string; filename?: string; contentType?: string } {
  let name: string | undefined
  let filename: string | undefined
  let contentType: string | undefined
  for (const line of headerText.split('\r\n')) {
    const lower = line.toLowerCase()
    if (lower.startsWith('content-disposition:')) {
      name = /name="([^"]*)"/i.exec(line)?.[1]
      filename = /filename="([^"]*)"/i.exec(line)?.[1]
    } else if (lower.startsWith('content-type:')) {
      contentType = line.slice(line.indexOf(':') + 1).trim()
    }
  }
  return { name, filename, contentType }
}

/**
 * Split a buffered multipart/form-data body into its parts. Returns [] when no
 * well-formed part is found (a non-multipart body, or a missing boundary).
 */
export function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const delim = Buffer.from(`--${boundary}`)
  const parts: MultipartPart[] = []

  // Collect every delimiter offset; a real part sits between consecutive delimiters.
  const offsets: number[] = []
  for (let i = body.indexOf(delim, 0); i !== -1; i = body.indexOf(delim, i + delim.length)) {
    offsets.push(i)
  }

  for (let k = 0; k < offsets.length - 1; k++) {
    let start = offsets[k]! + delim.length
    // A closing delimiter is `--boundary--`; if `--` follows, this offset is the
    // terminator, not the start of a part.
    if (body[start] === DASH && body[start + 1] === DASH) continue
    // The delimiter line ends in CRLF before the part headers.
    if (body[start] === CR && body[start + 1] === LF) start += 2

    const headerEnd = body.indexOf(HEADER_SEP, start)
    if (headerEnd === -1 || headerEnd >= offsets[k + 1]!) continue
    const headerText = body.subarray(start, headerEnd).toString('utf8')
    const dataStart = headerEnd + HEADER_SEP.length

    // Data ends just before the next delimiter, minus the framing CRLF the sender
    // inserts between the payload and that delimiter.
    let dataEnd = offsets[k + 1]!
    if (dataEnd >= dataStart + 2 && body[dataEnd - 2] === CR && body[dataEnd - 1] === LF) {
      dataEnd -= 2
    }

    // COPY out of the (pooled) request buffer — never alias it.
    const data = Buffer.from(body.subarray(dataStart, dataEnd))
    const { name, filename, contentType } = parsePartHeaders(headerText)
    if (name !== undefined) parts.push({ name, filename, contentType, data })
  }

  return parts
}
