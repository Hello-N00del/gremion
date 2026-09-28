// @vitest-environment node
// Unit tests for resolvePostRecipients — content mailing lists + KC groups,
// deduped by lowercased email, minus unsubscribes. content-db + the KC client
// are mocked, so this is a pure-logic unit test (no Postgres / no Keycloak).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getPostRecipients = vi.fn()
const listMembers = vi.fn()
const filterUnsubscribed = vi.fn<(emails: string[]) => Promise<Set<string>>>()
const getGroupMembers = vi.fn()

vi.mock('./content-db', () => ({
	getPostRecipients: (...a: unknown[]) => getPostRecipients(...a),
	listMembers: (...a: unknown[]) => listMembers(...a),
	filterUnsubscribed: (...a: [string[]]) => filterUnsubscribed(...a),
}))

vi.mock('$lib/server/keycloak-admin', () => ({
	getKeycloakAdminClientForCurrentTenant: () => ({ getGroupMembers }),
}))

import { resolvePostRecipients } from './recipients'

beforeEach(() => {
	vi.clearAllMocks()
	filterUnsubscribed.mockResolvedValue(new Set())
})

describe('resolvePostRecipients', () => {
	it('unions a mailing list and a KC group', async () => {
		getPostRecipients.mockResolvedValue([
			{ id: 'r1', post_id: 'p1', mailing_list_id: 'l1', keycloak_group_id: null },
			{ id: 'r2', post_id: 'p1', mailing_list_id: null, keycloak_group_id: 'g1' },
		])
		listMembers.mockResolvedValue([
			{ email: 'alice@example.org', name: 'Alice' },
		])
		getGroupMembers.mockResolvedValue([
			{ email: 'bob@example.org', firstName: 'Bob', lastName: 'Builder' },
		])

		const out = await resolvePostRecipients('p1')
		expect(out).toEqual([
			{ email: 'alice@example.org', name: 'Alice' },
			{ email: 'bob@example.org', name: 'Bob Builder' },
		])
		expect(listMembers).toHaveBeenCalledWith('l1')
		expect(getGroupMembers).toHaveBeenCalledWith('g1')
		// suppression is a SINGLE batched lookup, not one-per-recipient (no N+1)
		expect(filterUnsubscribed).toHaveBeenCalledTimes(1)
		expect(filterUnsubscribed).toHaveBeenCalledWith(['alice@example.org', 'bob@example.org'])
	})

	it('returns the lowercased email even when the source casing is mixed', async () => {
		getPostRecipients.mockResolvedValue([
			{ id: 'r1', post_id: 'p1', mailing_list_id: 'l1', keycloak_group_id: null },
		])
		listMembers.mockResolvedValue([{ email: 'Alice@Example.ORG', name: 'Alice' }])

		const out = await resolvePostRecipients('p1')
		// the RETURNED email is lowercased so downstream lookups cannot be
		// bypassed by case; the display name is preserved
		expect(out).toEqual([{ email: 'alice@example.org', name: 'Alice' }])
	})

	it('dedupes across a list and a group by lowercased email (first name wins, lowercased email returned)', async () => {
		getPostRecipients.mockResolvedValue([
			{ id: 'r1', post_id: 'p1', mailing_list_id: 'l1', keycloak_group_id: null },
			{ id: 'r2', post_id: 'p1', mailing_list_id: null, keycloak_group_id: 'g1' },
		])
		listMembers.mockResolvedValue([{ email: 'Carol@Example.org', name: 'Carol (list)' }])
		getGroupMembers.mockResolvedValue([
			{ email: 'carol@example.org', firstName: 'Carol', lastName: 'Group' },
		])

		const out = await resolvePostRecipients('p1')
		// first occurrence wins for the name; email is the lowercased dedupe key
		expect(out).toEqual([{ email: 'carol@example.org', name: 'Carol (list)' }])
	})

	it('filters unsubscribed recipients via the batched lookup', async () => {
		getPostRecipients.mockResolvedValue([
			{ id: 'r1', post_id: 'p1', mailing_list_id: 'l1', keycloak_group_id: null },
		])
		listMembers.mockResolvedValue([
			{ email: 'keep@example.org', name: 'Keep' },
			{ email: 'Gone@Example.org', name: 'Gone' },
		])
		// the batch is called with lowercased keys; suppression is matched lowercased
		filterUnsubscribed.mockResolvedValue(new Set(['gone@example.org']))

		const out = await resolvePostRecipients('p1')
		expect(out).toEqual([{ email: 'keep@example.org', name: 'Keep' }])
		expect(filterUnsubscribed).toHaveBeenCalledWith(['keep@example.org', 'gone@example.org'])
	})

	it('skips emailless KC members', async () => {
		getPostRecipients.mockResolvedValue([
			{ id: 'r2', post_id: 'p1', mailing_list_id: null, keycloak_group_id: 'g1' },
		])
		getGroupMembers.mockResolvedValue([
			{ email: '', firstName: 'No', lastName: 'Email' },
			{ email: undefined, firstName: 'Also', lastName: 'None' },
			{ email: 'real@example.org', firstName: 'Real', lastName: 'Person' },
		])

		const out = await resolvePostRecipients('p1')
		expect(out).toEqual([{ email: 'real@example.org', name: 'Real Person' }])
	})

	it('builds the KC name as firstName+lastName, or null when both blank', async () => {
		getPostRecipients.mockResolvedValue([
			{ id: 'r2', post_id: 'p1', mailing_list_id: null, keycloak_group_id: 'g1' },
		])
		getGroupMembers.mockResolvedValue([
			{ email: 'noname@example.org', firstName: '', lastName: '' },
		])

		const out = await resolvePostRecipients('p1')
		expect(out).toEqual([{ email: 'noname@example.org', name: null }])
	})
})
