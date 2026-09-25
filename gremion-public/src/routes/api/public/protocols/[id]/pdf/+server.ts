// GET /api/public/protocols/[id]/pdf
// #241: the anonymous, internet-facing public portal no longer holds Nextcloud
// credentials. After a creds-free "is this protocol published?" check it
// redirects the browser to the MAIN APP (gremion-ui), which holds the NC creds
// legitimately and streams the PDF from its own /api/public/protocols/[id]/pdf
// route. The browser reaches gremion-ui with its own Host header, so gremion-ui's
// tenant resolver selects the (default) tenant normally — unlike a server-to-
// server internalFetch, which would 404 at the fail-closed resolver.
import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPublishedProtocolById } from '$lib/server/public-db';
// TASK-032 (TRD-410 [D R20-D5]): reads process.env directly rather than
// $env/dynamic/public — see +layout.server.ts's header comment.
import { isUuid } from '$lib/validate';

export const GET: RequestHandler = async ({ params }) => {
  // #262 D5: reject a non-UUID id with a 404 BEFORE it reaches `${id}::uuid`,
  // which would otherwise 500 on this public, scriptable endpoint.
  if (!isUuid(params.id)) throw error(404, 'Not found');
  const protocol = await getPublishedProtocolById(params.id);
  if (!protocol) throw error(404, 'Not found');
  if (!protocol.pdf_nextcloud_path) throw error(404, 'PDF not available');

  // PUBLIC_MAIN_APP_URL is the main app's public origin (apex = default tenant),
  // already injected for the portal's "main app" links.
  //
  // v12: this is deliberately NOT prefixed with the portal's `kit.paths.base`.
  // The target is the MAIN APP's own route; only the portal can be relocated
  // under a base path. Named `mainAppOrigin`, not `base`, so it can never be
  // confused with the portal base path from `$app/paths`.
  const mainAppOrigin = (process.env.PUBLIC_MAIN_APP_URL ?? '').replace(/\/+$/, '');
  if (!mainAppOrigin) throw error(500, 'Main app URL not configured');

  throw redirect(302, `${mainAppOrigin}/api/public/protocols/${params.id}/pdf`);
};
