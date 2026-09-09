/**
 * Tenant term-map lookup (P2.2-data, design §3.5(e)).
 *
 * Internal IDs (role keys, capability keys, …) are STABLE across tenants —
 * the term map carries per-tenant DISPLAY-LABEL overrides only, keyed by
 * those stable IDs (e.g. `'role.council-admin' → 'Bürgermeister'` for a
 * municipal-council tenant). A missing map or missing key falls back to the
 * caller-supplied default label, so StuRa tenant #1 (no overrides in
 * DEFAULT_CONFIG) renders byte-identically.
 *
 * Known term keys (grep `termFor(` / `termKey` for the live call sites):
 *   - 'gremien'         — plural committee noun (nav section, crumbs, page copy)
 *   - 'gremienSingular' — singular committee noun (falls back to 'gremien')
 *   - 'navCommittees'   — the /committees rail-item label
 *   - 'councilAdmin'    — council-admin role label (dashboard)
 *   - 'fraktionen'      — caucus noun. PRESENCE is the gate (D6, design v11):
 *     the Fraktions-Panel (OrgDetailPanel) renders only for tenants that
 *     define it — StuRa defines no caucus term, so the panel disappears there.
 *
 * Client-safe: no server imports. This module is the DATA model only —
 * consumption at the role-filter sites rides P2.2-auth (after the P2.1b
 * merge).
 */
export function termFor<F extends string | null>(
  terms: Record<string, string> | undefined,
  key: string,
  // A `null` fallback turns the lookup into a PRESENCE GATE: the caller renders
  // the surface only when the tenant defines the term (D6).
  fallback: F,
): string | F {
  return terms?.[key] ?? fallback
}
