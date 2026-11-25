// The /votes create action used to drop a repeated option without a word (and say "after removing duplicates" only
// when fewer than two were left). It refuses a repeated option with a message naming it, before anything is created.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Role } from '$lib/auth'

const createPoll = vi.fn()

vi.mock('$lib/server/elections/backend', () => ({ getVotesBackend: () => ({ createPoll }) }))
vi.mock('$lib/server/elections/election-db', () => ({ ElectionDb: {} }))
vi.mock('$lib/server/governance/org-units-db', () => ({ getOrgUnit: vi.fn() }))
vi.mock('$lib/server/module-karenz/retained/views', () => ({ retainedViewsForPage: vi.fn() }))

const { actions } = await import('./+page.server')

function call(fields: Record<string, string>, roles: string[] = [Role.CouncilAdmin]) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.set(k, v)
  return (actions.create as (e: unknown) => Promise<unknown>)({
    request: { formData: async () => form },
    locals: { auth: async () => ({ user: { id: 'u1', roles } }) },
  }) as Promise<{ status?: number; success?: boolean; data?: { error?: string } }>
}

beforeEach(() => {
  vi.clearAllMocks()
  createPoll.mockResolvedValue(undefined)
})

describe('/votes ?/create - duplicate options', () => {
  it('refuses a repeated option with a message naming it and creates nothing', async () => {
    const res = await call({ title: 'Sommerfest', options: 'Ja\nNein\nJa' })
    expect(res.status).toBe(400)
    expect(res.data?.error).toContain('„Ja“')
    expect(res.data?.error).toContain('mehrfach')
    expect(createPoll).not.toHaveBeenCalled()
  })

  it('creates a poll whose options are all distinct', async () => {
    const res = await call({ title: 'Sommerfest', options: ' Ja \nNein' })
    expect(res.success).toBe(true)
    expect(createPoll).toHaveBeenCalledWith({ title: 'Sommerfest', type: 'textPoll', options: ['Ja', 'Nein'], anonymous: false })
  })

  it('still asks for two options when fewer are given', async () => {
    const res = await call({ title: 'Sommerfest', options: 'Ja' })
    expect(res.status).toBe(400)
    expect(res.data?.error).toContain('Mindestens 2 Optionen')
    expect(createPoll).not.toHaveBeenCalled()
  })
})
