import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import CardEditor from './CardEditor.svelte'
import type { CardView } from './types'

// Dragging is the only way the board moves a card between stacks; the editor offers the
// keyboard-reachable alternative (a stack select) and the delete of a card, with a confirmation.

const CARD: CardView = {
  id: 'c1',
  stack_id: 's1',
  title: 'Plakate drucken',
  description: null,
  due_date: null,
  label: null,
  sort_order: 0,
  protocol_action_item_id: null,
  created_by: null,
  created_at: new Date('2026-11-01T10:00:00Z'),
  assignee_name: null,
  assignee_id: null,
  is_mine: false,
}

// `end` is the next free position at the foot of the stack (the card itself not counted).
const STACKS = [
  { id: 's1', name: 'Offen', end: 3 },
  { id: 's2', name: 'In Arbeit', end: 0 },
  { id: 's3', name: 'Erledigt', end: 5 },
]

const fetchMock = vi.fn()
const ok = () => new Response(JSON.stringify({ data: { id: 'c1' } }), { status: 200 })
beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => ok())
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function open(extra: { stacks?: typeof STACKS } = {}) {
  const onclose = vi.fn()
  const onsaved = vi.fn()
  render(CardEditor, { boardId: 'b1', card: CARD, members: [], stacks: extra.stacks ?? STACKS, onclose, onsaved })
  return { onclose, onsaved }
}
const body = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body as string)

describe('moving a card with the keyboard', () => {
  it('offers every stack in a select named "Verschieben nach", the current one chosen', () => {
    open()
    const select = screen.getByLabelText('Verschieben nach') as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent?.trim())).toEqual(['Offen', 'In Arbeit', 'Erledigt'])
    expect(select.value).toBe('s1')
  })

  it('shows no stack select when the board has no other stack to move to', () => {
    open({ stacks: [STACKS[0]] })
    expect(screen.queryByLabelText('Verschieben nach')).toBeNull()
  })

  it('Speichern with another stack chosen moves the card to the foot of that stack', async () => {
    const { onsaved } = open()
    await fireEvent.change(screen.getByLabelText('Verschieben nach'), { target: { value: 's3' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    await waitFor(() => expect(onsaved).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/board/b1/cards')
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH')
    expect(body(0)).toEqual({ cardId: 'c1', stackId: 's3', order: 5 })
  })

  it('a changed title and a move are two requests, the edit first, and the dialog closes once', async () => {
    const { onsaved } = open()
    await fireEvent.input(screen.getByLabelText('Titel'), { target: { value: 'Plakate bestellen' } })
    await fireEvent.change(screen.getByLabelText('Verschieben nach'), { target: { value: 's2' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    await waitFor(() => expect(onsaved).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(body(0)).toEqual({ cardId: 'c1', title: 'Plakate bestellen' })
    expect(body(1)).toEqual({ cardId: 'c1', stackId: 's2', order: 0 })
  })

  it('a refused move keeps the dialog open with the reason, and a retry does not send the saved edit again', async () => {
    const { onsaved } = open()
    await fireEvent.input(screen.getByLabelText('Titel'), { target: { value: 'Plakate bestellen' } })
    await fireEvent.change(screen.getByLabelText('Verschieben nach'), { target: { value: 's2' } })
    fetchMock.mockImplementationOnce(async () => ok()).mockImplementationOnce(async () => new Response('{}', { status: 404 }))
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    expect((await screen.findByRole('alert')).textContent).toContain('verschoben')
    expect(onsaved).not.toHaveBeenCalled()
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    await waitFor(() => expect(onsaved).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(body(2)).toEqual({ cardId: 'c1', stackId: 's2', order: 0 })
  })

  it('Abbrechen after an edit was saved but the move failed still reloads the board', async () => {
    const { onclose, onsaved } = open()
    await fireEvent.input(screen.getByLabelText('Titel'), { target: { value: 'Plakate bestellen' } })
    await fireEvent.change(screen.getByLabelText('Verschieben nach'), { target: { value: 's2' } })
    fetchMock.mockImplementationOnce(async () => ok()).mockImplementationOnce(async () => new Response('{}', { status: 500 }))
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    await screen.findByRole('alert')
    await fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }))
    expect(onsaved).toHaveBeenCalledTimes(1)
    expect(onclose).not.toHaveBeenCalled()
  })
})

describe('deleting a card from the editor', () => {
  it('asks first: nothing is sent until the deletion is confirmed', async () => {
    open()
    await fireEvent.click(screen.getByRole('button', { name: 'Karte löschen' }))
    expect(screen.getByText(/endgültig gelöscht/)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('"Nicht löschen" goes back without a request', async () => {
    open()
    await fireEvent.click(screen.getByRole('button', { name: 'Karte löschen' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Nicht löschen' }))
    expect(screen.queryByText(/endgültig gelöscht/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Karte löschen' })).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the confirmation deletes the card and reloads the board', async () => {
    const { onsaved } = open()
    await fireEvent.click(screen.getByRole('button', { name: 'Karte löschen' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Endgültig löschen' }))
    await waitFor(() => expect(onsaved).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/board/b1/cards?cardId=c1')
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE')
  })

  it('a refused deletion keeps the dialog open and says so', async () => {
    const { onsaved } = open()
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 403 }))
    await fireEvent.click(screen.getByRole('button', { name: 'Karte löschen' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Endgültig löschen' }))
    expect((await screen.findByRole('alert')).textContent).toContain('gelöscht')
    expect(onsaved).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('a card that is already gone counts as deleted', async () => {
    const { onsaved } = open()
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 404 }))
    await fireEvent.click(screen.getByRole('button', { name: 'Karte löschen' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Endgültig löschen' }))
    await waitFor(() => expect(onsaved).toHaveBeenCalledTimes(1))
  })
})
