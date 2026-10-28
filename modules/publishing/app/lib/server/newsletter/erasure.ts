// TRD-196 / PRD-OPS-005 — the publishing (newsletter) module's erasure hook
// (contract: @gremion/ports/erasure, registered in register.server.ts).
//
// The newsletter data lives in the newsletter leaf's own database
// (newsletter-postgres); the kernel reaches it only through the backend port
// (NEWSLETTER_BACKEND=service, the sole implementation). A subscriber is keyed by
// e-mail address, so the hook resolves the subject's address from the Keycloak
// account.
//
// Policy (retention catalogue 7.11):
//   deleted  every mailing_list_members row carrying the subject's address (the
//            subscription itself: RC-NWS-SUB address)
//   kept     (a) unsubscribes: the suppression/consent evidence (RC-NWS-SUB:
//            keyed address, audit window; and deleting it would let a later
//            re-import mail someone who opted out), (b) deliveries / send_tokens /
//            newsletter_audit: delivery evidence under the audit window (RC-NWS-ISSUE,
//            RC-MAIL-EVID), (c) newsletters.created_by of newsletters the subject
//            wrote. (a)-(c) are NOT reachable through the leaf's HTTP surface (the
//            port exposes no pseudonymise operation for them); the leaf's own
//            retention sweep ages them out. Named residual until the leaf offers an
//            erase endpoint.
//
// If the subject's Keycloak account is gone the address cannot be derived and the
// module reports `skipped` with that reason rather than guess.
import type { ErasureResidual, ModuleErasureHook } from '@gremion/ports/erasure'
import { getKeycloakAdminClientForCurrentTenant } from '$lib/server/keycloak-admin'
import { getNewsletterBackend } from './backend'
import type { NewsletterBackendPort } from './backend/port'

type ErasureBackend = Pick<NewsletterBackendPort, 'listMailingLists' | 'listMembers' | 'deleteMember'>

export interface PublishingErasureDeps {
  /** The subject's e-mail address, or null when the Keycloak account is gone. */
  resolveEmail(subjectId: string): Promise<string | null>
  backend(): ErasureBackend
}

const norm = (email: string) => email.trim().toLowerCase()

const LEAF_RECORD =
  'newsletter leaf database: not reachable through the leaf HTTP surface (no erase endpoint); aged out by the leaf retention sweep'

/** What stays in the leaf (header (a)-(c)). The kernel cannot count it, hence rows: null. Never carries the subject. */
export const PUBLISHING_RESIDUALS: readonly ErasureResidual[] = [
  { table: 'unsubscribes', column: 'email', rows: null, reason: `${LEAF_RECORD}; suppression / consent evidence (RC-NWS-SUB)` },
  { table: 'send_tokens', column: 'email', rows: null, reason: `${LEAF_RECORD}; delivery evidence (RC-MAIL-EVID)` },
  { table: 'deliveries', column: 'email', rows: null, reason: `${LEAF_RECORD}; delivery evidence (RC-NWS-ISSUE, RC-MAIL-EVID)` },
  { table: 'newsletter_audit', column: 'actor_sub', rows: null, reason: `${LEAF_RECORD}; delivery evidence (RC-MAIL-EVID)` },
  { table: 'newsletters', column: 'created_by', rows: null, reason: `${LEAF_RECORD}; authorship of newsletters the subject wrote` },
]

export function createPublishingErasureHook(deps: PublishingErasureDeps): ModuleErasureHook {
  return {
    moduleId: 'publishing',
    requiresConnection: false,
    async erase({ subjectId }) {
      const email = await deps.resolveEmail(subjectId)
      if (email === null) {
        return {
          status: 'skipped',
          reason: "the subject's Keycloak account no longer exists, so the newsletter subscription (keyed by e-mail address) cannot be located",
        }
      }
      const wanted = norm(email)
      if (wanted === '') return { status: 'erased', counts: { mailing_list_members: 0 }, residuals: PUBLISHING_RESIDUALS }

      const backend = deps.backend()
      let removed = 0
      for (const list of await backend.listMailingLists()) {
        for (const m of await backend.listMembers(list.id)) {
          if (norm(m.email) !== wanted) continue
          await backend.deleteMember(list.id, m.id)
          removed++
        }
      }
      return { status: 'erased', counts: { mailing_list_members: removed }, residuals: PUBLISHING_RESIDUALS }
    },
  }
}

export const publishingErasureHook = createPublishingErasureHook({
  async resolveEmail(subjectId) {
    try {
      return (await getKeycloakAdminClientForCurrentTenant().getUser(subjectId)).email ?? ''
    } catch (err) {
      // KeycloakAdminClient.getUser maps a 404 to exactly this message.
      if (err instanceof Error && err.message === 'User not found') return null
      throw err
    }
  },
  backend: () => getNewsletterBackend(),
})
