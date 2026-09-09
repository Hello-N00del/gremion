// src/lib/source-offer.test.ts
// AGPL-3.0 section 13 guard: the running app must OFFER its Corresponding
// Source. This pins both halves — the URL resolution rules, and the fact that
// the app shell actually renders the offer. A licence file in the repo does not
// discharge section 13; a link a user can see does.
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/svelte'
import Sidebar from './components/layout/Sidebar.svelte'
import { resolveSourceUrl, DEFAULT_SOURCE_URL, SOURCE_OFFER_LABEL } from './source-offer'

describe('resolveSourceUrl', () => {
  it('falls back to upstream when unset', () => {
    expect(resolveSourceUrl(undefined)).toBe(DEFAULT_SOURCE_URL)
    expect(resolveSourceUrl(null)).toBe(DEFAULT_SOURCE_URL)
  })

  it('treats an empty or blank value as unset', () => {
    // compose substitutes ${VAR:-} as an EMPTY STRING, so this is the shape a
    // real misconfiguration arrives in — not undefined.
    expect(resolveSourceUrl('')).toBe(DEFAULT_SOURCE_URL)
    expect(resolveSourceUrl('   ')).toBe(DEFAULT_SOURCE_URL)
  })

  it("uses the operator's own repository when configured", () => {
    expect(resolveSourceUrl('https://git.council.example/gremion')).toBe(
      'https://git.council.example/gremion',
    )
    expect(resolveSourceUrl('  https://git.council.example/gremion  ')).toBe(
      'https://git.council.example/gremion',
    )
  })

  it('names the licence in the label so the offer is recognisable', () => {
    expect(SOURCE_OFFER_LABEL).toContain('AGPL')
  })
})

describe('the app shell renders the source offer', () => {
  it('puts a labelled link to the source in the sidebar chrome', () => {
    const { getByText } = render(Sidebar, {
      props: { nav: [], activeHref: '/', counts: { approvals: 0, liveVotes: 0, unread: 0 } },
    })
    const link = getByText(SOURCE_OFFER_LABEL)
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe(DEFAULT_SOURCE_URL)
    // An offer that opens a new tab must not hand the target a window handle.
    expect(link.getAttribute('rel')).toContain('noopener')
  })
})
