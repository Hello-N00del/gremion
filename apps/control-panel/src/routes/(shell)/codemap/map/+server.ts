// GET /codemap/map: the generated code map page, for the iframe of /codemap. GET only (no other method is
// exported, so SvelteKit answers 405). The file name is fixed in $lib/server/codemap; nothing from the request
// reaches a path. The panel's CSP (hooks.server.ts) rides on this text/html response like on every other.
import { readMapHtml, readStatus } from '$lib/server/codemap'
import type { RequestHandler } from './$types'

const notFound = () =>
  new Response('404 the code map is not available in this image\n', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })

export const GET: RequestHandler = () => {
  // ok:false means the build step refused or failed: never serve a page it left behind.
  if (!readStatus().ok) return notFound()
  const html = readMapHtml()
  if (html === null) return notFound()
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}
