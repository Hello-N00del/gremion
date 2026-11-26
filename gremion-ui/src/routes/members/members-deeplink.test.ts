// The command palette links a person to /members?member=<handle>: the page opens that person's detail
// panel. A handle that is not in the list (a person the caller may not see, a typo) opens nothing.
import { describe, test, expect, vi } from 'vitest'
import { render } from '@testing-library/svelte'

const h = vi.hoisted(() => ({ search: '' }))
vi.mock('$app/state', () => ({
  page: {
    get url() {
      return new URL(`http://x/members${h.search}`)
    },
    data: {},
  },
}))

import Page from './+page.svelte'

function member(id: string, name: string) {
  return { id, name, email: `${id}@example.org`, enabled: true, roles: ['Mitglied'], scopes: [], memberships: [], placed: true }
}

function mount(search: string) {
  h.search = search
  const data = { members: [member('mira', 'Mira Kowalski'), member('jo', 'Jo Beispiel')], isAdmin: false }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(Page, { props: { data } as any })
}

describe('/members?member=<handle>', () => {
  test('opens the detail panel of that person', () => {
    const { getByRole } = mount('?member=mira')
    const panel = getByRole('complementary', { name: 'Mitglied-Detail' })
    expect(panel.textContent).toContain('Mira Kowalski')
    expect(panel.textContent).not.toContain('Jo Beispiel')
  })

  test('a handle that is not in the list opens nothing', () => {
    const { queryByRole } = mount('?member=unknown')
    expect(queryByRole('complementary', { name: 'Mitglied-Detail' })).toBeNull()
  })

  test('without the parameter the page opens no panel', () => {
    const { queryByRole } = mount('')
    expect(queryByRole('complementary', { name: 'Mitglied-Detail' })).toBeNull()
  })
})
