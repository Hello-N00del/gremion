// PATCH / DELETE /api/news/[id] — update, publish, unpublish, delete a news post (CouncilAdmin only)
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { hasRole, Role } from '$lib/auth';
import type { SessionUser } from '$lib/auth/types';
import { isInternalBearerRequest } from '$lib/server/internal-fetch';
import {
  getNewsPostById,
  updateNewsBodyHtml,
  publishNewsPost,
  unpublishNewsPost,
  deleteNewsPost,
} from '$lib/server/news/news-db';
import { sanitizeRichHtml } from '$lib/server/security/html-sanitize';

export const PATCH: RequestHandler = async (event) => {
  // G-075: accept either a CouncilAdmin session OR a trusted internal
  // Bearer header (from internalFetch — used by news/[id]/edit page
  // actions calling this endpoint in-process). Mirrors the minutes
  // dual-auth shape.
  if (!isInternalBearerRequest(event.request)) {
    const session = await event.locals.auth();
    const user = session?.user as SessionUser | undefined;
    if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
      throw error(403, 'Forbidden');
    }
  }

  const id = Number(event.params.id);
  if (isNaN(id)) throw error(400, 'Invalid ID');

  const post = await getNewsPostById(id);
  if (!post) throw error(404, 'Not found');

  let body: unknown;
  try {
    body = await event.request.json();
  } catch {
    throw error(400, 'Invalid JSON');
  }

  const { action, body_html } = body as { action?: string; body_html?: string };

  if (action === 'publish') {
    await publishNewsPost(id);
  } else if (action === 'unpublish') {
    await unpublishNewsPost(id);
  } else if (body_html !== undefined) {
    // G-011 analog: sanitize user-PATCHed body_html at the trust boundary
    // before storage. news-db.updateNewsBodyHtml also sanitizes as a second
    // defensive layer; both passes are idempotent.
    await updateNewsBodyHtml(id, sanitizeRichHtml(body_html));
  } else {
    throw error(400, 'Invalid PATCH body — provide action or body_html');
  }

  return json({ ok: true });
};

export const DELETE: RequestHandler = async (event) => {
  const session = await event.locals.auth();
  const user = session?.user as SessionUser | undefined;
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    throw error(403, 'Forbidden');
  }

  const id = Number(event.params.id);
  if (isNaN(id)) throw error(400, 'Invalid ID');

  const post = await getNewsPostById(id);
  if (!post) throw error(404, 'Not found');

  await deleteNewsPost(id);
  return json({ ok: true });
};
