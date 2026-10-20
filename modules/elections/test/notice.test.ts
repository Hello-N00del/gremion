// PRD-ELE-002 (Should): where the optional elections module is enabled, a notice
// states that the module does not run the university's statutory election and
// that it is optional and off by default. TRD-030: off for the pilot tenant,
// provisioned disabled for every other council. Wording rules:
// docs/compliance/elections-scope.md section 2.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ELECTIONS_MODULE_ID,
  ELECTIONS_NOTICE_FACTS,
  ELECTIONS_NOTICE_ID,
  ELECTIONS_SCOPE_STATEMENT,
  electionsEnableNotice,
  type Address,
} from '../src/index.ts'

const ADDRESSES: Address[] = ['du', 'sie']
const text = (a: Address) => {
  const n = electionsEnableNotice(a)
  return [n.title, ...n.paragraphs, n.acknowledgeLabel].join('\n')
}

// The phrasings docs/compliance/elections-scope.md section 2 forbids (German).
const FORBIDDEN = [
  'rechtssichere Wahl',
  'rechtssichere Online-Wahl',
  'rechtsgültige Wahl',
  'rechtskonforme Wahl',
  'zulässig nach Landesrecht',
  'in allen Bundesländern zulässig',
  'für satzungsgemäße Wahlen geeignet',
  'ersetzt die Hochschulwahl',
  'amtliche Wahl',
  'offizielle Gremienwahl',
  'zertifiziertes Wahlsystem',
  'BSI-zertifiziert',
]

describe('elections enable-time notice', () => {
  it('states that the module does not run the statutory election, is optional and is off by default', () => {
    for (const a of ADDRESSES) {
      const t = text(a)
      expect(t).toContain('keine satzungsgemäßen Wahlen der Hochschule')
      expect(t).toContain('optional')
      expect(t).toContain('standardmäßig ausgeschaltet')
    }
    expect(ELECTIONS_SCOPE_STATEMENT).toBe(
      'Dieses Modul führt keine satzungsgemäßen Wahlen der Hochschule durch. Es ist optional und standardmäßig ausgeschaltet.',
    )
  })

  it('carries the structured facts the prose states: optional, off by default, no statutory election', () => {
    for (const a of ADDRESSES) {
      expect(electionsEnableNotice(a).facts).toEqual({ optional: true, defaultEnabled: false, runsStatutoryElection: false })
    }
    expect(Object.isFrozen(ELECTIONS_NOTICE_FACTS)).toBe(true)
  })

  it('names the elections module and a stable notice id', () => {
    const n = electionsEnableNotice()
    expect(n.moduleId).toBe(ELECTIONS_MODULE_ID)
    expect(ELECTIONS_MODULE_ID).toBe(JSON.parse(readFileSync(new URL('../module.json', import.meta.url), 'utf8')).id)
    expect(n.id).toBe(ELECTIONS_NOTICE_ID)
    expect(n.locale).toBe('de')
  })

  it('defaults to Du and has a Sie variant with no Du pronoun left in it (UX-013)', () => {
    expect(electionsEnableNotice().address).toBe('du')
    expect(text('du')).toMatch(/\b(Schalte|dein)\b/)
    expect(text('du')).not.toMatch(/\b(Schalten Sie|Ihr)\b/)
    expect(text('sie')).toMatch(/\b(Schalten Sie|Ihr)\b/)
    expect(text('sie')).not.toMatch(/\b(Schalte|dein)\b/)
    // the scope statement itself is pronoun-free, so both variants state it identically
    expect(electionsEnableNotice('du').paragraphs[0]).toBe(electionsEnableNotice('sie').paragraphs[0])
  })

  it('uses none of the phrasings the elections scope rules forbid', () => {
    for (const a of ADDRESSES) {
      for (const phrase of FORBIDDEN) expect(text(a)).not.toContain(phrase)
    }
  })

  it('makes no claim of lawfulness, certification or fitness for statutory use', () => {
    for (const a of ADDRESSES) {
      expect(text(a)).not.toMatch(/rechts(sicher|gültig|konform)|zertifiziert|amtlich|offiziell|geeignet|zulässig/i)
    }
  })

  it('refuses an unknown form of address instead of falling back silently', () => {
    expect(() => electionsEnableNotice('ihr' as Address)).toThrow(RangeError)
  })
})
