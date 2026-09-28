// TASK-062 TDD (Q2 default) — personIdOf(locals) table test.
import { describe, it, expect, afterEach } from 'vitest'
import { personIdOf, configurePersonIdMapperForTest, resetPersonIdMapperForTest } from './person-id'

afterEach(() => {
  resetPersonIdMapperForTest()
})

describe('personIdOf — Q2 default: null until a subject->person mapping exists', () => {
  it('no signed-in user: null', () => {
    expect(personIdOf({ user: null })).toBeNull()
  })

  it('signed-in user, no mapping configured (today\'s reality on main): null', () => {
    expect(personIdOf({ user: { id: 'session-subject-1' } })).toBeNull()
  })

  it('the test DB maps explicitly: configurePersonIdMapperForTest wires a real mapping', () => {
    configurePersonIdMapperForTest((subjectId) => (subjectId === 'session-subject-1' ? 'person-uuidv7-1' : null))
    expect(personIdOf({ user: { id: 'session-subject-1' } })).toBe('person-uuidv7-1')
  })

  it('an unmapped subject under a configured mapper still returns null', () => {
    configurePersonIdMapperForTest((subjectId) => (subjectId === 'session-subject-1' ? 'person-uuidv7-1' : null))
    expect(personIdOf({ user: { id: 'someone-else' } })).toBeNull()
  })

  it('resetPersonIdMapperForTest() restores the default null-until-mapped mapper', () => {
    configurePersonIdMapperForTest(() => 'always-mapped')
    resetPersonIdMapperForTest()
    expect(personIdOf({ user: { id: 'session-subject-1' } })).toBeNull()
  })
})
