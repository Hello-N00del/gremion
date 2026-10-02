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
import { defaultTenantEnv } from '$lib/server/tenant/default-env'
import type { ProtocolDocumentPort } from '$lib/server/modules/runtime-registry'
import { createNextcloudClient } from './nextcloud-client'
import { validatePublishedPdfPath } from './webdav-path'

const DRAFTS_BASE = '/protocols/drafts'
const PUBLISHED_BASE = '/protocols/published'

function sysUser(): string {
  return defaultTenantEnv('NEXTCLOUD_ADMIN_USER') ?? 'admin'
}

function davPath(ncRelPath: string): string {
  return `/remote.php/dav/files/${sysUser()}${ncRelPath}`
}

async function createDraftFile(protocolId: string): Promise<string> {
  const nc = createNextcloudClient()
  const user = sysUser()
  const ncPath = `${DRAFTS_BASE}/${protocolId}.odt`
  try { await nc.mkcol(davPath(DRAFTS_BASE), user) } catch (_e: unknown) { /* may already exist */ }
  await nc.upload(davPath(ncPath), user, Buffer.alloc(0), 'application/vnd.oasis.opendocument.text')
  return ncPath
}

async function getDraftWopiToken(
  draftPath: string
): Promise<{ editorUrl: string; tokenTtl: number }> {
  const nc = createNextcloudClient()
  const user = sysUser()
  const fileId = await nc.getFileId(davPath(draftPath), user)
  return nc.getCollaboraEditorUrl(fileId, user)
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
  try { await nc.mkcol(davPath(PUBLISHED_BASE), user) } catch (_e: unknown) { /* may already exist */ }
  try { await nc.mkcol(davPath(publishedDir), user) } catch (_e: unknown) { /* may already exist */ }
  await nc.move(davPath(draftPath), davPath(publishedOdt), user)
  return publishedDir
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
  uploadPublishedPdf,
  downloadPublishedPdf,
  deleteDraftFile,
}
