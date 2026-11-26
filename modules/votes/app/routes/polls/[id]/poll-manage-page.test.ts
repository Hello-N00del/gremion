import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte'

// The poll page offers "beenden" and "löschen" to the people who may do it (the load says so in
// `canManage`), each behind a confirmation. The server decides again on every request.
const nav = vi.hoisted(() => ({ goto: vi.fn(async () => {}), invalidateAll: vi.fn(async () => {}) }))
vi.mock('$app/navigation', () => nav)

const getPollWithOptions = vi.fn()
vi.mock('$lib/server/polls/polls-client', () => ({
  createPollsClient: () => ({ getPollWithOptions: (id: number) => getPollWithOptions(id) }),
}))

const { load } = await import('./+page.server')
const { default: Page } = await import('./+page.svelte')

function poll(over: { expired?: boolean; voted?: boolean } = {}) {
  return {
    id: 7,
    configuration: { title: 'Sommerfest', description: '', anonymous: false },
    status: { expired: over.expired ?? false },
    currentUserStatus: { countVotes: over.voted ? 1 : 0, isLocked: false },
    options: [{ id: 1, text: 'Ja', votes: { count: 0 } }, { id: 2, text: 'Nein', votes: { count: 0 } }],
  }
}
const open = (over: { expired?: boolean; canManage?: boolean } = {}) =>
  render(Page, { props: { data: { poll: poll(over), canManage: over.canManage ?? true } as never } })

const fetchMock = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('who sees the controls', () => {
  test('a manager sees both on a running poll', () => {
    open()
    expect(screen.getByRole('button', { name: 'Umfrage beenden' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Umfrage löschen' })).toBeTruthy()
  })

  test('someone who may not manage sees neither', () => {
    open({ canManage: false })
    expect(screen.queryByRole('button', { name: 'Umfrage beenden' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Umfrage löschen' })).toBeNull()
  })

  test('a closed poll cannot be closed again but can still be deleted', () => {
    open({ expired: true })
    expect(screen.queryByRole('button', { name: 'Umfrage beenden' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Umfrage löschen' })).toBeTruthy()
  })
})

describe('closing', () => {
  test('asks first, and sends nothing until it is confirmed', async () => {
    open()
    await fireEvent.click(screen.getByRole('button', { name: 'Umfrage beenden' }))
    expect(screen.getByText(/keine Stimmen mehr abgegeben/)).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
    await fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }))
    expect(screen.queryByText(/keine Stimmen mehr abgegeben/)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('the confirmation closes the poll and reloads it', async () => {
    open()
    await fireEvent.click(screen.getByRole('button', { name: 'Umfrage beenden' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Jetzt beenden' }))
    await waitFor(() => expect(nav.invalidateAll).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith('/api/polls/7', expect.objectContaining({ method: 'PATCH' }))
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ closed: true })
  })

  test('a refusal is shown and the poll stays as it is', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 403 }))
    open()
    await fireEvent.click(screen.getByRole('button', { name: 'Umfrage beenden' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Jetzt beenden' }))
    expect((await screen.findByRole('alert')).textContent).toContain('nicht beendet')
    expect(nav.invalidateAll).not.toHaveBeenCalled()
  })
})

describe('deleting', () => {
  test('asks first, and sends nothing until it is confirmed', async () => {
    open()
    await fireEvent.click(screen.getByRole('button', { name: 'Umfrage löschen' }))
    expect(screen.getByText(/endgültig gelöscht/)).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('the confirmation deletes the poll and leaves for the list', async () => {
    open()
    await fireEvent.click(screen.getByRole('button', { name: 'Umfrage löschen' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Endgültig löschen' }))
    await waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/votes', { invalidateAll: true }))
    expect(fetchMock).toHaveBeenCalledWith('/api/polls/7', expect.objectContaining({ method: 'DELETE' }))
  })

  test('a poll that belongs to a protocol says why it stays', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 409 }))
    open()
    await fireEvent.click(screen.getByRole('button', { name: 'Umfrage löschen' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Endgültig löschen' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Protokoll')
    expect(nav.goto).not.toHaveBeenCalled()
  })

  test('another failure is shown, and the poll page stays', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    open()
    await fireEvent.click(screen.getByRole('button', { name: 'Umfrage löschen' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Endgültig löschen' }))
    expect((await screen.findByRole('alert')).textContent).toContain('nicht gelöscht')
    expect(nav.goto).not.toHaveBeenCalled()
  })
})

describe('the load', () => {
  const event = (roles: string[]) =>
    ({ params: { id: '7' }, locals: { auth: async () => ({ user: { roles } }), accessToken: 'tok' } }) as never

  test.each([
    [['council-admin'], true],
    [['it-admin'], true],
    [['member'], false],
  ])('canManage for %j is %s', async (roles, expected) => {
    getPollWithOptions.mockResolvedValue(poll())
    const data = (await load(event(roles))) as { canManage: boolean }
    expect(data.canManage).toBe(expected)
  })
})
