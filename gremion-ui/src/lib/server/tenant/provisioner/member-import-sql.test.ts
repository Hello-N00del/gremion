// TASK-031 fix round: the SQL store resolves a member list's `body` against the
// customer's ROOT body only. The fake `getDb` below interprets the one clause
// that matters (`parent_id IS NULL`), so removing it from the query turns the
// test RED; the real SQL runs in the scratch-stack proof.
import { describe, expect, it, vi } from 'vitest'
import { validateList } from '@gremion/member-import'

const UNITS = [
  { id: 'root-1', parent_id: null, name: 'Musterstadt Rat' },
  { id: 'unit-2', parent_id: 'root-1', name: 'Referat Finanzen' },
  { id: 'unit-3', parent_id: 'unit-2', name: 'AG Haushalt' },
]

vi.mock('$lib/server/db', () => ({
  getDb: () => {
    return (strings: TemplateStringsArray) => {
      const text = strings.join('?')
      if (!/FROM org_units/.test(text)) throw new Error(`unexpected query: ${text}`)
      const rows = /WHERE parent_id IS NULL/.test(text) ? UNITS.filter((u) => u.parent_id === null) : UNITS
      return Promise.resolve(rows.map((r) => ({ id: r.id, name: r.name })))
    }
  },
}))

import { bodiesOf, sqlOrgStore } from './member-import-adapters'

const ROLES = { schema_version: 1 as const, roles: [{ key: 'member', importable: true, membership_type: 'elected', voting: true, capabilities: [], withheld: [] }] }

describe('member list bodies = the root body only', () => {
  it('sqlOrgStore().listBodies() returns the root, not its committees or groups', async () => {
    expect(await sqlOrgStore().listBodies()).toEqual([{ id: 'root-1', name: 'Musterstadt Rat' }])
  })

  it('a row naming a sub-unit (a Referat, an AG) is unknown_body; the root name validates', async () => {
    const bodies = await sqlOrgStore().listBodies()
    const r = validateList(
      'name,email,body,role\nAnna Berger,a@x.example,Referat Finanzen,\nBen Ho,b@x.example,AG Haushalt,\nCem Yildiz,c@x.example,Musterstadt Rat,\n',
      { bodies, roles: ROLES as never },
    )
    expect(r.rejected.map((x) => [x.row, x.reason])).toEqual([
      [2, 'unknown_body'],
      [3, 'unknown_body'],
    ])
    expect(r.valid.map((v) => v.row)).toEqual([4])
  })

  it('bodiesOf keeps only parentless units (pure)', () => {
    expect(bodiesOf([{ id: 'a', parentId: null, name: 'A' }, { id: 'b', parentId: 'a', name: 'B' }])).toEqual([{ id: 'a', name: 'A' }])
  })
})
