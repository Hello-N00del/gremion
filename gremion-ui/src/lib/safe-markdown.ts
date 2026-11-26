// A small Markdown renderer for the documents the app generates itself (the Loeschkonzept and the
// Verzeichnis von Verarbeitungstaetigkeiten): headings, bold, italic, pipe tables, "- " lists, a
// horizontal rule and paragraphs. It has no raw-HTML pass-through and no links: every character of
// the source is escaped first, and the only markup in the output is what this file writes itself.

export interface SafeMarkdownOptions {
  /** The heading level a single "#" becomes (1-6); deeper marks shift with it and stop at h6. */
  baseHeading?: number
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] as string)
}

/** Inline marks on text that is escaped first: **bold** and *italic*. */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=[^*\s])(.+?)(?<=[^*\s])\*(?![*\w])/g, '$1<em>$2</em>')
}

const TABLE_RULE = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/
const HEADING = /^(#{1,6})\s+(.*\S)\s*$/
const RULE = /^(-{3,}|\*{3,}|_{3,})\s*$/
const LIST_ITEM = /^[-*]\s+(.*)$/

function cells(line: string): string[] {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|')) body = body.slice(0, -1)
  return body.split('|').map((c) => c.trim())
}

const TABLE_CLASS = 'w-full border-collapse text-left text-xs'
const CELL_CLASS = 'border border-border-strong px-2 py-1 align-top'

function startsBlock(line: string, next: string | undefined): boolean {
  if (HEADING.test(line) || RULE.test(line) || LIST_ITEM.test(line)) return true
  return line.trimStart().startsWith('|') && next !== undefined && TABLE_RULE.test(next.trim())
}

export function renderSafeMarkdown(source: string, options: SafeMarkdownOptions = {}): string {
  const base = Math.min(6, Math.max(1, options.baseHeading ?? 1))
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string
    if (line.trim() === '') {
      i++
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      const level = Math.min(6, base + (heading[1] as string).length - 1)
      out.push(`<h${level} class="mt-4 mb-2 font-semibold">${inline(heading[2] as string)}</h${level}>`)
      i++
      continue
    }
    if (RULE.test(line)) {
      out.push('<hr class="my-4 border-border-strong">')
      i++
      continue
    }
    if (line.trimStart().startsWith('|') && TABLE_RULE.test((lines[i + 1] ?? '').trim())) {
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && (lines[i] as string).trimStart().startsWith('|')) {
        rows.push(cells(lines[i] as string))
        i++
      }
      out.push(
        `<table class="${TABLE_CLASS}"><thead><tr>${head
          .map((c) => `<th scope="col" class="${CELL_CLASS}">${inline(c)}</th>`)
          .join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td class="${CELL_CLASS}">${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      )
      continue
    }
    if (LIST_ITEM.test(line)) {
      const items: string[] = []
      while (i < lines.length && LIST_ITEM.test(lines[i] as string)) {
        items.push(inline((LIST_ITEM.exec(lines[i] as string) as RegExpExecArray)[1] as string))
        i++
      }
      out.push(`<ul class="my-2 list-disc pl-5">${items.map((x) => `<li>${x}</li>`).join('')}</ul>`)
      continue
    }
    const para: string[] = []
    while (i < lines.length && (lines[i] as string).trim() !== '' && (para.length === 0 || !startsBlock(lines[i] as string, lines[i + 1]))) {
      para.push((lines[i] as string).trim())
      i++
    }
    out.push(`<p class="my-2">${para.map(inline).join('<br>')}</p>`)
  }
  return out.join('\n')
}
