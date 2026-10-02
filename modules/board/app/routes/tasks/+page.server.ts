import type { PageServerLoad } from './$types'
import { error } from '@sveltejs/kit'
import { Role, hasRole } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { resolveBoardOrgUnitScope } from '$lib/server/board/scope'
import { resolveBoardBackendForPage } from '$lib/server/board/backend/resolve'
import { listOrgUnits } from '$lib/server/governance/org-units-db'
import { getDisplayNameResolver } from '$lib/server/identity/display-names'
import type { CardView, StackView, BoardView } from '$lib/components/board/types'

// The raw assignee UUID is NEVER emitted to the client; it is resolved to a
// display name on the server (consistent with WI-4B). CardView lives in a
// client-safe module so components can type against it.
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
  const ouNames = new Map((await listOrgUnits()).map((o) => [o.id, o.name]))

  const selectedId = url.searchParams.get('board') ?? boards[0]?.id ?? null
  const rawDeck = selectedId && boards.some((b) => b.id === selectedId) ? await backend.deckFor(selectedId) : null

  let deck: { board: BoardView & { org_unit_name: string }; stacks: StackView[]; cards: CardView[] } | null = null
  if (rawDeck) {
    const ids = rawDeck.cards.map((c) => c.assignee_keycloak_id).filter((x): x is string => !!x)
    const names = await getDisplayNameResolver().resolveMany(ids)
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
          due_date: c.due_date ? String(c.due_date).slice(0, 10) : null,
          assignee_name: assignee_keycloak_id ? (names.get(assignee_keycloak_id) ?? null) : null,
          is_mine: assignee_keycloak_id === user.id,
        }
      }),
    }
  }

  return {
    boards: boards.map((b) => ({ id: b.id, org_unit_id: b.org_unit_id, name: b.name, archived: b.archived })),
    archivedCount,
    deck,
    me: user.id,
  }
}
