// TRD-196 / PRD-OPS-005 — the content module's erasure hook (contract:
// @gremion/ports/erasure, registered in register.server.ts). The module is off by
// default (modules/disabled.json) but can be enabled; when it is, an erasure must
// reach it or it can never report `complete`.
//
// With the in-process backend the `content` schema (and news_posts) live in the
// tenant database. Personal data and policy (retention catalogue 7.9 / 7.11):
//   pseudonymised  content.posts.created_by and news_posts.author_id -> 'erased'
//                  (authorship of a published post; the post is a publication
//                  record and stays); content.deliveries.email -> 'erased:<random>'
//                  (delivery evidence stays, the recipient does not: RC-MAIL-EVID
//                  "on granted erasure the recipient is pseudonymised"; the random
//                  suffix keeps (post_id, email) unique and is not reversible)
//   deleted        content.mailing_list_members and content.send_tokens carrying
//                  the subject's address (the subscription and its replayable links)
//   kept           content.unsubscribes: the suppression / consent evidence
//                  (RC-NWS-SUB, audit window); deleting it would let a later
//                  import mail someone who opted out. Posts, media, publications.
//
// The subscription is keyed by e-mail address, so the address is resolved from the
// subject's Keycloak account BEFORE anything is changed; if the account is gone the
// module reports `skipped` and touches nothing. CONTENT_BACKEND=service: the
// content leaf owns its database and the kernel holds no connection -> `skipped`.
import type { Sql } from '@gremion/db'
import type { ModuleErasureHook } from '@gremion/ports/erasure'
import { getKeycloakAdminClientForCurrentTenant } from '$lib/server/keycloak-admin'

export const CONTENT_ERASED_MARKER = 'erased'

export interface ContentErasureDeps {
  /** The subject's e-mail address ('' if the account has none), or null when the Keycloak account is gone. */
  resolveEmail(subjectId: string): Promise<string | null>
}

export function createContentErasureHook(deps: ContentErasureDeps): ModuleErasureHook<Sql> {
  return {
    moduleId: 'content',
    async erase({ db, subjectId }) {
      if ((process.env.CONTENT_BACKEND ?? 'inprocess') === 'service') {
        return {
          status: 'skipped',
          reason: 'content data lives in the content service database; the kernel holds no connection to it',
        }
      }
      if (db === null) return { status: 'skipped', reason: 'no database connection' }
      const email = await deps.resolveEmail(subjectId)
      if (email === null) {
        return {
          status: 'skipped',
          reason: "the subject's Keycloak account no longer exists, so the e-mail address that keys list membership and delivery evidence cannot be derived",
        }
      }
      const addr = email.trim().toLowerCase()
      const counts = await db.begin(async (tx) => {
        const c: Record<string, number> = {}
        c.posts = (await tx`UPDATE content.posts SET created_by = ${CONTENT_ERASED_MARKER} WHERE created_by = ${subjectId}`).count
        c.news_posts = (await tx`UPDATE news_posts SET author_id = ${CONTENT_ERASED_MARKER} WHERE author_id = ${subjectId}`).count
        if (addr === '') {
          c.mailing_list_members = 0
          c.send_tokens = 0
          c.deliveries = 0
          return c
        }
        c.mailing_list_members = (await tx`DELETE FROM content.mailing_list_members WHERE lower(btrim(email)) = ${addr}`).count
        c.send_tokens = (await tx`DELETE FROM content.send_tokens WHERE lower(btrim(email)) = ${addr}`).count
        c.deliveries = (
          await tx`UPDATE content.deliveries SET email = 'erased:' || gen_random_uuid() WHERE lower(btrim(email)) = ${addr}`
        ).count
        return c
      })
      return { status: 'erased', counts }
    },
  }
}

export const contentErasureHook = createContentErasureHook({
  async resolveEmail(subjectId) {
    try {
      return (await getKeycloakAdminClientForCurrentTenant().getUser(subjectId)).email ?? ''
    } catch (err) {
      // KeycloakAdminClient.getUser maps a 404 to exactly this message.
      if (err instanceof Error && err.message === 'User not found') return null
      throw err
    }
  },
})
