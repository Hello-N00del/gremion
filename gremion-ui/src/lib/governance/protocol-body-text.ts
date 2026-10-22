// R33b: the plain-text editor for the in-app protocol body (protocols.body_html).
// Text is escaped here and sanitized again on the server on write (G-011).

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }

function escapeHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Blank lines separate paragraphs; single newlines become <br>. */
export function textToBodyHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

export function bodyHtmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m])
    .trim()
}

/** True when the body only uses paragraphs and line breaks (nothing the plain editor would flatten). */
export function isPlainBody(html: string | null | undefined): boolean {
  if (!html) return true
  return !/<(?!\/?(?:p|br)\b)[a-z]/i.test(html)
}
