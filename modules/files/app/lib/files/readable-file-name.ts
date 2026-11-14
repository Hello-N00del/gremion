/**
 * The file name as a person reads it. The editor route hands over the last path segment as it came in the URL, so
 * a name with a space arrives as `Protokoll%20Sitzung.docx`. A malformed escape (a lone `%`, `%E0%A4%A`) makes
 * decodeURIComponent throw; the raw text is then shown unchanged. The result is only ever rendered as text.
 */
export function readableFileName(raw: string): string {
  const lastSegment = raw.split('/').pop() ?? raw
  try {
    return decodeURIComponent(lastSegment)
  } catch {
    return lastSegment
  }
}
