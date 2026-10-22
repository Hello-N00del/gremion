// The elections.notice.* catalogue keys that the Svelte notice renders must
// carry exactly the wording of notice.ts (PRD-ELE-002); the app half cannot
// import the module's src, so this test is the only tie between the two.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ELECTIONS_SCOPE_STATEMENT, electionsEnableNotice } from '../src/index.ts'

const MSG = join(__dirname, '..', '..', '..', 'gremion-ui', 'src', 'lib', 'i18n', 'messages')
const load = (l: string): Record<string, string> => JSON.parse(readFileSync(join(MSG, `${l}.json`), 'utf8'))

describe('elections.notice.* catalogue keys', () => {
  const de = load('de')
  const en = load('en')

  it('German text equals notice.ts for both forms of address', () => {
    const du = electionsEnableNotice('du')
    const sie = electionsEnableNotice('sie')
    expect(de['elections.notice.title']).toBe(du.title)
    expect(de['elections.notice.scope']).toBe(ELECTIONS_SCOPE_STATEMENT)
    expect(de['elections.notice.followUpDu']).toBe(du.paragraphs[1])
    expect(de['elections.notice.followUpSie']).toBe(sie.paragraphs[1])
  })

  it('English carries the same key set and never claims a legally valid election', () => {
    const keys = (c: Record<string, string>) => Object.keys(c).filter((k) => k.startsWith('elections.notice.')).sort()
    expect(keys(en)).toEqual(keys(de))
    expect(keys(de)).toHaveLength(4)
    expect(en['elections.notice.scope']).toMatch(/does not run/)
    expect(en['elections.notice.scope']).toMatch(/optional/)
  })
})
