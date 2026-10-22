import { error, json } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'
import {
  getProtocol, setProtocolStatus, updateProtocol,
  listResolutions, assignGlobalNrs, recordResolutionAdoptions,
} from '$lib/server/protocols/protocol-db'
import { requireUuidParams } from '$lib/server/protocols/route-ids'
import { convertOdtToHtml, convertOdtToPdf } from '$lib/server/documents/collabora-convert'
import { getProtocolDocumentPort } from '$lib/server/modules/runtime-registry'
import { getDb } from '$lib/server/db'
import { getQuorumContext } from '$lib/server/governance/quorum'
import { sanitizeRichHtml } from '$lib/server/security/html-sanitize'

// G-011: Collabora-converted HTML is stored in body_html and rendered via
// {@html} in the protocol detail page. The sanitizer + allowlist now lives
// in `$lib/server/security/html-sanitize` so news (G-011 analog) reuses the
// same tested implementation. See that module for the tag/attr allowlist
// and the data:/javascript:/vbscript: URI-attribute hook.

function requireAuth(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  return user
}

export async function POST(event: RequestEvent) {
  const user = requireAuth(event)
  if (!hasRole(user.roles, Role.CouncilAdmin)) throw error(403, 'Nur Admins können veröffentlichen')
  requireUuidParams(event, 'id')

  const protocol = await getProtocol(event.params.id!)
  if (!protocol) throw error(404, 'Protokoll nicht gefunden')
  if (protocol.status !== 'submitted') throw error(400, 'Nur eingereichte Protokolle können veröffentlicht werden')

  // Governance Core INV-5 — quorum gates ADOPTION (publish), not draft
  // data-entry. Checked BEFORE any Nextcloud side-effects so a non-quorate
  // protocol fails fast without moving files. A protocol carrying any binding
  // (non-withdrawn) resolution may only be published if the meeting was
  // beschlussfähig; a withdrawn resolution is not a vote and needs no quorum.
  const resolutions = await listResolutions(protocol.id)
  if (resolutions.some((r) => r.result !== 'withdrawn')) {
    const quorum = await getQuorumContext(protocol.id)
    if (!quorum.quorate) {
      throw error(
        422,
        `Nicht beschlussfähig: ${quorum.presentVotingCount}/${quorum.eligibleVotingCount} stimmberechtigte Mitglieder anwesend — ein Protokoll mit bindenden Beschlüssen kann nicht veröffentlicht werden.`,
      )
    }
  }

  // F1 (operator ruling Q1, 2026-10-21) + R33b: the protocol body lives IN-APP
  // (protocols.body_html) and publish never needs Nextcloud when there is no
  // ODT. When an ODT exists (files module on, draft path set) it IS the reviewed
  // artefact: publish must use it, and any failure propagates (no silent
  // fallback to a different text). The body_html fallback applies only when
  // there is no ODT to read (files off, or never uploaded).
  const docs = getProtocolDocumentPort()
  let bodyHtml = ''
  let publishedDir: string | undefined
  let pdfNextcloudPath: string | undefined
  const draftPath = protocol.nextcloud_draft_path
  // Undo the ODT move when publish fails after it, so a failed publish never
  // orphans the reviewed ODT in the published dir (best effort, logged).
  const restoreOdt = async () => {
    if (!docs || !draftPath || !publishedDir) return
    try {
      await docs.restoreDraftFile?.(draftPath, publishedDir)
    } catch (e) {
      console.error('[api/protocols/publish] could not move the ODT back to the drafts:', e)
    }
  }
  if (docs && draftPath) {
    // #235 (defect 1): use the genuine NextcloudClient surface via the port.
    const odtBuffer = await docs.downloadDraft(draftPath)
    const [rawBodyHtml, pdfBuffer] = await Promise.all([
      convertOdtToHtml(odtBuffer),
      convertOdtToPdf(odtBuffer),
    ])
    // G-011: sanitize before any storage, downstream calls, or rendering.
    bodyHtml = sanitizeRichHtml(rawBodyHtml)
    // Side-effecting Nextcloud moves/uploads happen BEFORE the DB transaction
    // so the tx window stays short; if either fails we abort before mutating.
    publishedDir = await docs.publishFile(protocol.id, draftPath)
    try {
      // #235 (defect 4): persist the PDF's NC-relative path (public PDF proxies).
      pdfNextcloudPath = await docs.uploadPublishedPdf(publishedDir, pdfBuffer)
    } catch (e) {
      await restoreOdt()
      throw e
    }
  } else {
    if (!protocol.body_html) throw error(400, 'Kein Protokolltext vorhanden')
    bodyHtml = sanitizeRichHtml(protocol.body_html)
  }

  const year = new Date(protocol.meeting_date).getFullYear()

  // #235 (defect 3): persist body_html / paths, assign resolution numbers, and
  // flip the status to 'published' inside ONE transaction. updateProtocol runs
  // FIRST (with allowPublished so its own status!='published' guard is bypassed)
  // — running setProtocolStatus first would make updateProtocol's guard match
  // zero rows and throw, leaving a half-published row. Wrapping the trio in a
  // single sql.begin makes any failure roll the whole unit back.
  // #235 (defect 2): assignGlobalNrs numbers resolutions SEQUENTIALLY on the tx
  // (was Promise.all over a check-then-act COUNT, handing every resolution the
  // same B-number).
  let updated
  // Set once every statement ran: a throw after that is from COMMIT, whose
  // outcome is unknown, so the ODT must stay where it is.
  let stmtsDone = false
  try {
    updated = await getDb().begin(async (tx) => {
      await updateProtocol(
        protocol.id,
        { bodyHtml, nextcloudPublishedPath: publishedDir, pdfNextcloudPath },
        { tx, allowPublished: true },
      )
      await assignGlobalNrs(protocol.committee_id, year, resolutions.map((r) => r.id), tx)
      // INV-5 + INV-1 (#320, ported gremion#22 G2): publish IS adoption. Stamp
      // decided_at on each binding resolution and append a tamper-evident
      // audit_log decision record — on THIS tx, so they commit or roll back
      // atomically with the status→'published' flip. Withdrawn resolutions are
      // skipped inside the helper (not a vote → no decision).
      await recordResolutionAdoptions(user.id, resolutions, tx)
      // Returned last so `updated` reflects the final published row.
      const published = await setProtocolStatus(protocol.id, 'published', { tx })
      stmtsDone = true
      return published
    })
  } catch (e) {
    if (!stmtsDone) await restoreOdt()
    throw e
  }

  // (open-core carve) The calendar module's G-075 minutes-automation extractor was
  // triggered here via internalFetch('/api/calendar/automations/minutes'). The
  // calendar module is not part of the governance kernel; when re-added it
  // registers a protocol-published hook instead of being called by name here.

  return json({ protocol: updated })
}
