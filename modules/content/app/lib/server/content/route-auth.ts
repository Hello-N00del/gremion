// Content Engine (Pillar-1 kernel) — the per-route auth guard for the
// /api/content surface. The module-disable gate (whether the `content` module
// is enabled for THIS tenant) is enforced one layer up, in hooks.server.ts via
// moduleGateResponse(moduleRoutePrefixes) — every /api/content request already
// 403s there when the tenant has the module toggled OFF. These helpers add the
// per-request ROLE + CAPABILITY gate the route handlers apply on top:
//
//   - READ  (GET list / get / preview / carousel) → the page view gate,
//     Role.Member, matching contentManifest.pages[].minRole.
//   - WRITE  (POST / PATCH / DELETE)              → the `content.author`
//     capability, i.e. membership in any of the granting groups composed from
//     the module manifests (composeCapabilities()['content.author']).
//
// Capabilities are GROUP-keyed (see $lib/auth/capabilities.ts); we read the
// composed map directly rather than the finance-only CapabilityId enum, because
// `content.author` is contributed by the content manifest, not the finance one.

import { error } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { composeCapabilities } from '$lib/modules/registry'

/** The groups that grant a content capability (any-of), composed from the manifests. */
function contentCapabilityGroups(
  id: 'content.author' | 'content.publish' | 'content.publish.instagram',
): readonly string[] {
  return composeCapabilities()[id] ?? []
}

/**
 * Require an authenticated user who can VIEW the content authoring surface
 * (Role.Member view gate, mirroring contentManifest.pages[].minRole). Throws a
 * 401/403 error otherwise; returns the SessionUser on success.
 */
export function requireContentRead(user: SessionUser | null): SessionUser {
  if (!user) throw error(401, 'Unauthorized')
  if (!hasRole(user.roles, Role.Member)) throw error(403, 'Forbidden')
  return user
}

/**
 * Require an authenticated user who holds the `content.author` capability
 * (membership in any granting group). Throws 401/403 otherwise; returns the
 * SessionUser on success.
 */
export function requireContentAuthor(user: SessionUser | null): SessionUser {
  if (!user) throw error(401, 'Unauthorized')
  const granting = contentCapabilityGroups('content.author')
  const groups = new Set(user.groups)
  if (!granting.some((g) => groups.has(g))) throw error(403, 'Forbidden')
  return user
}

/**
 * Require an authenticated user who holds the `content.publish` capability
 * (membership in any granting group). This gates the publish/fan-out surface —
 * pushing a post out to email/portal is a heavier action than authoring it, so
 * it is a distinct capability. Throws 401/403 otherwise; returns the SessionUser
 * on success. Mirrors requireContentAuthor.
 */
export function requireContentPublish(user: SessionUser | null): SessionUser {
  if (!user) throw error(401, 'Unauthorized')
  const granting = contentCapabilityGroups('content.publish')
  const groups = new Set(user.groups)
  if (!granting.some((g) => groups.has(g))) throw error(403, 'Forbidden')
  return user
}

/**
 * Require an authenticated user who holds the `content.publish.instagram`
 * capability — the SECOND, channel-specific gate layered on top of
 * `content.publish` for the Instagram fan-out (a public-facing social post is a
 * distinct, heavier action than email/portal). The grant list ships EMPTY
 * (disabled-by-default), so this throws 403 for every user until an operator
 * grants it in a separate activation step. Throws 401/403 otherwise; returns the
 * SessionUser on success. The caller should have already passed
 * requireContentPublish.
 */
export function requireContentPublishInstagram(user: SessionUser | null): SessionUser {
  if (!user) throw error(401, 'Unauthorized')
  const granting = contentCapabilityGroups('content.publish.instagram')
  const groups = new Set(user.groups)
  if (!granting.some((g) => groups.has(g)))
    throw error(403, 'Instagram publishing is not enabled for this tenant.')
  return user
}
