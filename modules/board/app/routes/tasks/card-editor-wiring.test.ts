import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8').replace(/\r\n/g, '\n')
const page = read('+page.svelte')
const column = read('../../lib/components/board/BoardColumn.svelte')

// The pieces are tested on their own (Card, CardEditor, BoardCreate); this pins that the page
// actually connects them, which a component test cannot see.
describe('the tasks page opens a card for editing', () => {
  it('passes a card click from the column up to the page, which mounts the editor for that card', () => {
    expect(column).toMatch(/<Card [^>]*(onopen=|\{onopen\})/)
    expect(page).toMatch(/<BoardColumn[\s\S]*?onopen=/)
    expect(page).toContain('<CardEditor')
    expect(page).toMatch(/<CardEditor[\s\S]*?members=\{data\.members\}/)
    expect(page).toMatch(/<CardEditor[\s\S]*?boardId=\{deck\.board\.id\}/)
  })

  it('reloads the board after a save, so the card is re-rendered from the server, and closes the editor', () => {
    const body = /async function onCardSaved\(\) \{([\s\S]*?)\n {2}\}/.exec(page)?.[1]
    expect(body).toBeDefined()
    expect(body).toContain('await invalidateAll()')
    expect(body).toMatch(/editing = null/)
    expect(page).toMatch(/<CardEditor[\s\S]*?onsaved=\{onCardSaved\}/)
  })

  it('remounts the editor per card, so a second card never starts with the first one\'s text', () => {
    expect(page).toMatch(/\{#key editing\.id\}[\s\S]*?<CardEditor/)
  })
})

describe('the tasks page offers one create control', () => {
  it('uses BoardCreate in the empty state and in the board bar, and no hand-made per-body buttons', () => {
    expect(page.match(/<BoardCreate/g)).toHaveLength(2)
    expect(page).not.toMatch(/Board für \{u\.name\} anlegen/)
  })
})
