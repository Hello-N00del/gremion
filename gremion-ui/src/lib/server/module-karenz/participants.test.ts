// @vitest-environment node
//
// Module Karenz (phase 2, Task 8): the participant registry. The kernel owns it; a module registers into
// it from its own register.server.ts and the kernel never imports a module.
import { afterEach, describe, expect, it } from 'vitest'
import {
  _clearKarenzParticipantsForTests,
  karenzParticipantsFor,
  KarenzPartialError,
  registerKarenzParticipant,
  type KarenzParticipant,
} from './participants'

const participant = (catalogueId: string, tag = 'a'): KarenzParticipant & { tag: string } => ({
  catalogueId,
  tag,
  switchOff: async () => {},
  restore: async () => {},
  finalize: async () => ({ deleted: {} }),
})

afterEach(() => _clearKarenzParticipantsForTests())

describe('the Karenz participant registry', () => {
  it('registering twice for one id replaces; karenzParticipantsFor of an unknown id is empty', () => {
    expect(karenzParticipantsFor('votes')).toEqual([])
    registerKarenzParticipant(participant('votes', 'first'))
    registerKarenzParticipant(participant('votes', 'second'))
    registerKarenzParticipant(participant('elections', 'other'))
    const got = karenzParticipantsFor('votes') as unknown as Array<{ tag: string }>
    expect(got).toHaveLength(1)
    expect(got[0]!.tag).toBe('second')
    expect(karenzParticipantsFor('elections')).toHaveLength(1)
    expect(karenzParticipantsFor('nothing-registered')).toEqual([])
  })

  it('an id the module registers in another case or with spaces is a different id (no fuzzy match)', () => {
    registerKarenzParticipant(participant('votes'))
    expect(karenzParticipantsFor('Votes')).toEqual([])
    expect(karenzParticipantsFor(' votes')).toEqual([])
  })

  it('KarenzPartialError carries every failure and names itself (the engine reports the class, never the text)', () => {
    const e = new KarenzPartialError(['poll 3 refused', 'poll 7 gone'])
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('KarenzPartialError')
    expect(e.failures).toEqual(['poll 3 refused', 'poll 7 gone'])
    expect(e.message).toContain('2')
  })
})
