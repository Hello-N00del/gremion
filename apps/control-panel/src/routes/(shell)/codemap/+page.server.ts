// The "Code-Karte" page: what the image build made of the code, read here (server-side) from the fixed files in
// CODEMAP_DIR. The gate in hooks.server.ts already ran. A missing map, or a map page that cannot be served, is a notice, never an error page.
import { checkMap, readStatus } from '$lib/server/codemap'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = () => {
  const status = readStatus()
  // A status that says ok does not promise a page that can be served: without it the iframe would show a bare 404.
  // A status that is not ok already says why there is no map, so the page is not looked at then.
  const map = status.ok ? checkMap() : { readable: false, reason: null }
  return { status, map }
}
