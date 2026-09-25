import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { hasRole, Role } from '$lib/auth';
import type { SessionUser } from '$lib/auth/types';
import { listNewsPosts } from '$lib/server/news/news-db';
import { getKeycloakAdminClient } from '$lib/server/keycloak-admin';

export const load: PageServerLoad = async ({ locals }) => {
  const session = await locals.auth();
  const user = session?.user as SessionUser | undefined;
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    throw error(403, 'Forbidden');
  }
  const posts = await listNewsPosts();

  // v5 Task 4.3 — resolve the Autor·in label for each post (prototype shows the
  // author's name, not the raw Keycloak id). Best-effort + cached per author so a
  // Keycloak hiccup degrades to the id rather than failing the page. Gremium
  // (org-unit) and Aufrufe are forward-shape — news_posts carries neither column
  // yet — so the page renders them as "—"/0 placeholders without inventing data.
  const authorIds = [...new Set(posts.map((p) => p.author_id))];
  const authorLabels = new Map<string, string>();
  await Promise.all(
    authorIds.map(async (id) => {
      let label = id;
      try {
        const u = await getKeycloakAdminClient(locals.tenant).getUser(id);
        const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
        label = name || u.username || id;
      } catch {
        label = id;
      }
      authorLabels.set(id, label);
    }),
  );

  const postsWithAuthor = posts.map((p) => ({
    ...p,
    authorLabel: authorLabels.get(p.author_id) ?? p.author_id,
  }));

  return { posts: postsWithAuthor };
};
