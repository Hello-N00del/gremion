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

// ---- TASK-080-a G11: the real subject -> person mapping -------------------------------
//
// The kernel API finds the person by the token's VERIFIED `sub` (idt.person.idp_subject);
// gremion-ui learns the idt.person_id from its answer (KernelApiLocalePreferencePort
// .resolvePersonId) and remembers it here, so the synchronous personIdOf(locals) the
// hook uses answers from memory. A subject that was never resolved (or has no person)
// stays null: the cookie decides, as before. Bounded; a restart simply re-resolves.
const MAX_REMEMBERED = 10_000
const remembered = new Map<string, string>()

export function rememberPersonId(sessionSubjectId: string, personId: string): void {
  if (remembered.size >= MAX_REMEMBERED && !remembered.has(sessionSubjectId)) remembered.delete(remembered.keys().next().value as string)
  remembered.set(sessionSubjectId, personId)
}

export function forgetPersonId(sessionSubjectId: string): void {
  remembered.delete(sessionSubjectId)
}

/** The production mapper: the person the kernel API resolved for this subject, or null. */
export const rememberedPersonMapper: PersonIdMapper = (sessionSubjectId) => remembered.get(sessionSubjectId) ?? null

/** Binds the production mapper (call once at boot, together with configureLocalePreference({ backend: 'kernel-api' })). */
export function usePersonIdMapper(mapper_: PersonIdMapper = rememberedPersonMapper): void {
  mapper = mapper_
}

export function resetPersonIdMapperForTest(): void {
  remembered.clear()
  mapper = noMappingYet
}
