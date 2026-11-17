/**
 * The file name as a person reads it. SvelteKit decodes the `[...path]` parameter once, so a link encoded once
 * already arrives as `Protokoll Sitzung.docx`. A link encoded twice (`Protokoll%2520Sitzung.docx`, for instance a
 * shared or pasted URL) still carries `Protokoll%20Sitzung.docx` after that; decoding once more shows the name the
 * loader opens. A malformed escape (a lone `%`, `%E0%A4%A`) makes decodeURIComponent throw; the raw text is then
 * shown unchanged. The result is only ever rendered as text.
 */
export function readableFileName(raw: string): string {
  const lastSegment = raw.split('/').pop() ?? raw
  try {
    return decodeURIComponent(lastSegment)
  } catch {
    return lastSegment
  }
}
