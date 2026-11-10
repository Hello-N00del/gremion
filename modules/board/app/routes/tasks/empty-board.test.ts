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
