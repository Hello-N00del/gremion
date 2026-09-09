// org-units-db.test.ts — P2.2-data (#202) Task 9: the pure assembleOrgTree
// (extracted from buildOrgTree for unit-testability). Labels come from the
// per-unit kind_label override or the tenant kind catalog — the retired
// name-sniffing helper pair is dead (D-KL).
import { describe, it, expect } from 'vitest'
import { assembleOrgTree, type OrgUnit } from './org-units-db'
import { GREMION_ORG_SCHEMA } from './org-schema'

function unit(
  partial: Partial<OrgUnit> & Pick<OrgUnit, 'id' | 'kind' | 'name'>
): OrgUnit {
  return {
    parent_id: null,
    description: null,
    child_term: null,
    kind_label: null,
    authority: 'deciding',
    visibility: 'all_members',
    wants_matrix_room: false,
    wants_nextcloud_folder: false,
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...partial,
  }
}

// 3-level fixture: council → committee → group, direct counts 2/3/4.
const COUNCIL = unit({ id: 'c1', kind: 'council', name: 'StuRa' })
const COMMITTEE = unit({ id: 'r1', kind: 'committee', name: 'Referat Finanzen', parent_id: 'c1' })
const GROUP = unit({ id: 'g1', kind: 'group', name: 'AG Foo', parent_id: 'r1' })
const UNITS = [COUNCIL, COMMITTEE, GROUP]
const COUNTS = new Map([
  ['c1', 2],
  ['r1', 3],
  ['g1', 4],
])

describe('assembleOrgTree', () => {
  describe('labels', () => {
    it('unit kind_label wins over the catalog label', () => {
      const tree = assembleOrgTree(
        [unit({ id: 'v1', kind: 'committee', name: 'Vorstand', parent_id: 'c1', kind_label: 'Vorstand' }), COUNCIL],
        new Map(),
        GREMION_ORG_SCHEMA
      )
      expect(tree[0]!.children[0]!.kind_friendly).toBe('Vorstand')
    })

    it('falls back to the catalog label when kind_label is null', () => {
      const tree = assembleOrgTree(UNITS, new Map(), GREMION_ORG_SCHEMA)
      expect(tree[0]!.kind_friendly).toBe('Gremium')
      expect(tree[0]!.children[0]!.kind_friendly).toBe('Referat')
    })

    it('falls back to the raw kind key when the catalog lacks the kind', () => {
      const tree = assembleOrgTree(
        [unit({ id: 'f1', kind: 'fraktion', name: 'Fraktion Grün' })],
        new Map(),
        GREMION_ORG_SCHEMA
      )
      expect(tree[0]!.kind_friendly).toBe('fraktion')
    })

    it("sniffing is dead: a group named 'AG Foo' with kind_label=null labels 'Gruppe' (D-KL)", () => {
      const tree = assembleOrgTree(
        [unit({ id: 'g9', kind: 'group', name: 'AG Foo' })],
        new Map(),
        GREMION_ORG_SCHEMA
      )
      expect(tree[0]!.kind_friendly).toBe('Gruppe')
    })
  })

  describe('rollup parity (§6-P2.2 no-double-count)', () => {
    it('counts 2/3/4 over council→committee→group yield rollups 9/7/4 and member_counts 2/3/4', () => {
      const tree = assembleOrgTree(UNITS, COUNTS, GREMION_ORG_SCHEMA)
      const council = tree[0]!
      const committee = council.children[0]!
      const group = committee.children[0]!
      expect(council.member_count).toBe(2)
      expect(committee.member_count).toBe(3)
      expect(group.member_count).toBe(4)
      expect(council.rollup_count).toBe(9)
      expect(committee.rollup_count).toBe(7)
      expect(group.rollup_count).toBe(4)
    })

    it('defaults missing counts to 0', () => {
      const tree = assembleOrgTree(UNITS, new Map(), GREMION_ORG_SCHEMA)
      expect(tree[0]!.member_count).toBe(0)
      expect(tree[0]!.rollup_count).toBe(0)
    })
  })

  describe('child_term', () => {
    it('ou.child_term wins over the catalog childTerm', () => {
      const tree = assembleOrgTree(
        [unit({ id: 'c1', kind: 'council', name: 'StuRa', child_term: 'Ausschüsse' }), COMMITTEE],
        new Map(),
        GREMION_ORG_SCHEMA
      )
      expect(tree[0]!.child_term).toBe('Ausschüsse')
    })

    it("pins today's childTermFor output: council→'Referate', committee→'Arbeitsgruppen', group→null", () => {
      const tree = assembleOrgTree(
        [...UNITS, unit({ id: 'g2', kind: 'group', name: 'Untergruppe', parent_id: 'g1' })],
        new Map(),
        GREMION_ORG_SCHEMA
      )
      const council = tree[0]!
      const committee = council.children[0]!
      const group = committee.children[0]!
      expect(council.child_term).toBe('Referate')
      expect(committee.child_term).toBe('Arbeitsgruppen')
      // group has a child but the catalog childTerm is null → null
      expect(group.child_term).toBeNull()
    })

    it('is null for leaves even when the catalog has a childTerm', () => {
      const tree = assembleOrgTree([COUNCIL], new Map(), GREMION_ORG_SCHEMA)
      expect(tree[0]!.children).toEqual([])
      expect(tree[0]!.child_term).toBeNull()
    })

    it("child_term='' falls through to the catalog default (old childTermFor truthiness)", () => {
      // A stored '' (reachable via the child-term PATCH at base) must render
      // exactly like NULL — the kind default — not hide the tree sub-header.
      const tree = assembleOrgTree(
        [unit({ id: 'c1', kind: 'council', name: 'StuRa', child_term: '' }), COMMITTEE],
        new Map(),
        GREMION_ORG_SCHEMA
      )
      expect(tree[0]!.child_term).toBe('Referate')
    })

    it("child_term='' on a kind without a catalog childTerm yields null", () => {
      const tree = assembleOrgTree(
        [
          unit({ id: 'g1', kind: 'group', name: 'AG Foo', child_term: '' }),
          unit({ id: 'g2', kind: 'group', name: 'Untergruppe', parent_id: 'g1' }),
        ],
        new Map(),
        GREMION_ORG_SCHEMA
      )
      expect(tree[0]!.child_term).toBeNull()
    })
  })
})
