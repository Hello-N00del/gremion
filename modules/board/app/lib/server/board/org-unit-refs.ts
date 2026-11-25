// How many boards an org unit has, for the kernel's committee delete ('board:org-unit-refs').
// Read through the routed backend, so it answers from where the boards really are: the kernel
// tables, or the board module's own database (where nothing cascades from the unit). A board that
// moved leaves a stale copy in the kernel tables; only the live copy is counted. A failure, for
// instance a blocked board database, is passed on: the caller refuses the delete, it never reads
// "no answer" as "no boards".
import { getBoardBackend } from './backend'

export async function boardRefsOfOrgUnit(
  orgUnitId: string,
): Promise<{ referenced: boolean; counts: Record<string, number> }> {
  const boards = await getBoardBackend().listBoardsForOrgUnits([orgUnitId])
  return { referenced: boards.length > 0, counts: { boards: boards.length } }
}
