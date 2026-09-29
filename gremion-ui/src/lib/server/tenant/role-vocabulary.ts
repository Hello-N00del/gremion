// src/lib/server/tenant/role-vocabulary.ts
// P2.2-auth A1 (D-VOCAB): the per-tenant role vocabulary is a SEAM, not new
// storage. `roleVocabularyForTenant(ctx)` returns the tenant's valid
// realm-role keys — default = `Object.values(Role)` for EVERY tenant today
// (byte-identical), with an OPTIONAL override read from the tenant config
// (`config.roles?: string[]`, zod-validated in $lib/server/config, absent in
// every existing config). P2.3's municipal blueprint supplies real overrides;
// no registry column, no migration.
import { Role } from '$lib/auth/types'
import type { GremionConfig } from '$lib/server/config'

/** The narrow slice of TenantContext this module consumes. */
export interface VocabularyTenant {
  readonly config: Pick<GremionConfig, 'roles' | 'financeRoles'>
}

/**
 * Today's vocabulary — exactly `Object.values(Role)`, frozen so the shared
 * default array can never be mutated through a consumer. Golden-pinned in
 * role-vocabulary.test.ts (tenant #1 byte-identical).
 */
export const DEFAULT_ROLE_VOCABULARY: readonly string[] = Object.freeze(Object.values(Role))

/**
 * The tenant's valid realm-role keys. `config.roles` override ?? the Role
 * enum — `??` deliberately catches only an ABSENT override: an explicit empty
 * array is a (fail-closed) narrowing to no mappable roles.
 */
export function roleVocabularyForTenant(ctx: VocabularyTenant): readonly string[] {
  return ctx.config.roles ?? DEFAULT_ROLE_VOCABULARY
}

/**
 * Today's finance-role display labels — exactly KV/HV, frozen so the shared
 * default object can never be mutated through a consumer. Golden-pinned in
 * role-vocabulary.finance.test.ts (every existing config: key absent,
 * byte-identical).
 */
export const DEFAULT_FINANCE_ROLE_LABELS: Readonly<{ kv: string; hv: string }> = Object.freeze({
  kv: 'KV',
  hv: 'HV',
})

/**
 * The tenant's finance-role display labels. `config.financeRoles` override ??
 * the frozen KV/HV defaults — `??` deliberately catches only an ABSENT
 * override: a present object replaces the whole label pair verbatim (no
 * per-key merge; the zod schema requires BOTH labels when the key exists).
 * Tolerates a null/undefined ctx so partially-mocked load events (e.g. the
 * untouched finanzordnung page test carries no locals.tenant) resolve to the
 * default without throwing.
 */
export function financeRoleLabelsForTenant(
  ctx: VocabularyTenant | null | undefined,
): Readonly<{ kv: string; hv: string }> {
  return ctx?.config?.financeRoles ?? DEFAULT_FINANCE_ROLE_LABELS
}
