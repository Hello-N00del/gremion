// GET /api/public/protocols/[id]/pdf — public (no-auth) download of a PUBLISHED
// protocol PDF. #241: the anonymous public portal (gremion-public) no longer holds
// Nextcloud credentials; it redirects the browser HERE, where the main app holds
// the NC creds legitimately. Exempted from the session guard in hooks.server.ts
// (publicPaths), but the tenant resolver still runs, so the request resolves its
// tenant from the edge-forwarded host like any other browser request.
//
// Defence in depth: this endpoint is directly reachable (not only via
// gremion-public), so it independently enforces status='published' AND public
// org-unit visibility, validates the stored PDF path, and only then streams.
import { error } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { getPublishedProtocolPdfPath } from '$lib/server/protocols/protocol-db'
import { getProtocolDocumentPort } from '$lib/server/modules/runtime-registry'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const GET: RequestHandler = async ({ params }) => {
  // Reject non-UUID ids up front (the column is a UUID; a bad cast would 500).
  if (!UUID_RE.test(params.id)) throw error(404, 'Not found')

  const pdfPath = await getPublishedProtocolPdfPath(params.id)
  if (!pdfPath) throw error(404, 'PDF not available')

  // A3a-2: the published-PDF download comes from the files module's document port.
  const docs = getProtocolDocumentPort()
  if (!docs) throw error(503, 'Dokumentdienst nicht verfügbar')

  const res = await docs.downloadPublishedPdf(pdfPath)
  if (!res.ok) throw error(502, 'PDF not available from storage')

  return new Response(res.body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="protokoll-${params.id}.pdf"`,
      // #241: short cache, NOT the previous 24h `public, max-age=86400` — a
      // withdrawn protocol must not linger in shared caches for a day.
      'Cache-Control': 'public, max-age=300',
    },
  })
}
