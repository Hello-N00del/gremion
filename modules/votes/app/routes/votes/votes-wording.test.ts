// German interface wording of the votes page: the quick vote is an "Umfrage", never the English "Poll".
// Source guard on the page markup (the rendered page needs the whole shell), as for the page head.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test, expect } from 'vitest'

describe('/votes page wording', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '+page.svelte'), 'utf8')
  // The visible text of the markup: the script block, the style block and HTML comments are no screen text.
  const markup = source
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  test('the kind legend and the kind badges say Umfrage', () => {
    expect(markup).toMatch(/kind-dot poll[^>]*><\/span> Umfrage</)
    expect(markup.match(/<Icon name="poll" size=\{\d+\} \/> UMFRAGE</g)).toHaveLength(2)
  })

  test('no English "Poll" or "Polls" is left in the screen text, except the product name Nextcloud Polls', () => {
    const text = markup.replace(/Nextcloud Polls/g, 'NEXTCLOUD-PRODUCT')
    // markup attributes (class="poll", name="poll") are lower-case identifiers; screen text is capitalised
    const stray = text.match(/[>}\s-](?:POLL|Polls?)(?![A-Za-z-])/g) ?? []
    expect(stray).toEqual([])
  })
})
