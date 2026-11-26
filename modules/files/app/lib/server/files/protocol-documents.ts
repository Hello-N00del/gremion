// src/lib/server/files/protocol-documents.ts
// Civitas A3a-2: the Nextcloud document operations the protocol routes drive,
// re-homed into the FILES module (they legitimately hold the Nextcloud client +
// the WebDAV-path helpers — exactly the imports the protocol routes must NOT
// carry). Exposed as ONE ProtocolDocumentPort the files module self-registers
// into runtime-registry (files/register.server.ts); the protocol routes resolve
// it via getProtocolDocumentPort() and never import $lib/server/files.
//
// Bodies are moved verbatim from the old protocols/protocol-wopi.ts (same DAV
// paths, same #235 upload contract, same #241 path validation). The Collabora
// conversion helpers were split off into documents/collabora-convert.ts.
import { serviceEnv } from '$lib/server/env/service-env'
import { getTenant } from '$lib/server/tenant/context'
import type { ProtocolDocumentPort } from '$lib/server/modules/runtime-registry'
import { createNextcloudClient } from './nextcloud-client'
import { validatePublishedPdfPath } from './webdav-path'

const PROTOCOLS_ROOT = '/protocols'
const PUBLISHED_BASE = '/protocols/published'

function sysUser(): string {
  return serviceEnv('NEXTCLOUD_ADMIN_USER') ?? 'admin'
}

function davPath(ncRelPath: string): string {
  return `/remote.php/dav/files/${sysUser()}${ncRelPath}`
}

const TENANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The customer's segment in the shared drafts space. A tenant id that is not a UUID is refused, never turned into a folder name. */
function tenantSegment(): string {
  const id = getTenant().id
  if (!TENANT_ID_RE.test(id)) throw new Error('protocol draft: tenant id is not a UUID')
  return id.toLowerCase()
}

/** MKCOL that tolerates "the collection already exists" (405) and nothing else: a folder that cannot be made is an error. */
async function mkcolIfMissing(nc: ReturnType<typeof createNextcloudClient>, ncRelPath: string, user: string): Promise<void> {
  try {
    await nc.mkcol(davPath(ncRelPath), user)
  } catch (err) {
    if ((err as { status?: unknown } | null)?.status === 405) return
    throw err
  }
}

// Every customer's minutes drafts live under the ONE Nextcloud admin account, so the draft path carries the
// customer: /protocols/<tenant uuid>/drafts/<id>.odt. WebDAV creates one level per MKCOL, so the chain is
// made parent first; a draft stored under the older flat path keeps that stored path and stays readable.
async function createDraftFile(protocolId: string): Promise<string> {
  const nc = createNextcloudClient()
  const user = sysUser()
  const tenantRoot = `${PROTOCOLS_ROOT}/${tenantSegment()}`
  const draftsDir = `${tenantRoot}/drafts`
  const ncPath = `${draftsDir}/${protocolId}.odt`
  await mkcolIfMissing(nc, PROTOCOLS_ROOT, user)
  await mkcolIfMissing(nc, tenantRoot, user)
  await mkcolIfMissing(nc, draftsDir, user)
  await nc.upload(davPath(ncPath), user, Buffer.alloc(0), 'application/vnd.oasis.opendocument.text')
  return ncPath
}

async function getDraftWopiToken(
  draftPath: string,
  opts: { publicOrigin?: string } = {}
): Promise<{ editorUrl: string; tokenTtl: number }> {
  const nc = createNextcloudClient()
  const user = sysUser()
  const fileId = await nc.getFileId(davPath(draftPath), user)
  // The browser origin goes along so the editor posts its messages to the customer host.
  return nc.getCollaboraEditorUrl(fileId, user, opts)
}

async function downloadDraft(draftPath: string): Promise<Buffer> {
  const nc = createNextcloudClient()
  const user = sysUser()
  const res = await nc.download(davPath(draftPath), user)
  if (!res.ok) throw new Error(`Nextcloud download failed: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function publishFile(protocolId: string, draftPath: string): Promise<string> {
  const nc = createNextcloudClient()
  const user = sysUser()
  const publishedDir = `${PUBLISHED_BASE}/${protocolId}`
  const publishedOdt = `${publishedDir}/protocol.odt`
  try { await nc.mkcol(davPath(PROTOCOLS_ROOT), user) } catch (_e: unknown) { /* may already exist */ }
  try { await nc.mkcol(davPath(PUBLISHED_BASE), user) } catch (_e: unknown) { /* may already exist */ }
  try { await nc.mkcol(davPath(publishedDir), user) } catch (_e: unknown) { /* may already exist */ }
  await nc.move(davPath(draftPath), davPath(publishedOdt), user)
  return publishedDir
}

/** R33b: undo publishFile (move the ODT back to its draft path) when publish fails after the move. */
async function restoreDraftFile(draftPath: string, publishedDir: string): Promise<void> {
  const nc = createNextcloudClient()
  const user = sysUser()
  await nc.move(davPath(`${publishedDir.replace(/\/$/, '')}/protocol.odt`), davPath(draftPath), user)
}

/**
 * #235 (defects 1 & 4): upload the rendered protocol PDF into the published
 * directory and return its Nextcloud-relative path (the value the publish flow
 * stores in `protocols.pdf_nextcloud_path`, which both public PDF proxies read).
 *
 * Uses the genuine `nc.upload` surface (the old publish handler called a
 * non-existent `nc.putFile` through an `as unknown as` cast, dying at runtime).
 * `publishedDir` is the NC-relative dir returned by `publishFile`
 * (e.g. `/protocols/published/<id>`); the returned path is `<dir>/protocol.pdf`.
 */
async function uploadPublishedPdf(publishedDir: string, pdfBuffer: Buffer): Promise<string> {
  const nc = createNextcloudClient()
  const user = sysUser()
  const ncPdfPath = `${publishedDir.replace(/\/$/, '')}/protocol.pdf`
  // new Uint8Array(...) so the body is a BodyInit-compatible Uint8Array<ArrayBuffer>
  // (a bare Buffer<ArrayBufferLike> is too wide for fetch's BodyInit) — same
  // normalisation the Collabora converters use when feeding buffers to fetch.
  await nc.upload(davPath(ncPdfPath), user, new Uint8Array(pdfBuffer), 'application/pdf')
  return ncPdfPath
}

/**
 * #241: download a PUBLISHED protocol PDF from Nextcloud for the public PDF
 * route. The main app (gremion-ui) legitimately holds the Nextcloud credentials,
 * so the anonymous public portal (gremion-public) now redirects the browser here
 * instead of carrying NC admin creds itself. `pdfNcPath` is the stored
 * `pdf_nextcloud_path`; it is validated (published-prefix allowlist, no `..`/`%`)
 * before being used to build the admin-credentialed WebDAV URL.
 */
async function downloadPublishedPdf(pdfNcPath: string): Promise<Response> {
  const validated = validatePublishedPdfPath(pdfNcPath)
  const nc = createNextcloudClient()
  return nc.download(davPath(validated), sysUser())
}

async function deleteDraftFile(draftPath: string): Promise<void> {
  try {
    const nc = createNextcloudClient()
    await nc.delete(davPath(draftPath), sysUser())
  } catch (_e: unknown) { /* already gone — no-op */ }
}

/** The single Nextcloud-backed implementation of the protocol document port. */
export const protocolDocumentPort: ProtocolDocumentPort = {
  createDraftFile,
  getDraftWopiToken,
  downloadDraft,
  publishFile,
  restoreDraftFile,
  uploadPublishedPdf,
  downloadPublishedPdf,
  deleteDraftFile,
}
