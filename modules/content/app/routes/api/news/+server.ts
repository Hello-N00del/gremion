// POST /api/news — create a new news post (CouncilAdmin only)
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { hasRole, Role } from '$lib/auth';
import type { SessionUser } from '$lib/auth/types';
import { createNewsPost } from '$lib/server/news/news-db';

export const POST: RequestHandler = async (event) => {
  const session = await event.locals.auth();
  const user = session?.user as SessionUser | undefined;
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    throw error(403, 'Forbidden');
  }

  let body: unknown;
  try {
    body = await event.request.json();
  } catch {
    throw error(400, 'Invalid JSON');
  }

  const { title } = body as { title?: string };
  if (!title?.trim()) throw error(400, 'title is required');

  const post = await createNewsPost(title.trim(), user.id);
  return json(post, { status: 201 });
};
