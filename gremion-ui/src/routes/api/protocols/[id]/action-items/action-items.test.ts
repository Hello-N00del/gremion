// Minutes tasks: the create and edit routes refuse what the page refuses, so a
// direct request cannot leave an empty task, a malformed date or an assignee who
// is not a member of the body behind.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetProtocol, mockAddActionItem, mockUpdateActionItem, mockGetActionItem, mockIsMemberOf } = vi.hoisted(() => ({
  mockGetProtocol: vi.fn(),
  mockAddActionItem: vi.fn(),
  mockUpdateActionItem: vi.fn(),
  mockGetActionItem: vi.fn(),
  mockIsMemberOf: vi.fn(),
}))
vi.mock('$lib/server/protocols/protocol-db', () => ({
  getProtocol: mockGetProtocol,
  addActionItem: mockAddActionItem,
  updateActionItem: mockUpdateActionItem,
  getActionItem: mockGetActionItem,
}))
vi.mock('$lib/server/governance/org-units-db', () => ({ isMemberOf: mockIsMemberOf }))

import { POST } from './+server'
import { PATCH } from './[itemId]/+server'

const PID = '11111111-1111-4111-8111-111111111111'
const IID = '22222222-2222-4222-8222-222222222222'
const COMMITTEE = '33333333-3333-4333-8333-333333333333'
const admin = { id: 'admin-1', roles: ['council-admin'] }

const post = (body: unknown) =>
  POST({ locals: { user: admin }, params: { id: PID }, request: new Request('http://x', { method: 'POST', body: JSON.stringify(body) }) } as never)
const patch = (body: unknown) =>
  PATCH({ locals: { user: admin }, params: { id: PID, itemId: IID }, request: new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }) } as never)

beforeEach(() => {
  vi.resetAllMocks()
  mockGetProtocol.mockResolvedValue({ id: PID, committee_id: COMMITTEE, status: 'draft' })
  mockGetActionItem.mockResolvedValue({ id: IID, protocol_id: PID })
  mockAddActionItem.mockResolvedValue({ id: IID, text: 'x' })
  mockUpdateActionItem.mockResolvedValue({ id: IID, text: 'x' })
  mockIsMemberOf.mockResolvedValue(true)
})

