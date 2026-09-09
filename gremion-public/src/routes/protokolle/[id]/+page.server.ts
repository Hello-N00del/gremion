// gremion-public/src/routes/protokolle/[id]/+page.server.ts
import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getPublishedProtocolById } from '$lib/server/public-db';
import { sanitizeHtml } from '$lib/sanitize';
import { isUuid } from '$lib/validate';

export const load: PageServerLoad = async ({ params }) => {
  const id = params.id;
  // #262 D5: reject a non-UUID id with a 404 BEFORE it reaches `${id}::uuid`,
  // which would otherwise 500 with "invalid input syntax for type uuid" on a
  // fully public, scriptable route.
  if (!id || !isUuid(id)) error(404, 'Protokoll nicht gefunden');

  const protocol = await getPublishedProtocolById(id);
  if (!protocol) error(404, 'Protokoll nicht gefunden');

  return {
    protocol: {
      ...protocol,
      body_html: sanitizeHtml(protocol.body_html ?? ''),
    },
  };
};
