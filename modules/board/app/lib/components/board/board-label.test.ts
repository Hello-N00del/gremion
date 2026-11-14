import { describe, expect, it } from 'vitest'
import { boardChipLabel, type SwitcherBoard } from './board-label'

const board = (id: string, name: string, unit: string): SwitcherBoard => ({ id, org_unit_id: `ou-${id}`, name, org_unit_name: unit })

describe('the label of a board in the switcher', () => {
  it('names the committee next to a title that another board also carries', () => {
    const a = board('a', 'Aufgaben', 'Vorstand')
    const b = board('b', 'Aufgaben', 'Finanzausschuss')
    expect(boardChipLabel(a, [a, b])).toBe('Aufgaben · Vorstand')
    expect(boardChipLabel(b, [a, b])).toBe('Aufgaben · Finanzausschuss')
  })

  it('treats titles that differ only in case or outer spaces as the same title', () => {
    const a = board('a', 'Aufgaben', 'Vorstand')
    const b = board('b', ' aufgaben ', 'Finanzausschuss')
    expect(boardChipLabel(a, [a, b])).toBe('Aufgaben · Vorstand')
  })

  it('leaves a title alone that already tells the boards apart', () => {
    const a = board('a', 'Aufgaben', 'Vorstand')
    const b = board('b', 'Sommerfest', 'Kulturreferat')
    expect(boardChipLabel(a, [a, b])).toBe('Aufgaben')
    expect(boardChipLabel(b, [a, b])).toBe('Sommerfest')
    expect(boardChipLabel(a, [a])).toBe('Aufgaben')
  })

  it('adds no dangling separator when the committee name is unknown', () => {
    const a = board('a', 'Aufgaben', '')
    const b = board('b', 'Aufgaben', '   ')
    expect(boardChipLabel(a, [a, b])).toBe('Aufgaben')
    expect(boardChipLabel(b, [a, b])).toBe('Aufgaben')
  })

  it('does not repeat a committee name the title already is', () => {
    const a = board('a', 'Vorstand', 'Vorstand')
    const b = board('b', 'Vorstand', 'Alter Vorstand')
    expect(boardChipLabel(a, [a, b])).toBe('Vorstand')
    expect(boardChipLabel(b, [a, b])).toBe('Vorstand · Alter Vorstand')
  })
})
