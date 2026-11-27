// The command palette links an event as /calendar?date=YYYY-MM-DD. When the person is already on the
// calendar, SvelteKit keeps the page component alive and only the URL changes: the calendar must still
// move to the linked day.
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/svelte'
import { flushSync } from 'svelte'
import { get } from 'svelte/store'

const h = vi.hoisted(() => ({ url: null as null | { search: string } }))
vi.mock('$app/state', async () => {
  const { SvelteURL } = await import('svelte/reactivity')
  const url = new SvelteURL('http://x/calendar')
  h.url = url
  return { page: { url, data: {} } }
})

import Page from './+page.svelte'
import { calendarDate } from '$lib/stores/calendar'

function mountOn(search: string) {
  window.history.replaceState({}, '', `/calendar${search}`)
  h.url!.search = search
  const data = { user: { roles: ['council_member'] }, committees: [], eventTypes: [] }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(Page, { props: { data } as any })
}

const dayOf = (d: Date) => [d.getFullYear(), d.getMonth() + 1, d.getDate()]

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 })))
  calendarDate.set(new Date(2026, 0, 15, 12))
})

describe('/calendar?date= on the calendar page', () => {
  test('opening the page with the parameter shows that day', () => {
    mountOn('?date=2026-03-04')
    flushSync()
    expect(dayOf(get(calendarDate))).toEqual([2026, 3, 4])
  })

  test('a link followed while the page is already open moves the calendar to that day', () => {
    mountOn('')
    flushSync()
    expect(dayOf(get(calendarDate))).toEqual([2026, 1, 15])
    h.url!.search = '?date=2026-09-21'
    flushSync()
    expect(dayOf(get(calendarDate))).toEqual([2026, 9, 21])
  })

  test('an invalid parameter value leaves the shown day alone', () => {
    mountOn('')
    flushSync()
    h.url!.search = '?date=2026-02-30'
    flushSync()
    expect(dayOf(get(calendarDate))).toEqual([2026, 1, 15])
  })
})
