import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { voteCount } from './count'

describe('German vote count label', () => {
  it('reads "1 Stimme" for exactly one vote', () => {
    expect(voteCount(1)).toBe('1 Stimme')
  })

  it('reads the plural for none and for several', () => {
    expect(voteCount(0)).toBe('0 Stimmen')
    expect(voteCount(2)).toBe('2 Stimmen')
    expect(voteCount(15)).toBe('15 Stimmen')
  })
})

// The page prints the count through the helper; nobody may glue "Stimmen" onto a number again.
describe('the poll page', () => {
  const src = readFileSync(resolve(__dirname, '../../../routes/polls/[id]/+page.svelte'), 'utf8').replace(/\r\n/g, '\n')

  it('prints the vote count through voteCount, never "N Stimmen" by hand', () => {
    expect(src).not.toMatch(/\}\s+Stimmen\b/)
    expect(src).toContain('voteCount(option.votes.count)')
  })
})