describe('POST /api/protocols/[id]/action-items', () => {
  it('stores a task with its title, due date and assignee', async () => {
    const res = await post({ text: '  Kasse prüfen ', dueDate: '2026-12-10', assigneeKeycloakId: 'u-1' })
    expect(res.status).toBe(201)
    expect(mockAddActionItem).toHaveBeenCalledWith(PID, { text: 'Kasse prüfen', assigneeKeycloakId: 'u-1', dueDate: '2026-12-10' })
    expect(mockIsMemberOf).toHaveBeenCalledWith(COMMITTEE, 'u-1')
  })

  it.each([[''], ['   '], [undefined]])('refuses a task without a title (%j) and stores nothing', async (text) => {
    await expect(post({ text })).rejects.toMatchObject({ status: 400 })
    expect(mockAddActionItem).not.toHaveBeenCalled()
  })

  it('refuses a due date that is not a calendar date', async () => {
    await expect(post({ text: 'A', dueDate: '10.12.2026' })).rejects.toMatchObject({ status: 400 })
    await expect(post({ text: 'A', dueDate: '2026-02-31' })).rejects.toMatchObject({ status: 400 })
    expect(mockAddActionItem).not.toHaveBeenCalled()
  })

  it('refuses an assignee who is not a member of the body', async () => {
    mockIsMemberOf.mockResolvedValue(false)
    await expect(post({ text: 'A', assigneeKeycloakId: 'stranger' })).rejects.toMatchObject({ status: 400 })
    expect(mockAddActionItem).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/protocols/[id]/action-items/[itemId]', () => {
  it('stores the due date and the assignee', async () => {
    const res = await patch({ text: 'Neu', dueDate: '2026-12-10', assigneeKeycloakId: 'u-1' })
    expect(res.status).toBe(200)
    expect(mockUpdateActionItem).toHaveBeenCalledWith(IID, { text: 'Neu', dueDate: '2026-12-10', assigneeKeycloakId: 'u-1', completed: undefined })
  })

  it('refuses to blank the title of a stored task', async () => {
    await expect(patch({ text: '   ' })).rejects.toMatchObject({ status: 400 })
    expect(mockUpdateActionItem).not.toHaveBeenCalled()
  })

  it('a completed toggle alone needs no title', async () => {
    const res = await patch({ completed: true })
    expect(res.status).toBe(200)
  })

  it('refuses a malformed due date', async () => {
    await expect(patch({ dueDate: 'morgen' })).rejects.toMatchObject({ status: 400 })
    expect(mockUpdateActionItem).not.toHaveBeenCalled()
  })

  it('refuses an item that belongs to another protocol', async () => {
    mockGetActionItem.mockResolvedValue({ id: IID, protocol_id: '44444444-4444-4444-8444-444444444444' })
    await expect(patch({ text: 'x' })).rejects.toMatchObject({ status: 404 })
    expect(mockUpdateActionItem).not.toHaveBeenCalled()
  })

  it('refuses an edit once the protocol is published', async () => {
    mockGetProtocol.mockResolvedValue({ id: PID, committee_id: COMMITTEE, status: 'published' })
    await expect(patch({ text: 'x' })).rejects.toMatchObject({ status: 403 })
    await expect(patch({ dueDate: '2026-12-10' })).rejects.toMatchObject({ status: 403 })
    await expect(patch({ assigneeKeycloakId: null })).rejects.toMatchObject({ status: 403 })
    expect(mockUpdateActionItem).not.toHaveBeenCalled()
  })

  it('still lets a task be ticked off once the protocol is published', async () => {
    mockGetProtocol.mockResolvedValue({ id: PID, committee_id: COMMITTEE, status: 'published' })
    const res = await patch({ completed: true })
    expect(res.status).toBe(200)
    expect(mockUpdateActionItem).toHaveBeenCalledWith(IID, { text: undefined, dueDate: undefined, assigneeKeycloakId: undefined, completed: true })
  })

  it('an empty assignee or due date clears it, a field that was not sent stays untouched', async () => {
    await patch({ text: 'A', assigneeKeycloakId: null, dueDate: null })
    expect(mockUpdateActionItem).toHaveBeenLastCalledWith(IID, { text: 'A', assigneeKeycloakId: null, dueDate: null, completed: undefined })
    await patch({ assigneeKeycloakId: '', dueDate: '' })
    expect(mockUpdateActionItem).toHaveBeenLastCalledWith(IID, { text: undefined, assigneeKeycloakId: null, dueDate: null, completed: undefined })
    await patch({ text: 'B' })
    expect(mockUpdateActionItem).toHaveBeenLastCalledWith(IID, { text: 'B', assigneeKeycloakId: undefined, dueDate: undefined, completed: undefined })
    expect(mockIsMemberOf).not.toHaveBeenCalled()
  })

  it('clearing needs no membership check', async () => {
    mockIsMemberOf.mockResolvedValue(false)
    const res = await patch({ assigneeKeycloakId: null })
    expect(res.status).toBe(200)
  })

  it('refuses a new assignee who is not a member of the body', async () => {
    mockGetActionItem.mockResolvedValue({ id: IID, protocol_id: PID, assignee_keycloak_id: 'u-1' })
    mockIsMemberOf.mockResolvedValue(false)
    await expect(patch({ assigneeKeycloakId: 'stranger' })).rejects.toMatchObject({ status: 400 })
    expect(mockUpdateActionItem).not.toHaveBeenCalled()
  })

  it('an edit that keeps the stored assignee passes although that person has left the body', async () => {
    mockGetActionItem.mockResolvedValue({ id: IID, protocol_id: PID, assignee_keycloak_id: 'u-gone' })
    mockIsMemberOf.mockResolvedValue(false)
    const res = await patch({ text: 'Neuer Titel', assigneeKeycloakId: 'u-gone' })
    expect(res.status).toBe(200)
    expect(mockUpdateActionItem).toHaveBeenCalledWith(IID, expect.objectContaining({ text: 'Neuer Titel', assigneeKeycloakId: 'u-gone' }))
  })
})
