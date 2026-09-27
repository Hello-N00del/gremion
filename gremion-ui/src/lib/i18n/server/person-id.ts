// TASK-062 TDD (Q2 default) — the personIdOf(locals) seam.
//
// SessionUser.id (locals.user.id) is a session subject, not a uuidv7
// idt.person_id (brief §5 Q2). There is no real subject->person mapping yet
// (TASK-031/080's residual), so this seam returns null until one exists; the
// cookie decides the locale meanwhile (resolveLocale's cookie step). The test
// DB maps explicitly via configurePersonIdMapperForTest().
//
export type PersonIdMapper = (sessionSubjectId: string) => string | null

export interface PersonIdLocals {
  user: { id: string } | null
}

/** Real mapping does not exist yet — TASK-031/080's residual. */
const noMappingYet: PersonIdMapper = () => null

let mapper: PersonIdMapper = noMappingYet

export function personIdOf(locals: PersonIdLocals): string | null {
  if (!locals.user) return null
  return mapper(locals.user.id)
}

/** Test-only: wires an explicit subject->person mapping (brief: "the test DB maps explicitly"). */
export function configurePersonIdMapperForTest(mapper_: PersonIdMapper): void {
  mapper = mapper_
}

export function resetPersonIdMapperForTest(): void {
  mapper = noMappingYet
}
