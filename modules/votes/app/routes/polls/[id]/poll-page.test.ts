import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/svelte'

// The poll page (/polls/[id]): German vote counts, a card whose title does not touch the
// border, and a top-bar section label that is the poll title instead of the bare id.

const getPollWithOptions = vi.fn()

vi.mock('$lib/server/polls/polls-client', () => ({
  createPollsClient: () => ({ getPollWithOptions: (id: number) => getPollWithOptions(id) }),
}))

const { load } = await import('./+page.server')
const { default: Page } = await import('./+page.svelte')

function poll(counts: number[], over: { title?: string; voted?: boolean } = {}) {
  return {
    id: 1,
    configuration: { title: over.title ?? 'Sommerfest', description: '', anonymous: false },
    status: { expired: false },
    currentUserStatus: { countVotes: over.voted === false ? 0 : 1, isLocked: false },
    options: counts.map((count, i) => ({ id: i + 1, text: `Option ${i + 1}`, votes: { count } })),
  }
}

describe('poll page vote counts', () => {
  test('one vote reads "1 Stimme", not "1 Stimmen"', () => {
    const { container } = render(Page, { props: { data: { poll: poll([1]) } as never } })
    const text = container.textContent ?? ''
    expect(text).toContain('1 Stimme')
    expect(text).not.toContain('1 Stimmen')
  })

  test('two votes read "2 Stimmen", none reads "0 Stimmen"', () => {
    const { container } = render(Page, { props: { data: { poll: poll([2, 0]) } as never } })
    const text = container.textContent ?? ''
    expect(text).toContain('2 Stimmen')
    expect(text).toContain('0 Stimmen')
  })
})

describe('poll page card', () => {
  test('the title row has horizontal and top padding of its own', () => {
    const { getByTestId } = render(Page, { props: { data: { poll: poll([1]) } as never } })
    const head = getByTestId('poll-card-head')
    expect(head.style.paddingLeft).not.toBe('')
    expect(head.style.paddingRight).not.toBe('')
    expect(head.style.paddingTop).not.toBe('')
  })
})

describe('poll page load: top-bar section label', () => {
  beforeEach(() => getPollWithOptions.mockReset())

  const event = (id: string) =>
    ({
      params: { id },
      locals: { auth: async () => ({ user: { roles: ['member'] } }), accessToken: 'tok' },
    }) as never

  test('the id segment is shown as the poll title, not as the bare id', async () => {
    getPollWithOptions.mockResolvedValue(poll([0], { title: 'Sommerfest' }))
    const data = (await load(event('1'))) as { crumbOverrides: Record<string, string | null> }
    expect(data.crumbOverrides['1']).toBe('Sommerfest')
    expect(data.crumbOverrides['1']).not.toBe('1')
  })

  test('the section segment reads "Abstimmungen"', async () => {
    getPollWithOptions.mockResolvedValue(poll([0]))
    const data = (await load(event('1'))) as { crumbOverrides: Record<string, string | null> }
    expect(data.crumbOverrides.polls).toBe('Abstimmungen')
  })

  test('a blank title falls back to a neutral label, never the id', async () => {
    getPollWithOptions.mockResolvedValue(poll([0], { title: '   ' }))
    const data = (await load(event('7'))) as { crumbOverrides: Record<string, string | null> }
    expect(data.crumbOverrides['7']).toBe('Umfrage')
  })
})
