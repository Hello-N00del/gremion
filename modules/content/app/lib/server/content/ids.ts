// F1-FIX-07 H08 (K5#27): content ids are UUIDs (content.posts, mailing_lists and
// mailing_list_members all key on gen_random_uuid()). A route answers 404 for
// anything else BEFORE a backend call, so a decoded route param such as
// `x/../../lists` never reaches the leaf client. The client's seg() encoding is
// the second layer; this is the first.
import { error } from '@sveltejs/kit'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True iff `value` is a canonical 8-4-4-4-12 hex UUID. */
export function isContentId(value: unknown): value is string {
	return typeof value === 'string' && UUID_RE.test(value)
}

/** The route param as a content id, or a 404 (never a backend call). */
export function requireContentId(value: string | undefined): string {
	if (!isContentId(value)) throw error(404, 'Not found')
	return value
}
