import type { PageServerLoad } from './$types'
import { error } from '@sveltejs/kit'
import { Role, hasRole } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { resolveBoardOrgUnitScope } from '$lib/server/board/scope'
import { resolveBoardBackendForPage } from '$lib/server/board/backend/resolve'
import { listOrgUnits, listOrgUnitMembers } from '$lib/server/governance/org-units-db'
import { getDisplayNameResolver } from '$lib/server/identity/display-names'
import type { CardView, StackView, BoardView, MemberOption } from '$lib/components/board/types'

// A card's raw assignee column is NEVER emitted; it is resolved to a display name on the
// server (consistent with WI-4B). The card editor's picker is the one exception it needs: the
// members of the selected board's own committee as {id, name}, and `assignee_id` on a card
// only while its assignee is one of them. CardView lives in a client-safe module so components
// can type against it.
// The in-process backend reads the DATE column through the kernel pool, whose driver parses it
// to a JS Date (UTC midnight); the service backend sends an ISO string. String(Date) would give
// "Tue Dec 15 ..." and break the date input and the due pill, so a Date is formatted explicitly.
function dayOf(v: unknown): string | null {
  if (!v) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10)
  return String(v).slice(0, 10)
}

export const load: PageServerLoad = async ({ locals, url }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) throw error(403, 'Forbidden')

  const backend = resolveBoardBackendForPage()
  const ouIds = await resolveBoardOrgUnitScope({ userId: user.id, roles: user.roles })
  const allBoards = await backend.listBoardsForOrgUnits(ouIds)
  const boards = allBoards.filter((b) => !b.archived)
  const archivedCount = allBoards.length - boards.length
  // Friendly org-unit name for the switcher + header sub-line (id → name); the
  // per-Gremium hue is derived client-side from org_unit_id (committee-color).
  const orgUnits = await listOrgUnits()
  const ouNames = new Map(orgUnits.map((o) => [o.id, o.name]))

  // Units the user may create a board for: in their scope, no live board yet.
  // Only {id, name} leaves the server, and only for units in the user's scope.
  const scoped = new Set(ouIds)
  const withBoard = new Set(boards.map((b) => b.org_unit_id))
  const creatable = orgUnits
    .filter((o) => scoped.has(o.id) && !withBoard.has(o.id))
    .map((o) => ({ id: o.id, name: o.name }))

  const selectedId = url.searchParams.get('board') ?? boards[0]?.id ?? null
  const rawDeck = selectedId && boards.some((b) => b.id === selectedId) ? await backend.deckFor(selectedId) : null

  let deck: { board: BoardView & { org_unit_name: string }; stacks: StackView[]; cards: CardView[] } | null = null
  let members: MemberOption[] = []
  if (rawDeck) {
    const memberRows = await listOrgUnitMembers(rawDeck.board.org_unit_id)
    const memberIds = new Set(memberRows.map((m) => m.user_keycloak_id))
    const ids = [
      ...new Set([
        ...rawDeck.cards.map((c) => c.assignee_keycloak_id).filter((x): x is string => !!x),
        ...memberIds,
      ]),
    ]
    const names = await getDisplayNameResolver().resolveMany(ids)
    // the resolver answers the raw id for a user it cannot find: never show that as a name
    const nameOf = (id: string): string => {
      const n = names.get(id)
      return n && n !== id ? n : 'Mitglied ohne Namen'
    }
    members = [...memberIds].map((id) => ({ id, name: nameOf(id) })).sort((a, b) => a.name.localeCompare(b.name, 'de'))
    deck = {
      board: {
        id: rawDeck.board.id,
        org_unit_id: rawDeck.board.org_unit_id,
        org_unit_name: ouNames.get(rawDeck.board.org_unit_id) ?? '',
        name: rawDeck.board.name,
        archived: rawDeck.board.archived,
      },
      stacks: rawDeck.stacks.map((s) => ({ id: s.id, name: s.name, sort_order: s.sort_order })),
      cards: rawDeck.cards.map((c) => {
        const { assignee_keycloak_id, ...rest } = c
        return {
          ...rest,
          // Normalise to a bare YYYY-MM-DD so the client never receives a Date
          // object / full timestamp — the root of the old "Invalid Date" badge.
          due_date: dayOf(c.due_date),
          assignee_name: assignee_keycloak_id ? (names.get(assignee_keycloak_id) ?? null) : null,
          assignee_id: assignee_keycloak_id && memberIds.has(assignee_keycloak_id) ? assignee_keycloak_id : null,
          is_mine: assignee_keycloak_id === user.id,
        }
      }),
    }
  }

  return {
    boards: boards.map((b) => ({ id: b.id, org_unit_id: b.org_unit_id, name: b.name, archived: b.archived })),
    archivedCount,
    creatable,
    deck,
    members,
    me: user.id,
  }
}
