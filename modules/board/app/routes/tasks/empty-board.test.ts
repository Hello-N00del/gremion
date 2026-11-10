import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The "+ Karte" control lives in BoardColumn. If an empty board replaces the columns with a
// message, the first card can never be created.
const src = readFileSync(resolve(__dirname, '+page.svelte'), 'utf8').replace(/\r\n/g, '\n')

describe('an empty board', () => {
  it('still renders its columns, so the first card can be added', () => {
    const start = src.indexOf('{#if deck.cards.length === 0}')
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf('{/if}', start)
    expect(src.slice(start, end)).not.toContain('{:else}')
    expect(src.slice(end)).toContain('<BoardColumn')
  })

  it('shows every card by default, so a new unassigned card does not vanish', () => {
    expect(src).toMatch(/let filterMine = \$state\(false\)/)
  })
})

// A failed create must be visible whether or not the member already has a board: the create
// buttons exist in both the empty state and the board bar, and both call createBoard.
describe('a failed board create', () => {
  it('shows its error outside every if-block, so the board-bar buttons report failures too', () => {
    const at = src.indexOf('{#if createError}')
    expect(at).toBeGreaterThan(-1)
    // exactly one place renders it
    expect(src.indexOf('{#if createError}', at + 1)).toBe(-1)
    const before = src.slice(0, at)
    const opened = (before.match(/\{#if /g) ?? []).length
    const closed = (before.match(/\{\/if\}/g) ?? []).length
    expect(opened - closed).toBe(0)
    // and it sits before the empty/non-empty split of the page
    expect(at).toBeLessThan(src.indexOf('{#if data.boards.length === 0}'))
  })
})
