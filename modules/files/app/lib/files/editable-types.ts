/**
 * File types supported by the collaborative editor (Collabora Online via
 * Nextcloud richdocuments). Keep in sync with `configure-richdocuments.sh`
 * which configures Nextcloud to route these MIME types through richdocuments.
 */
export const EDITABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.odt',
  '.docx',
  '.ods',
  '.odp',
  '.pdf',
])

/**
 * The fixed Content-Type served for each viewable extension. The files route
 * never echoes the upstream (Nextcloud) Content-Type: that value follows the
 * uploaded file, so an attacker chooses it. Markdown and plain text are served
 * as text/plain, never as a renderable document type.
 *
 * F1-FIX-03 / H17: `.svg` is NOT here. An SVG is a document that can carry
 * <script>; served inline from the app origin it ran with the viewer's session.
 * It downloads as an attachment like any other non-viewable file.
 */
const VIEWABLE_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
})

/**
 * File types that the browser can render natively when served inline.
 * These get an "Öffnen" button that streams the file with Content-Disposition: inline.
 * Markdown and plain text are included for in-browser text viewing.
 */
export const VIEWABLE_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(VIEWABLE_CONTENT_TYPES))

/**
 * The Content-Type the files route sends for `filename`: the fixed type of a
 * viewable extension, else application/octet-stream. Never derived from the
 * upstream response.
 */
export function fileResponseContentType(filename: string): string {
  return VIEWABLE_CONTENT_TYPES[getFileExtension(filename)] ?? 'application/octet-stream'
}

/**
 * Extract the lowercase file extension (including the dot) from a file name.
 * Returns an empty string for files without an extension (e.g. directories,
 * dotfiles with no extension, or empty strings).
 */
export function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.')
  if (lastDot < 1) return ''
  return filename.slice(lastDot).toLowerCase()
}

/**
 * Returns true if the given file name has an extension that can be opened in
 * the collaborative editor. Directories and files without extensions return
 * false. Case-insensitive.
 */
export function isEditableFile(filename: string): boolean {
  return EDITABLE_EXTENSIONS.has(getFileExtension(filename))
}

export function isViewableFile(filename: string): boolean {
  return VIEWABLE_EXTENSIONS.has(getFileExtension(filename))
}
