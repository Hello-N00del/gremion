import type { PageServerLoad, Actions } from './$types';
import { error } from '@sveltejs/kit';
import { hasRole, Role } from '$lib/auth';
import type { SessionUser } from '$lib/auth/types';
import { getNewsPostById, updateNewsBodyHtml } from '$lib/server/news/news-db';
import { createNextcloudClient } from '$lib/server/files/nextcloud-client';
import { createEmptyOdt, convertOdtToHtml } from '$lib/server/newsletter/collabora-convert';
import { sanitizeRichHtml } from '$lib/server/security/html-sanitize';
import { internalFetch } from '$lib/server/internal-fetch';

const ADMIN_USER = 'admin';

async function ensureDraftFile(id: number): Promise<string> {
  const nc = createNextcloudClient();
  const folderPath = `/remote.php/dav/files/${ADMIN_USER}/news-posts/drafts`;
  const filePath = `${folderPath}/${id}.odt`;

  // Ensure the drafts folder exists
  try {
    await nc.mkcol(`/remote.php/dav/files/${ADMIN_USER}/news-posts`, ADMIN_USER);
  } catch {
    // Folder already exists — ignore
  }
  try {
    await nc.mkcol(folderPath, ADMIN_USER);
  } catch {
    // Folder already exists — ignore
  }

  // Check if file exists by trying to get its ID; if it fails, create it
  try {
    await nc.getFileId(filePath, ADMIN_USER);
  } catch {
    // File doesn't exist — create empty ODT stub
    const emptyOdt = await createEmptyOdt();
    await nc.upload(
      filePath,
      ADMIN_USER,
      emptyOdt,
      'application/vnd.oasis.opendocument.text'
    );
  }

  return filePath;
}

export const load: PageServerLoad = async ({ params, locals }) => {
  const session = await locals.auth();
  const user = session?.user as SessionUser | undefined;
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    throw error(403, 'Forbidden');
  }

  const id = Number(params.id);
  if (isNaN(id)) throw error(400, 'Invalid ID');

  const post = await getNewsPostById(id);
  if (!post) throw error(404, 'Not found');

  let editorUrl: string | null = null;
  let tokenTtl: number | null = null;

  try {
    const filePath = await ensureDraftFile(id);
    const nc = createNextcloudClient();
    const fileId = await nc.getFileId(filePath, ADMIN_USER);
    ({ editorUrl, tokenTtl } = await nc.getCollaboraEditorUrl(fileId, ADMIN_USER));
  } catch {
    // Nextcloud/Collabora unavailable — page renders without editor
  }

  return { post, editorUrl, tokenTtl };
};

export const actions: Actions = {
  save: async ({ params, locals }) => {
    const session = await locals.auth();
    const user = session?.user as SessionUser | undefined;
    if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
      throw error(403, 'Forbidden');
    }

    const id = Number(params.id);
    const post = await getNewsPostById(id);
    if (!post) throw error(404, 'Not found');

    // Fetch the .odt from Nextcloud and convert to HTML
    const nc = createNextcloudClient();
    const filePath = `/remote.php/dav/files/${ADMIN_USER}/news-posts/drafts/${id}.odt`;
    const response = await nc.download(filePath, ADMIN_USER);
    if (!response.ok) throw error(502, 'Could not fetch ODT from Nextcloud');

    const odtBuffer = await response.arrayBuffer();
    // G-011 analog: Collabora-converted HTML can carry inline scripts /
    // event handlers / data: URIs from the source ODT. Sanitize at the
    // trust boundary; news-db.updateNewsBodyHtml also sanitizes as a
    // second defensive layer (both passes are idempotent).
    const bodyHtml = sanitizeRichHtml(await convertOdtToHtml(odtBuffer));
    await updateNewsBodyHtml(id, bodyHtml);

    return { success: true };
  },

  publish: async ({ params, locals }) => {
    const session = await locals.auth();
    const user = session?.user as SessionUser | undefined;
    if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
      throw error(403, 'Forbidden');
    }

    const id = Number(params.id);
    const res = await internalFetch(`/api/news/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'publish' }),
    });
    if (!res.ok) throw error(502, 'Publish failed');
    return { published: true };
  },

  unpublish: async ({ params, locals }) => {
    const session = await locals.auth();
    const user = session?.user as SessionUser | undefined;
    if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
      throw error(403, 'Forbidden');
    }

    const id = Number(params.id);
    const res = await internalFetch(`/api/news/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'unpublish' }),
    });
    if (!res.ok) throw error(502, 'Unpublish failed');
    return { unpublished: true };
  },
};
