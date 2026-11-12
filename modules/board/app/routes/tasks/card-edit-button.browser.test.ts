import '../../app.css'
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/svelte'
import { page as vpage } from 'vitest/browser'

/**
 * Every card keeps its edit button inside the card, in every column.
 *
 * The card foot is one row: [Sitzung] · spacer · [due] [avatar] [edit]. In a terminal column the
 * due chip reads "Erledigt" and carries a glyph, so the row is at its widest there. A row that
 * cannot wrap pushes its last item, the edit button, past the card's edge; in the last column
 * that is past the board's own scroll area, where the button can be neither seen nor clicked.
 * The columns may shrink to 248 px (the grid's minimum), so the row has to fit that width.
 *
 * Layout cannot be measured in jsdom, hence real Chromium. Each column holds the same two cards,
 * so the open columns are the control for the terminal one.
 */
const h = vi.hoisted(() => ({ pageData: {} as Record<string, unknown> }))
vi.mock('$app/state', () => ({
  page: {
    url: new URL('http://localhost/tasks'),
    get data() {
      return h.pageData
    },
  },
}))
vi.mock('$app/navigation', () => ({ invalidateAll: () => Promise.resolve(), goto: () => Promise.resolve() }))

import Page from './+page.svelte'

/** A bare card, and one whose foot carries everything a card can show. */
function cards(stack: number) {
  const base = {
    stack_id: `s${stack}`,
    description: null,
    created_by: null,
    created_at: '2026-11-01T10:00:00Z',
    assignee_id: null,
    is_mine: false,
  }
  return [
    { ...base, id: `c${stack}-plain`, title: 'Plakate drucken', due_date: null, label: null, sort_order: 0, protocol_action_item_id: null, assignee_name: null },
    { ...base, id: `c${stack}-full`, title: 'Raumanfrage stellen', due_date: '2026-11-20', label: 'Verwaltung', sort_order: 1, protocol_action_item_id: 'a1', assignee_name: 'Kim Beispiel' },
  ]
}

function pageData(stackNames: string[]) {
  return {
    boards: [{ id: 'b1', org_unit_id: 'u1', name: 'Aufgaben', archived: false }],
    creatable: [],
    archivedCount: 0,
    members: [],
    deck: {
      board: { id: 'b1', org_unit_id: 'u1', name: 'Aufgaben', archived: false, org_unit_name: 'Vorstand' },
      stacks: stackNames.map((name, i) => ({ id: `s${i}`, name, sort_order: i })),
      cards: stackNames.flatMap((_, i) => cards(i)),
    },
  }
}

async function mountAt(width: number, stackNames: string[]) {
  await vpage.viewport(width, 800)
  h.pageData = { brand: {} }
  const host = document.createElement('div')
  host.id = 'board-host'
  host.style.cssText = 'width: 100%; padding: 0 16px; box-sizing: border-box;'
  document.body.append(host)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render(Page, { props: { data: pageData(stackNames) } as any, target: host })
  return host
}

interface Measured {
  card: string
  /** px the button reaches past the card's right edge (<= 0: inside) */
  pastCardEdge: number
  insideCard: boolean
  /** the button is what a pointer finds at the button's centre */
  reachable: boolean
}

function measure(host: HTMLElement): Measured[] {
  const out: Measured[] = []
  for (const stackEl of host.querySelectorAll<HTMLElement>('.deck-stack')) {
    const stack = stackEl.querySelector('.deck-stack-head .t')?.textContent ?? '?'
    for (const cardEl of stackEl.querySelectorAll<HTMLElement>('.deck-card')) {
      const title = cardEl.querySelector('.deck-card-title')?.textContent ?? '?'
      const btn = cardEl.querySelector<HTMLElement>('button.deck-edit')
      if (!btn) {
        out.push({ card: `${stack} / ${title}`, pastCardEdge: Number.NaN, insideCard: false, reachable: false })
        continue
      }
      const c = cardEl.getBoundingClientRect()
      const b = btn.getBoundingClientRect()
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
      out.push({
        card: `${stack} / ${title}`,
        pastCardEdge: Math.round(b.right - c.right),
        insideCard: b.width > 0 && b.left >= c.left && b.right <= c.right && b.top >= c.top && b.bottom <= c.bottom,
        reachable: hit !== null && (hit === btn || btn.contains(hit)),
      })
    }
  }
  return out
}

afterEach(() => {
  cleanup()
  document.getElementById('board-host')?.remove()
})

const THREE = ['Offen', 'In Arbeit', 'Erledigt']
const FOUR = ['Offen', 'In Arbeit', 'Erledigt', 'Veröffentlicht']

describe('task board: the edit button of every card', () => {
  // Widths at which all columns fit the board: nothing is scrolled out of view, so every button
  // must also be the thing a pointer hits. 820 and 1040 put the columns at the 248 px minimum.
  test.each([
    { width: 820, stacks: THREE },
    { width: 900, stacks: THREE },
    { width: 1280, stacks: THREE },
    { width: 1040, stacks: FOUR },
  ])('$width px, $stacks.length columns: inside its card and reachable', async ({ width, stacks }) => {
    const host = await mountAt(width, stacks)
    const board = host.querySelector<HTMLElement>('.deck-board')!
    const measured = measure(host)
    expect(measured).toHaveLength(stacks.length * 2)
    expect(measured.filter((m) => !m.reachable)).toEqual([])
    expect(measured.filter((m) => !m.insideCard)).toEqual([])
    // The cards never widen the board past its columns.
    expect(board.scrollWidth - board.clientWidth).toBeLessThanOrEqual(0)
  })

  // A phone: the board scrolls sideways, so only the columns in view can be hit, but a button
  // still never leaves its own card.
  test('390 px: inside its card in every column, including the ones scrolled out of view', async () => {
    const host = await mountAt(390, THREE)
    const measured = measure(host)
    expect(measured).toHaveLength(6)
    expect(measured.filter((m) => !m.insideCard)).toEqual([])
  })
})
