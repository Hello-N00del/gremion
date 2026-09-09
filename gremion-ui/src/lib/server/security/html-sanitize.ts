// Shared rich-HTML sanitizer for server-stored body_html fields.
//
// Originated as the protocol sanitizer for G-011 (XSS in
// {@html bodyHtml} on the protocol detail page). Generalised here so
// the news flow (G-011 analog: same risk class — Collabora-converted
// HTML and user-PATCHed body_html both rendered via {@html}) shares
// one well-tested implementation.
//
// Why a single allowlist for both surfaces: protocols and news both
// originate from LibreOffice ODT files converted via Collabora — the
// tag set LibreOffice emits is identical across the two flows.
// Diverging would cause silent allowlist drift; converging now means
// hardening one allowlist hardens both.

import DOMPurify from 'isomorphic-dompurify'

const SAFE_RICH_HTML_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'em', 'u', 'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'a', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'img', 'blockquote', 'hr', 'span', 'div',
  ],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'colspan', 'rowspan'],
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'],
  ALLOW_DATA_ATTR: false,
}

// DOMPurify v3 permits `data:` URIs on <img src> by default (only the
// `javascript:` scheme is blocked outright). A `data:image/svg+xml,…` URI
// can carry an inline SVG with its own <script> — a documented XSS bypass —
// and base64 phishing imagery is a separate risk. A hook lets us drop any
// `data:` (and `javascript:`/`vbscript:`) URI from href/src/xlink:href
// without breaking safe http/https/mailto/tel references.
const URI_ATTRS_TO_FILTER = new Set(['href', 'src', 'xlink:href'])
const FORBIDDEN_URI_SCHEMES = /^\s*(?:data|javascript|vbscript):/i

DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (URI_ATTRS_TO_FILTER.has(data.attrName) && FORBIDDEN_URI_SCHEMES.test(data.attrValue)) {
    data.keepAttr = false
  }
})

/**
 * Sanitize rich HTML (LibreOffice/Collabora output or user-PATCHed
 * body_html) before persisting OR rendering via `{@html …}`.
 *
 * The allowlist matches the protocol-document tag set (paragraphs,
 * inline emphasis, lists, headings, anchors, images, tables,
 * blockquote, hr, span, div). Scripts, styles, iframes, objects,
 * and embeds are stripped. `data:` / `javascript:` / `vbscript:`
 * URIs are dropped from href/src/xlink:href via an
 * uponSanitizeAttribute hook.
 */
export function sanitizeRichHtml(rawHtml: string): string {
  return DOMPurify.sanitize(rawHtml, SAFE_RICH_HTML_CONFIG)
}
