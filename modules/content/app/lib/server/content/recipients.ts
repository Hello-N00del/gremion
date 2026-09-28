// Content Engine (L2) — recipient resolution for the self-contained email channel.
//
// A post's email channel sends to a set of `content.post_recipients`, each of
// which targets EXACTLY one of (XOR enforced by the DB CHECK):
//   - a content mailing list  → every `content.mailing_list_members` row, or
//   - a Keycloak group        → every email-bearing member of that group
//     (via getKeycloakAdminClientForCurrentTenant().getGroupMembers).
//
// `resolvePostRecipients` unions those, dedupes by *lowercased* email (first
// occurrence wins for the display name), then drops anyone on the tenant's
// `content.unsubscribes` list. The RETURNED email is always the *lowercased*
// form (the dedupe key) so suppression / token / delivery-ledger lookups
// downstream cannot be bypassed by mixed-case input. Self-contained: the mailing
// lists / members / unsubscribes all live in the content schema; only the
// KC-group lookup is borrowed from the kernel.
//
// KC filter/format mirrors the newsletter resolve-group seam EXACTLY:
//   - drop members without an email address
//   - name = [firstName, lastName].filter(Boolean).join(' ') || null

import { getKeycloakAdminClientForCurrentTenant } from '$lib/server/keycloak-admin'
import { filterUnsubscribed, getPostRecipients, listMembers } from './content-db'

/** A resolved email recipient. */
export interface Recipient {
	email: string
	name: string | null
}

/**
 * Resolve the deduplicated, unsubscribe-filtered recipient set for a post's
 * email channel. Tenant-scoped via the current-tenant DB pool + KC client.
 */
export async function resolvePostRecipients(postId: string): Promise<Recipient[]> {
	const targets = await getPostRecipients(postId)

	// Dedupe by lowercased email; first occurrence wins for the display name. The
	// stored email IS the lowercased key, so every downstream lookup agrees on case.
	const byEmail = new Map<string, Recipient>()
	const add = (email: string | null | undefined, name: string | null): void => {
		if (!email) return
		const key = email.toLowerCase()
		if (!byEmail.has(key)) byEmail.set(key, { email: key, name })
	}

	for (const target of targets) {
		if (target.mailing_list_id) {
			const members = await listMembers(target.mailing_list_id)
			for (const m of members) add(m.email, m.name)
		} else if (target.keycloak_group_id) {
			const kc = getKeycloakAdminClientForCurrentTenant()
			const raw = await kc.getGroupMembers(target.keycloak_group_id)
			for (const m of raw) {
				if (!m.email) continue // skip emailless KC members
				const name = [m.firstName, m.lastName].filter(Boolean).join(' ') || null
				add(m.email, name)
			}
		}
	}

	// Drop unsubscribed emails in ONE batched lookup (no N+1). Keys are already
	// lowercased and storage is lowercased, so the comparison agrees on case.
	const unsubscribed = await filterUnsubscribed([...byEmail.keys()])
	const out: Recipient[] = []
	for (const recipient of byEmail.values()) {
		if (unsubscribed.has(recipient.email)) continue
		out.push(recipient)
	}
	return out
}
