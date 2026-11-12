import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cardCount, stackCount } from './count'

describe('German count labels', () => {
  it('reads "1 Karte" for exactly one card', () => {
    expect(cardCount(1)).toBe('1 Karte')
  })

  it('reads the plural for none and for several', () => {
    expect(cardCount(0)).toBe('0 Karten')
    expect(cardCount(2)).toBe('2 Karten')
    expect(cardCount(12)).toBe('12 Karten')
  })

  it('reads "1 Stack" / "3 Stacks"', () => {
    expect(stackCount(1)).toBe('1 Stack')
    expect(stackCount(3)).toBe('3 Stacks')
  })
})

// The page prints the count twice (header sub-line and the filter bar); neither may glue "Karten"
// onto a number again.
describe('the board page', () => {
  const src = readFileSync(resolve(__dirname, '../../../routes/tasks/+page.svelte'), 'utf8').replace(/\r\n/g, '\n')

  it('prints card and stack counts through the helpers, never "N Karten" by hand', () => {
    expect(src).not.toMatch(/\}\s+Karten\b/)
    expect(src).not.toMatch(/\}\s+Stacks\b/)
    expect(src).toContain('cardCount(visibleCards.length)')
    expect(src).toContain('stackCount(deck.stacks.length)')
  })
})
