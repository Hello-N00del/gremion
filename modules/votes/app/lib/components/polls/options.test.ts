import { describe, expect, it } from 'vitest'
import { duplicateOptionMessage, parsePollOptions } from './options'

describe('parsePollOptions', () => {
  it('keeps distinct lines in order, trimmed, and reports no duplicates', () => {
    expect(parsePollOptions('  Ja \nNein\n\n Enthaltung')).toEqual({ options: ['Ja', 'Nein', 'Enthaltung'], duplicates: [] })
  })
  it('reports a repeated line once, however often it repeats, and keeps its first place', () => {
    expect(parsePollOptions('Ja\nNein\nJa\n Ja \nNein')).toEqual({ options: ['Ja', 'Nein'], duplicates: ['Ja', 'Nein'] })
  })
  it('treats lines that differ in case as different options, as the poll does', () => {
    expect(parsePollOptions('Ja\nja')).toEqual({ options: ['Ja', 'ja'], duplicates: [] })
  })
  it('copes with CRLF line breaks and with nothing at all', () => {
    expect(parsePollOptions('A\r\nB\r\nA')).toEqual({ options: ['A', 'B'], duplicates: ['A'] })
    expect(parsePollOptions(null)).toEqual({ options: [], duplicates: [] })
  })
})

describe('duplicateOptionMessage', () => {
  it('is null without duplicates', () => {
    expect(duplicateOptionMessage([])).toBeNull()
  })
  it('names the repeated option in German', () => {
    expect(duplicateOptionMessage(['Ja'])).toBe('Die Option „Ja“ steht mehrfach in der Liste. Jede Option darf nur einmal vorkommen.')
  })
  it('names every repeated option', () => {
    expect(duplicateOptionMessage(['Ja', 'Nein'])).toContain('Die Optionen „Ja“, „Nein“ stehen mehrfach')
  })
})
