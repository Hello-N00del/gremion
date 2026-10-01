// News draft ODT on the shared Nextcloud (F1-FIX-07 H09 K5#28, S3#9).
//
// H09: news_posts.id is a per-tenant SERIAL, so `news-posts/drafts/<id>.odt` on
// the ONE shared Nextcloud admin account made tenant B's post 7 open tenant A's
// post 7 read-write. The draft path now carries the tenant id:
//   /remote.php/dav/files/<admin>/news-posts/<tenantId>/drafts/<postId>.odt
// Drafts written under the old tenant-less path are NOT moved: the editor opens a
// fresh stub at the new path (operator runbook note, no silent migration).
//
// S3#9: the stub is created ONLY when the draft is really absent (a 404 from the
// lookup). Any other lookup error (Nextcloud down, 401, 5xx, parse error) is
// rethrown — it used to be read as "missing" and an empty ODT was uploaded OVER
// the existing draft.

/** The Nextcloud account the news drafts live under (unchanged from the page). */
export const NEWS_DRAFT_USER = 'admin'

/** The subset of the Nextcloud client the draft helpers need (injected). */
export interface DraftNextcloud {
	mkcol(path: string, userId: string): Promise<unknown>
	getFileId(path: string, userId: string): Promise<number>
	upload(path: string, userId: string, body: BodyInit, contentType: string): Promise<unknown>
}

const TENANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function tenantSegment(tenantId: string): string {
	// Tenant ids are UUIDs (UUIDv7). Refuse anything else rather than build a
	// path from it: a malformed id must never collapse two tenants' folders.
	if (!TENANT_ID_RE.test(tenantId)) throw new Error('news draft: tenant id is not a UUID')
	return tenantId.toLowerCase()
}

function postSegment(postId: number): string {
	if (!Number.isSafeInteger(postId) || postId <= 0) throw new Error('news draft: invalid post id')
	return String(postId)
}

/** The tenant's drafts folder. */
export function newsDraftFolder(tenantId: string): string {
	return `/remote.php/dav/files/${NEWS_DRAFT_USER}/news-posts/${tenantSegment(tenantId)}/drafts`
}

/** The draft ODT path for one tenant's news post. */
export function newsDraftPath(tenantId: string, postId: number): string {
	return `${newsDraftFolder(tenantId)}/${postSegment(postId)}.odt`
}

/** True iff `err` is an upstream "not found" (NextcloudResponseError shape). */
function isNotFound(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 404
}

/** MKCOL that tolerates "already exists" (405) and nothing else. */
async function mkcolIfMissing(nc: DraftNextcloud, path: string): Promise<void> {
	try {
		await nc.mkcol(path, NEWS_DRAFT_USER)
	} catch (err) {
		const status = (err as { status?: unknown } | null)?.status
		if (status === 405) return // the collection already exists
		throw err
	}
}

/**
 * Make sure the tenant's draft ODT exists and return its path. Creates the
 * folder chain, then uploads an empty ODT ONLY when the lookup says 404.
 */
export async function ensureNewsDraft(
	nc: DraftNextcloud,
	tenantId: string,
	postId: number,
	createEmptyOdt: () => Promise<BodyInit>,
): Promise<string> {
	const folder = newsDraftFolder(tenantId)
	const filePath = newsDraftPath(tenantId, postId)
	const tenantFolder = folder.slice(0, folder.lastIndexOf('/'))
	const root = tenantFolder.slice(0, tenantFolder.lastIndexOf('/'))

	await mkcolIfMissing(nc, root)
	await mkcolIfMissing(nc, tenantFolder)
	await mkcolIfMissing(nc, folder)

	try {
		await nc.getFileId(filePath, NEWS_DRAFT_USER)
		return filePath // exists: never overwrite
	} catch (err) {
		if (!isNotFound(err)) throw err
	}

	await nc.upload(
		filePath,
		NEWS_DRAFT_USER,
		await createEmptyOdt(),
		'application/vnd.oasis.opendocument.text',
	)
	return filePath
}
