// Newsletter draft ODTs on the shared Nextcloud admin space.
//
// Every customer's drafts live under the ONE Nextcloud admin account, so a draft
// path must say whose it is. New drafts are written to
//   /remote.php/dav/files/<admin>/_newsletters/<tenantId>/<uuid>.odt
// Drafts written before that (flat folder, `<slug>-<ms>.odt`) keep their stored
// path and stay readable; nothing is moved.
//
// `isRenderableNewsletterPath` is an ALLOW-list: it names the two places the
// render callback may read, and refuses everything else, instead of listing what
// to keep out.

const TENANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A file name inside a draft folder: letters, digits, `_`, `-` and the `.odt` suffix, nothing else. */
const DRAFT_FILE_RE = /^[A-Za-z0-9_-]+\.odt$/

/** Tenant ids are UUIDs. Anything else is refused rather than turned into a folder name. */
export function newsletterTenantSegment(tenantId: string): string {
  if (!TENANT_ID_RE.test(tenantId)) throw new Error('newsletter draft: tenant id is not a UUID')
  return tenantId.toLowerCase()
}

/** The folder shared by all customers (holds the per-customer folders and the legacy flat drafts). */
export function newsletterDraftRoot(adminUser: string): string {
  return `/remote.php/dav/files/${adminUser}/_newsletters`
}

/** One customer's draft folder. Throws for a tenant id that is not a UUID. */
export function newsletterTenantFolder(adminUser: string, tenantId: string): string {
  return `${newsletterDraftRoot(adminUser)}/${newsletterTenantSegment(tenantId)}`
}

/**
 * True iff `odtPath` is a place the render callback may read for this customer:
 * the customer's own folder, or the legacy flat folder (no subdirectory). The
 * path is compared as given, never decoded, so an encoded separator or dot is
 * simply not a permitted character.
 */
export function isRenderableNewsletterPath(odtPath: string, adminUser: string, tenantId: string): boolean {
  const root = `${newsletterDraftRoot(adminUser)}/`
  if (!odtPath.startsWith(root)) return false
  const rest = odtPath.slice(root.length)
  if (DRAFT_FILE_RE.test(rest)) return true // legacy flat draft
  if (!TENANT_ID_RE.test(tenantId)) return false
  const ownFolder = `${tenantId.toLowerCase()}/`
  return rest.startsWith(ownFolder) && DRAFT_FILE_RE.test(rest.slice(ownFolder.length))
}

/** MKCOL that tolerates "the collection already exists" (405) and nothing else. */
export async function mkcolIfMissing(
  nc: { mkcol(path: string, userId: string): Promise<unknown> },
  path: string,
  userId: string,
): Promise<void> {
  try {
    await nc.mkcol(path, userId)
  } catch (err) {
    const status = (err as { status?: unknown } | null)?.status
    if (status === 405) return
    throw err
  }
}
