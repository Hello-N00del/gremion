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
 * File types that the browser can render natively when served inline.
 * These get an "Öffnen" button that streams the file with Content-Disposition: inline.
 * Markdown and plain text are included for in-browser text viewing.
 */
export const VIEWABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.txt',
  '.md',
])

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
