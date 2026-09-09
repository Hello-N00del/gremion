// Shared dashboard card-section types (gremion#22 — G5 kernel dashboard
// split). These shapes are unchanged from +page.svelte /
// +page.server.ts; only their home moved so every extracted card component
// can import them without redeclaring or importing from the route itself.

// --- Real dashboard data (Task 3.6) ------------------------------------
// Sourced from +page.server.ts (calendar events, finance summary). Where a
// module has no data, the template renders an empty state — no fake rows.
export type Upcoming = {
  id: string
  startIso: string
  title: string
  where: string
  mine: boolean
  hue: number
}

export type BudgetSummary = { totalCents: number; freeCents: number; spentCents: number }

// "Auf deine Freigabe" — real approvals awaiting THIS user's signature,
// filtered + projected by +page.server.ts from /api/finance/approvals/pending.
// (The sidebar/KPI counts.approvals is the GLOBAL pending queue — distinct.)
export type SignerState = 'approved' | 'pending' | 'rejected'
export type MyApproval = {
  type: 'expense' | 'project' | 'budget'
  approvable_id: number
  amount_cents: number | null
  created_at: string | null
  signers: { role: string; state: SignerState }[]
}
