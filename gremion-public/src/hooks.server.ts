import type { Handle } from '@sveltejs/kit'
import { sequence } from '@sveltejs/kit/hooks'
import { createI18nHandle } from '$lib/i18n/server/i18n-handle'

/**
 * #259-2: app-layer security headers for the PUBLIC portal.
 *
 * gremion-public previously set NO security headers (no CSP, no anti-framing),
 * unlike gremion-ui which attaches a defence-in-depth CSP in its cspGuard. The
 * portal renders server-side-sanitized HTML via {@html} (protokolle/[id]);
 * this header is the browser-enforced second layer if the
 * DOMPurify allowlist ever misses a payload, and it blocks the read-only public
 * pages from being framed cross-origin (clickjacking).
 *
 * Posture mirrors gremion-ui's CSP where it makes sense, with two deliberate
 * differences for this site:
 *   - frame-ancestors 'none': the portal embeds nothing and needs no framing,
 *     so it can use the strongest anti-clickjacking value (gremion-ui uses 'self'
 *     only because it embeds the same-origin Element Call iframe).
 *   - style-src / font-src allow Google Fonts: app.html loads the Inter /
 *     Archivo Narrow / JetBrains Mono stylesheet from fonts.googleapis.com and
 *     the font files from fonts.gstatic.com.
 *
 * 'unsafe-inline' on script-src is kept for the same reason as gremion-ui:
 * SvelteKit 2 injects an inline hydration <script>. Closing it requires the
 * kit.csp nonce migration (see gremion-ui/src/hooks.server.ts) and is out of
 * scope for simply establishing the missing header here.
 *
 * The header is attached only to text/html responses — JSON/asset replies are
 * unaffected (CSP only applies when the body is parsed as a document).
 */
export const CSP_HEADER_VALUE = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

export const securityHeadersHandle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event)
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.startsWith('text/html')) {
    response.headers.set('Content-Security-Policy', CSP_HEADER_VALUE)
    // Belt-and-braces anti-framing for legacy UAs that ignore frame-ancestors.
    response.headers.set('X-Frame-Options', 'DENY')
    response.headers.set('X-Content-Type-Options', 'nosniff')
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  }
  return response
}

// TASK-062 (brief §3): the one hooks.server.ts change this unit is granted
// here. i18nHandle runs first so its transformPageChunk rewrite of app.html's
// `lang="de"` lands before securityHeadersHandle's own resolve() completes.
export const i18nHandle: Handle = createI18nHandle()

export const handle = sequence(i18nHandle, securityHeadersHandle)
