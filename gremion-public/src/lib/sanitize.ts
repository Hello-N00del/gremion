// gremion-public/src/lib/sanitize.ts
// HTML sanitisation for Collabora-generated body_html rendered in the public portal.
// Uses isomorphic-dompurify so it works in both SSR (Node) and browser contexts.

import DOMPurify from 'isomorphic-dompurify';

/**
 * Sanitises Collabora-generated HTML before rendering in the public portal.
 * Strips all scripts, event handlers, and dangerous attributes.
 * Allows a common set of structural HTML tags.
 */
export function sanitizeHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS: [
      'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li',
      'blockquote', 'pre', 'code',
      'a', 'img',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
      'hr', 'span', 'div', 'section', 'article',
      'sup', 'sub',
    ],
    ALLOWED_ATTR: [
      'href', 'title', 'alt', 'src', 'width', 'height',
      'class', 'id', 'colspan', 'rowspan',
      'target', 'rel',
    ],
    // Force all links to be safe (no javascript: URIs)
    FORCE_BODY: true,
    // Prevent DOM clobbering
    SANITIZE_DOM: true,
  });
}
