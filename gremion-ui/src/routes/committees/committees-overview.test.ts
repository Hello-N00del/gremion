// The committees overview header counts what the page lists (singular and plural right),
// and offers "Gremium anlegen" to exactly the roles the create page lets in.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import { Role } from '$lib/auth'
import type { TreeNodeDTO } from './+page.server'
import Page from './+page.svelte'

vi.mock('$app/state', () => ({ page: { data: {}, url: new URL('https://pilot.test/committees') } }))

const { mockBuildOrgTree } = vi.hoisted(() => ({ mockBuildOrgTree: vi.fn() }))
vi.mock('$lib/server/governance/org-units-db', () => ({ buildOrgTree: mockBuildOrgTree }))
vi.mock('$lib/server/modules/runtime-registry', () => ({ getDataProvider: () => undefined }))

const node = (id: string, memberCount: number, children: TreeNodeDTO[] = []): TreeNodeDTO => ({
  id,
  label: `Gremium ${id}`,
  abbr: 'GR',
  hue: 200,
  desc: '',
  kind: 'committee',
  kind_friendly: 'Gremium',
  authority: 'deciding',
  childTerm: null,
  wantsRoom: false,
  wantsFiles: false,
  memberCount,
  rollupCount: memberCount + children.reduce((s, c) => s + c.rollupCount, 0),
  budget: 0,
  children,
})

function subtitle(tree: TreeNodeDTO[]): string {
  const { container } = render(Page, { props: { data: { tree, isAdmin: false, canCreate: false } as never } })
  const text = container.querySelector('.page-sub')?.textContent ?? ''
  cleanup()
  return text.replace(/\s+/g, ' ').trim()
}

afterEach(() => cleanup())

describe('committees overview header counts', () => {
  it('counts every listed body, not only the top level: one root with ten children is eleven Gremien', () => {
    const kids = Array.from({ length: 10 }, (_, i) => node(`k${i}`, 0))
    expect(subtitle([node('root', 1, kids)])).toBe('11 Gremien · 1 Mitglied inkl. Untereinheiten')
  })

  it('one body with one member is singular for both nouns', () => {
    expect(subtitle([node('a', 1)])).toBe('1 Gremium · 1 Mitglied inkl. Untereinheiten')
  })

  it('several bodies and members are plural for both nouns', () => {
    expect(subtitle([node('a', 2), node('b', 3)])).toBe('2 Gremien · 5 Mitglieder inkl. Untereinheiten')
  })

  it('no members at all is plural', () => {
    expect(subtitle([node('a', 0)])).toBe('1 Gremium · 0 Mitglieder inkl. Untereinheiten')
  })
})

describe('committees overview load: canCreate follows the role check of the create page', () => {
  async function canCreateFor(roles: Role[]): Promise<boolean> {
    mockBuildOrgTree.mockResolvedValue([])
    const { load } = await import('./+page.server')
    const out = (await (load as (e: unknown) => Promise<{ canCreate: boolean }>)({ locals: { user: { roles } } }))
    return out.canCreate
  }

  it.each([[[Role.CouncilAdmin]], [[Role.ITAdmin]]])('%j may create', async (roles) => {
    expect(await canCreateFor(roles)).toBe(true)
  })

  it.each([[[Role.Member]], [[Role.Vorstand]], [[Role.Finance]], [[Role.Guest]], [[]]])('%j may not create', async (roles) => {
    expect(await canCreateFor(roles)).toBe(false)
  })
})

describe('committees overview: the Gremium anlegen link', () => {
  const links = (canCreate: boolean, tree: TreeNodeDTO[]) => {
    const { container } = render(Page, { props: { data: { tree, isAdmin: canCreate, canCreate } as never } })
    return Array.from(container.querySelectorAll('a')).map((a) => ({ href: a.getAttribute('href'), text: a.textContent?.trim() }))
  }

  it('is shown to a role that may create, pointing at the create page', () => {
    expect(links(true, [node('a', 1)])).toContainEqual({ href: '/members/committees/new', text: 'Gremium anlegen' })
  })

  it('is shown on the empty overview too, where it is the only way to a first body', () => {
    expect(links(true, [])).toContainEqual({ href: '/members/committees/new', text: 'Gremium anlegen' })
  })

  it('is absent for a role that may not create', () => {
    const hrefs = links(false, [node('a', 1)]).map((l) => l.href)
    expect(hrefs).not.toContain('/members/committees/new')
  })
})
