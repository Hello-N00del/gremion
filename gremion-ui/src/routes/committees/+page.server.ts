import type { PageServerLoad } from './$types'
import { buildOrgTree, type OrgTreeNode } from '$lib/server/governance/org-units-db'
import { deriveAbbr, deriveHue } from '$lib/governance/committee-color'
import { getDataProvider } from '$lib/server/modules/runtime-registry'
import { Role } from '$lib/auth/types'

// Member-facing Gremien tree (WI-3). Replaces the flat 2-bucket committee
// browser with the real org-unit hierarchy: Gremium → child_term → groups.
// The tree DTO keeps the per-node enrichments the cards carried (hue, abbr,
// budget, member count) and adds rollup counts, the friendly kind, and the
// admin flag the new UI needs for inline child_term editing.
export interface TreeNodeDTO {
  id: string
  label: string
  abbr: string
  hue: number
  desc: string
  kind: string
  kind_friendly: string
  /** P2.2 (#202, §3.5(d)): beratend vs beschließend — drives the authority badge. */
  authority: 'advisory' | 'deciding'
  childTerm: string | null
  wantsRoom: boolean
  wantsFiles: boolean
  memberCount: number
  rollupCount: number
  budget: number
  children: TreeNodeDTO[]
}

export const load: PageServerLoad = async ({ locals }) => {
  const [tree, budgets] = await Promise.all([
    buildOrgTree(),
    // Haushaltsansatz per OU, via the finance data provider (Session-A
    // inversion A3a — the kernel committees route no longer imports finance
    // internals). Finance unavailability (provider absent OR a throw) must not
    // blank the tree — degrade to no budget line.
    (getDataProvider('finance:committee-expense-budgets')?.() ?? Promise.resolve(new Map<string, number>()))
      .catch(() => new Map<string, number>()),
  ])

  const toDTO = (n: OrgTreeNode): TreeNodeDTO => ({
    id: n.ou.id,
    label: n.ou.name,
    abbr: deriveAbbr(n.ou.name),
    hue: deriveHue(n.ou.id),
    desc: n.ou.description ?? '',
    kind: n.ou.kind,
    kind_friendly: n.kind_friendly,
    authority: n.ou.authority,
    childTerm: n.child_term,
    wantsRoom: n.ou.wants_matrix_room,
    wantsFiles: n.ou.wants_nextcloud_folder,
    memberCount: n.member_count,
    rollupCount: n.rollup_count,
    budget: budgets.get(n.ou.id) ?? 0,
    children: n.children.map(toDTO),
  })

  const roles = locals.user?.roles ?? []
  const isAdmin = roles.includes(Role.CouncilAdmin) || roles.includes(Role.ITAdmin)
  return { tree: tree.map(toDTO), isAdmin }
}
